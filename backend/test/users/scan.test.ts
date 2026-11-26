/**
 * Tests for `src/users/scan.ts` — a 1:1 port of `servermanage/user_scan.py`.
 *
 * The parser/validator/builder tests are differential: the same input text is
 * fed to both the TypeScript port and the Python oracle, and the results are
 * compared with {@link diffValues}. An empty diff list means the two stacks are
 * observationally identical. The `collectHostUsers` tests drive a fake
 * `UserScanRunner` to exercise the orchestration (sudo probe, per-account
 * budgeting, known-usage skipping) without touching a real host.
 */
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { golden } from '../golden/golden';

import type { HostConfig } from '../../src/config/config';
import type { CommandResult } from '../../src/collect/types';
import { diffValues, findRepoRoot, normalizeValue, type Diff } from '../diff/harness';
import {
  _optionalField,
  _parseScanOutput,
  _safeUsagePath,
  _scanMetadata,
  buildScanCommand,
  buildUsageCommand,
  collectHostUsers,
  parseGroup,
  parsePasswd,
  parseUsage,
  validateUsername,
  type UserScanRunner,
} from '../../src/users/scan';

const repoRoot = findRepoRoot();

interface OracleCase {
  id: string;
  op: string;
  text?: string;
  path?: unknown;
  paths?: string[];
  fields?: string[];
  index?: number;
}

type OracleResult = { ok: true; value: unknown } | { ok: false; error: string };

const GOLDEN_FILE = path.join(repoRoot, 'backend', 'test', 'users', 'golden', 'scan.json');
function runOracle(cases: OracleCase[]): Record<string, OracleResult> {
  return golden<Record<string, OracleResult>>(GOLDEN_FILE, JSON.stringify(cases));
}

/** Compare a JS value against an oracle value; returns the (normally empty) diff list. */
function diffOf(node: unknown, pythonValue: unknown): Diff[] {
  const out: Diff[] = [];
  diffValues(normalizeValue(node), normalizeValue(pythonValue), '$', out);
  return out;
}

type Captured = { ok: true; value: unknown } | { ok: false; error: string };

function capture(fn: () => unknown): Captured {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PASSWD_TEXT = [
  '# comment line, ignored',
  '',
  'root:x:0:0:root:/root:/bin/bash',
  'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
  'alice:x:1001:1001:Alice A:/home/alice:/bin/bash',
  'bob:x:1002:1002:Bob:/home/bob:/bin/zsh',
  'malformed line without enough fields',
  'carol:x:1003:notanumber:Carol:/home/carol:/bin/bash',
  'dave:x:1004:1004:Dave:/home/dave:/usr/sbin/nologin',
  'eve:x:1005:1005:Eve:/home/eve:/bin/false',
  '张三:x:1006:1006:张三:/home/张三:/bin/bash',
  ':x:1007:1007:empty name:/home/x:/bin/bash',
  'frank:x:1008:1008:Frank:/home/frank:/bin/bash:extra:field',
  'grace:x:1009:1009:Grace:/home/grace:/bin/bash',
].join('\n');

/** Two accounts deliberately share uid 1010. */
const PASSWD_DUP_UID = [
  'alice:x:1010:1010:Alice:/home/alice:/bin/bash',
  'bob:x:1010:1010:Bob:/home/bob:/bin/bash',
].join('\n');

/** CRLF line endings, plus a lone CR. */
const PASSWD_CRLF = 'alice:x:1001:1001:Alice:/home/alice:/bin/bash\r\ndaemon:x:1:1:d:/:/sbin/nologin\r';

const GROUP_TEXT = [
  '# groups',
  'root:x:0:',
  'sudo:x:27:alice,bob',
  'docker:x:999:alice',
  'alice:x:1001: , bob ,,',
  'empty:x:1002:',
  'dup:x:1003:a',
  'dup:x:1004:b',
  'conflictA:x:2000:',
  'conflictB:x:2000:',
  'malformed',
  'badgid:x:notnum:alice',
].join('\n');

const USAGE_TEXT = [
  '4096\t/home/alice',
  '1048576\t/data/alice',
  '1.5M\t/home/bob',
  '-5\t/home/neg',
  '/home/notab',
  '2048\t/home/with space',
  '0\t/data/zero',
  'abc\t/home/x',
  '4096\t',
  "du: cannot read directory '/home/secret': Permission denied",
  '8192\t/data/alice',
].join('\n');

const SCAN_OUTPUT_VALID = [
  'P\t1',
  'U\talice\t1001\t1001\t/home/alice\t/bin/bash\tAlice A',
  'U\tbob\t1002\t1002\t/home/bob\t/bin/zsh\tBob',
  'U\tdaemon\t1\t1\t/usr/sbin\t/usr/sbin/nologin\tdaemon',
  'G\talice\t1001\t',
  'G\tbob\t1002\t',
  'G\tsudo\t27\talice',
  'G\tdocker\t999\talice,bob',
  'H\talice\t1\troot\troot\t755',
  'H\tbob\t1\t-\t-\t-',
  'D\talice\t1\troot\troot\t700',
  'D\tbob\t0\t-\t-\t-',
].join('\n');

const SCAN_OUTPUT_NO_MARKER = ['U\talice\t1001\t1001\t/home/alice\t/bin/bash\t', 'G\talice\t1001\t'].join('\n');

const SCAN_OUTPUT_NO_USER_LINE = ['P\t1', 'G\talice\t1001\t'].join('\n');

const SCAN_OUTPUT_UNPARSEABLE = ['P\t1', 'U\tbroken-row'].join('\n');

const SCAN_OUTPUT_NO_GROUPS = ['P\t1', 'U\talice\t1001\t1001\t/home/alice\t/bin/bash\t'].join('\n');

/** `U` record only has five fields (gecos/home/shell missing) → unparseable. */
const SCAN_OUTPUT_U_SHORT = ['P\t1', 'G\talice\t1001\t', 'U\talice\t1001\t1001\t/home/alice'].join('\n');

const NOW = '2024-05-01T00:00:00Z';

/** A minimal `HostConfig`; `collectHostUsers` only reads `.name`. */
function makeHost(name = 'host-a'): HostConfig {
  return { name } as unknown as HostConfig;
}

interface RunnerHarness {
  runner: UserScanRunner;
  runCalls: string[];
  sudoCalls: string[];
}

function makeRunner(options: {
  scan: CommandResult;
  sudo?: (command: string) => CommandResult;
}): RunnerHarness {
  const runCalls: string[] = [];
  const sudoCalls: string[] = [];
  const runner: UserScanRunner = {
    run(command) {
      runCalls.push(command);
      return options.scan;
    },
    runSudo(command) {
      sudoCalls.push(command);
      if (!options.sudo) {
        throw new Error(`unexpected runSudo: ${command}`);
      }
      return options.sudo(command);
    },
  };
  return { runner, runCalls, sudoCalls };
}

function ok(stdout: string): CommandResult {
  return { stdout, stderr: '', exitStatus: 0 };
}

// ---------------------------------------------------------------------------
// validateUsername
// ---------------------------------------------------------------------------

describe('validateUsername', () => {
  const names = [
    'alice',
    'a',
    'A_1.b-c',
    'a'.repeat(64),
    'a'.repeat(65),
    '',
    ' spaced',
    'bad name',
    '张三',
    '-lead',
    '.dotted',
    'root',
    'admin',
    '../../../etc',
    'a/b',
    'a\n',
  ];

  const oracleIt = it;

  oracleIt('matches Python validate_username for valid and invalid names', () => {
    const result = runOracle(
      names.map((text, index) => ({ id: `n${index}`, op: 'validate_username', text })),
    );
    for (let index = 0; index < names.length; index += 1) {
      const expected = result[`n${index}`];
      expect(expected.ok).toBe(true);
      expect(diffOf(validateUsername(names[index]), expected.ok ? expected.value : null)).toEqual([]);
    }
  });

  it('accepts the 64-character boundary and rejects 65 characters', () => {
    expect(validateUsername('a'.repeat(64))).toBe(true);
    expect(validateUsername('a'.repeat(65))).toBe(false);
  });

  it('has no reserved-name filter: root/admin are structurally valid', () => {
    expect(validateUsername('root')).toBe(true);
    expect(validateUsername('admin')).toBe(true);
  });

  it('rejects illegal characters, spaces, slashes and non-ASCII names', () => {
    expect(validateUsername('bad name')).toBe(false);
    expect(validateUsername('a/b')).toBe(false);
    expect(validateUsername('张三')).toBe(false);
    expect(validateUsername('a\n')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(validateUsername(null)).toBe(false);
    expect(validateUsername(123)).toBe(false);
    expect(validateUsername(true)).toBe(false);
    expect(validateUsername([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parsePasswd
// ---------------------------------------------------------------------------

describe('parsePasswd', () => {
  const oracleIt = it;

  oracleIt('matches Python parse_passwd (system accounts, nologin, malformed, non-ASCII)', () => {
    const result = runOracle([
      { id: 'a', op: 'parse_passwd', text: PASSWD_TEXT },
      { id: 'b', op: 'parse_passwd', text: PASSWD_DUP_UID },
      { id: 'c', op: 'parse_passwd', text: PASSWD_CRLF },
    ]);
    for (const id of ['a', 'b', 'c'] as const) {
      const expected = result[id];
      expect(expected.ok).toBe(true);
    }
    expect(diffOf(parsePasswd(PASSWD_TEXT), result.a.ok ? result.a.value : null)).toEqual([]);
    expect(diffOf(parsePasswd(PASSWD_DUP_UID), result.b.ok ? result.b.value : null)).toEqual([]);
    expect(diffOf(parsePasswd(PASSWD_CRLF), result.c.ok ? result.c.value : null)).toEqual([]);
  });

  it('keeps ordinary login accounts and drops system / nologin / false-shell rows', () => {
    const users = parsePasswd(PASSWD_TEXT);
    expect(users.map((user) => user.username)).toEqual(['alice', 'bob', '张三', 'grace']);
  });

  it('keeps both records when two accounts share a uid', () => {
    const users = parsePasswd(PASSWD_DUP_UID);
    expect(users).toHaveLength(2);
    expect(users.every((user) => user.uid === 1010)).toBe(true);
  });

  it('keeps non-ASCII usernames verbatim and skips malformed lines silently', () => {
    const users = parsePasswd(PASSWD_TEXT);
    const zhang = users.find((user) => user.username === '张三');
    expect(zhang).toBeDefined();
    expect(zhang?.home).toBe('/home/张三');
    // "malformed line without enough fields" and the 8-field line are dropped.
    expect(users.find((user) => user.username === 'frank')).toBeUndefined();
  });

  it('tolerates CRLF line endings', () => {
    const users = parsePasswd(PASSWD_CRLF);
    expect(users).toHaveLength(1);
    expect(users[0].username).toBe('alice');
    expect(users[0].shell).toBe('/bin/bash');
  });

  it('returns an empty array for empty input', () => {
    expect(parsePasswd('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseGroup
// ---------------------------------------------------------------------------

describe('parseGroup', () => {
  const oracleIt = it;

  oracleIt('matches Python parse_group (members, gid conflict, duplicate names)', () => {
    const result = runOracle([{ id: 'g', op: 'parse_group', text: GROUP_TEXT }]);
    const expected = result.g;
    expect(expected.ok).toBe(true);
    const [groups, gidMap] = parseGroup(GROUP_TEXT);
    const shaped = { groups, gidMap: Object.fromEntries(gidMap) };
    expect(diffOf(shaped, expected.ok ? expected.value : null)).toEqual([]);
  });

  it('splits, trims and drops empty members', () => {
    const [groups] = parseGroup(GROUP_TEXT);
    expect(groups.sudo).toEqual(['alice', 'bob']);
    expect(groups.alice).toEqual(['bob']);
    expect(groups.empty).toEqual([]);
  });

  it('keeps the first name for a duplicated gid (dict.setdefault semantics)', () => {
    const [, gidMap] = parseGroup(GROUP_TEXT);
    expect(gidMap.get(2000)).toBe('conflictA');
  });

  it('lets a repeated group name overwrite its member list', () => {
    const [groups, gidMap] = parseGroup(GROUP_TEXT);
    expect(groups.dup).toEqual(['b']);
    // Both `dup` rows had different gids; the first gid still maps to "dup".
    expect(gidMap.get(1003)).toBe('dup');
  });
});

// ---------------------------------------------------------------------------
// parseUsage
// ---------------------------------------------------------------------------

describe('parseUsage', () => {
  const oracleIt = it;

  oracleIt('matches Python parse_usage (units, negatives, non-numeric, permission denied)', () => {
    const result = runOracle([{ id: 'u', op: 'parse_usage', text: USAGE_TEXT }]);
    expect(result.u.ok).toBe(true);
    expect(diffOf(parseUsage(USAGE_TEXT), result.u.ok ? result.u.value : null)).toEqual([]);
  });

  it('parses byte sizes and keeps paths with spaces intact', () => {
    const usage = parseUsage(USAGE_TEXT);
    expect(usage['/home/alice']).toBe(4096);
    expect(usage['/data/alice']).toBe(8192); // last write wins
    expect(usage['/home/with space']).toBe(2048);
    expect(usage['/data/zero']).toBe(0);
  });

  it('ignores non-integer sizes, negatives, tabless and empty-path lines', () => {
    const usage = parseUsage(USAGE_TEXT);
    expect(usage['/home/bob']).toBeUndefined();
    expect(usage['/home/neg']).toBeUndefined();
    expect(usage['/home/notab']).toBeUndefined();
    expect(usage['/home/x']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildScanCommand / buildUsageCommand
// ---------------------------------------------------------------------------

describe('buildScanCommand', () => {
  const oracleIt = it;

  oracleIt('is byte-for-byte identical to Python build_scan_command()', () => {
    const result = runOracle([{ id: 's', op: 'build_scan_command' }]);
    expect(result.s.ok).toBe(true);
    expect(buildScanCommand()).toBe(result.s.ok ? result.s.value : null);
  });

  it('returns a fixed, parameterless script', () => {
    expect(buildScanCommand()).toBe(buildScanCommand());
    expect(buildScanCommand()).toContain('export LC_ALL=C');
  });
});

describe('buildUsageCommand', () => {
  const oracleIt = it;

  oracleIt('matches Python build_usage_command() including quoting and rejects unsafe paths', () => {
    const result = runOracle([
      { id: 'p', op: 'build_usage_command', paths: ['/home/alice', '/data/bob'] },
      { id: 'q', op: 'build_usage_command', paths: ['/home/with space'] },
      { id: 'r', op: 'build_usage_command', paths: ["/home/o'brien"] },
      { id: 'x', op: 'build_usage_command', paths: ['/etc/passwd'] },
    ]);
    expect(diffOf(capture(() => buildUsageCommand(['/home/alice', '/data/bob'])), result.p)).toEqual([]);
    expect(diffOf(capture(() => buildUsageCommand(['/home/with space'])), result.q)).toEqual([]);
    expect(diffOf(capture(() => buildUsageCommand(["/home/o'brien"])), result.r)).toEqual([]);
    expect(diffOf(capture(() => buildUsageCommand(['/etc/passwd'])), result.x)).toEqual([]);
  });

  it('quotes unsafe paths and wraps the du call in the ionice/nice guard', () => {
    const command = buildUsageCommand(['/home/alice']);
    expect(command).toContain('ionice -c3 nice -n 19 du -sx --block-size=1');
    expect(command).toContain('else nice -n 19 du -sx --block-size=1');
    expect(buildUsageCommand(['/home/with space'])).toContain("'/home/with space'");
    expect(() => buildUsageCommand(['../etc'])).toThrow('不允许统计该路径的占用');
  });
});

// ---------------------------------------------------------------------------
// _safeUsagePath
// ---------------------------------------------------------------------------

describe('_safeUsagePath', () => {
  const paths: unknown[] = [
    '/home/alice',
    '/data/alice',
    '/home/alice/',
    '/home//alice',
    '/home/./alice',
    '/home/alice/../alice2',
    '/etc/passwd',
    '/dat',
    '/data',
    '/home/a\nb',
    '/home/../etc',
    '/',
    null,
    123,
  ];

  const oracleIt = it;

  oracleIt('matches Python _safe_usage_path for allowed and rejected inputs', () => {
    const result = runOracle(
      paths.map((value, index) => ({ id: `s${index}`, op: 'safe_usage_path', path: value })),
    );
    for (let index = 0; index < paths.length; index += 1) {
      expect(diffOf(capture(() => _safeUsagePath(paths[index])), result[`s${index}`])).toEqual([]);
    }
  });

  it('returns the path with trailing slashes stripped', () => {
    expect(_safeUsagePath('/home/alice/')).toBe('/home/alice');
  });

  it('rejects traversal, non-canonical and control-character paths with verbatim messages', () => {
    expect(() => _safeUsagePath('/home/../etc')).toThrow('路径不允许包含上级目录');
    expect(() => _safeUsagePath('/home//alice')).toThrow('路径不是规范形式');
    expect(() => _safeUsagePath('/home/a\nb')).toThrow('路径包含非法控制字符');
    expect(() => _safeUsagePath('/etc/passwd')).toThrow('不允许统计该路径的占用');
  });
});

// ---------------------------------------------------------------------------
// _optionalField / _scanMetadata
// ---------------------------------------------------------------------------

describe('_optionalField / _scanMetadata', () => {
  const oracleIt = it;

  oracleIt('matches Python for out-of-range, "-" and blank fields', () => {
    const result = runOracle([
      { id: 'a', op: 'optional_field', fields: ['H', 'alice', '1', 'root', '-', '  '], index: 3 },
      { id: 'b', op: 'optional_field', fields: ['H', 'alice', '1', 'root', '-', '  '], index: 4 },
      { id: 'c', op: 'optional_field', fields: ['H', 'alice', '1', 'root', '-', '  '], index: 5 },
      { id: 'd', op: 'optional_field', fields: ['H', 'alice'], index: 5 },
      { id: 'm1', op: 'scan_metadata', fields: ['H', 'alice', '1', 'root', '-', '  '] },
      { id: 'm2', op: 'scan_metadata', fields: ['D', 'alice', '0'] },
    ]);
    expect(diffOf(_optionalField(['H', 'alice', '1', 'root', '-', '  '], 3), result.a.ok ? result.a.value : null)).toEqual([]);
    expect(diffOf(_optionalField(['H', 'alice', '1', 'root', '-', '  '], 4), result.b.ok ? result.b.value : null)).toEqual([]);
    expect(diffOf(_optionalField(['H', 'alice', '1', 'root', '-', '  '], 5), result.c.ok ? result.c.value : null)).toEqual([]);
    expect(diffOf(_optionalField(['H', 'alice'], 5), result.d.ok ? result.d.value : null)).toEqual([]);
    expect(diffOf(_scanMetadata(['H', 'alice', '1', 'root', '-', '  ']), result.m1.ok ? result.m1.value : null)).toEqual([]);
    expect(diffOf(_scanMetadata(['D', 'alice', '0']), result.m2.ok ? result.m2.value : null)).toEqual([]);
  });

  it('normalises blank and "-" to null', () => {
    expect(_optionalField(['a', ' ', '-'], 1)).toBeNull();
    expect(_optionalField(['a', ' ', '-'], 2)).toBeNull();
    expect(_optionalField(['a', 'b'], 3)).toBeNull();
    expect(_scanMetadata(['H', 'alice', '0', '-', '', ' '])).toEqual({
      exists: false,
      owner: null,
      group: null,
      mode: null,
    });
  });
});

// ---------------------------------------------------------------------------
// _parseScanOutput
// ---------------------------------------------------------------------------

describe('_parseScanOutput', () => {
  const oracleIt = it;

  const texts: Record<string, string> = {
    valid: SCAN_OUTPUT_VALID,
    noMarker: SCAN_OUTPUT_NO_MARKER,
    noUserLine: SCAN_OUTPUT_NO_USER_LINE,
    unparseable: SCAN_OUTPUT_UNPARSEABLE,
    noGroups: SCAN_OUTPUT_NO_GROUPS,
    shortUser: SCAN_OUTPUT_U_SHORT,
  };

  function shape(text: string): unknown {
    const parsed = _parseScanOutput(text);
    return {
      users: parsed.users,
      groupMembers: parsed.groupMembers,
      gidNames: Object.fromEntries(parsed.gidNames),
      homes: parsed.homes,
      dataDirs: parsed.dataDirs,
      dataSupported: parsed.dataSupported,
    };
  }

  oracleIt('matches Python _parse_scan_output for valid output and every error branch', () => {
    const cases = Object.entries(texts).map(([id, text]) => ({ id, op: 'parse_scan_output', text }));
    const result = runOracle(cases);
    for (const [id, text] of Object.entries(texts)) {
      expect(diffOf(capture(() => shape(text)), result[id])).toEqual([]);
    }
  });

  it('parses a full snapshot: accounts, group membership, homes, data dirs, marker', () => {
    const parsed = _parseScanOutput(SCAN_OUTPUT_VALID);
    expect(parsed.users.map((user) => user.username)).toEqual(['alice', 'bob']);
    expect(parsed.groupMembers.docker).toEqual(['alice', 'bob']);
    expect(parsed.gidNames.get(27)).toBe('sudo');
    expect(parsed.homes.alice).toEqual({ exists: true, owner: 'root', group: 'root', mode: '755' });
    expect(parsed.dataDirs.bob.exists).toBe(false);
    expect(parsed.dataSupported).toBe(true);
  });

  it('raises the verbatim Chinese error for each truncation branch', () => {
    expect(() => _parseScanOutput(SCAN_OUTPUT_NO_MARKER)).toThrow('用户扫描输出缺少结束标记，已保留上次结果');
    expect(() => _parseScanOutput(SCAN_OUTPUT_NO_USER_LINE)).toThrow('用户扫描输出缺少账号数据，已保留上次结果');
    expect(() => _parseScanOutput(SCAN_OUTPUT_UNPARSEABLE)).toThrow('用户扫描输出无法解析，已保留上次结果');
    expect(() => _parseScanOutput(SCAN_OUTPUT_NO_GROUPS)).toThrow('用户扫描输出缺少组信息，已保留上次结果');
  });

  it('marks a U record with missing fields as unparseable', () => {
    expect(() => _parseScanOutput(SCAN_OUTPUT_U_SHORT)).toThrow('用户扫描输出无法解析，已保留上次结果');
  });
});

// ---------------------------------------------------------------------------
// collectHostUsers
// ---------------------------------------------------------------------------

const COLLECT_SCAN = [
  'P\t1',
  'U\talice\t1001\t1001\t/home/alice\t/bin/bash\tAlice',
  'U\tbob\t1002\t1002\t/home/bob\t/bin/zsh\tBob',
  'G\talice\t1001\t',
  'G\tbob\t1002\t',
  'G\tsudo\t27\talice',
  'G\tdocker\t999\talice,bob',
  'H\talice\t1\troot\troot\t755',
  'H\tbob\t1\troot\troot\t700',
  'D\talice\t1\troot\troot\t700',
  'D\tbob\t0\t-\t-\t-',
].join('\n');

describe('collectHostUsers', () => {
  it('builds accounts with groups, docker/sudo flags and metadata (no usage)', async () => {
    const { runner, runCalls, sudoCalls } = makeRunner({ scan: ok(COLLECT_SCAN) });
    const result = await collectHostUsers(makeHost('host-a'), runner, {
      now: NOW,
      usageDue: false,
    });

    expect(runCalls).toEqual([buildScanCommand()]);
    expect(sudoCalls).toEqual([]);
    expect(result.usageReadable).toBe(true);
    expect(result.usageRefreshed).toBe(false);
    expect(result.accounts.map((account) => account.username)).toEqual(['alice', 'bob']);

    const alice = result.accounts[0];
    expect(alice.hostName).toBe('host-a');
    expect(alice.groups).toEqual(['alice', 'docker', 'sudo']);
    expect(alice.primaryGroup).toBe('alice');
    expect(alice.inDocker).toBe(true);
    expect(alice.inSudo).toBe(true);
    expect(alice.homeExists).toBe(true);
    expect(alice.homeOwner).toBe('root');
    expect(alice.homeSizeBytes).toBeNull();
    expect(alice.dataExists).toBe(true);
    expect(alice.dataSupported).toBe(true);
    expect(alice.usageCollectedAt).toBeNull();
    expect(alice.collectedAt).toBe(NOW);

    const bob = result.accounts[1];
    expect(bob.groups).toEqual(['bob', 'docker']);
    expect(bob.inDocker).toBe(true);
    expect(bob.inSudo).toBe(false);
    expect(bob.dataExists).toBe(false);
    expect(bob.dataSizeBytes).toBeNull();
  });

  it('measures per-account usage through sudo and reports a refreshed round', async () => {
    const { runner, sudoCalls } = makeRunner({
      scan: ok(COLLECT_SCAN),
      sudo: (command) => {
        if (command.includes('/home/alice')) {
          return ok('2048\t/home/alice\n4096\t/data/alice\n');
        }
        if (command.includes('/home/bob')) {
          return ok('512\t/home/bob\n');
        }
        return ok('');
      },
    });
    const result = await collectHostUsers(makeHost(), runner, {
      now: NOW,
      usageDue: true,
      sudoAvailable: true,
    });

    expect(sudoCalls).toHaveLength(2);
    expect(result.usageReadable).toBe(true);
    expect(result.usageRefreshed).toBe(true);
    const alice = result.accounts[0];
    expect(alice.homeSizeBytes).toBe(2048);
    expect(alice.dataSizeBytes).toBe(4096);
    expect(alice.usageCollectedAt).toBe(NOW);
    expect(result.accounts[1].homeSizeBytes).toBe(512);
  });

  it('reports usageReadable=false when the sudo probe fails and never runs du', async () => {
    const { runner, sudoCalls } = makeRunner({
      scan: ok(COLLECT_SCAN),
      sudo: (command) => {
        if (command === 'true') {
          return { stdout: '', stderr: 'no tty', exitStatus: 1 };
        }
        throw new Error(`du should not run: ${command}`);
      },
    });
    const result = await collectHostUsers(makeHost(), runner, {
      now: NOW,
      usageDue: true,
      sudoAvailable: false,
    });

    expect(sudoCalls).toEqual(['true']);
    expect(result.usageReadable).toBe(false);
    expect(result.usageRefreshed).toBe(false);
    expect(result.accounts.every((account) => account.homeSizeBytes === null)).toBe(true);
  });

  it('leaves usageRefreshed=false when du only returns a subset of the planned paths', async () => {
    const { runner } = makeRunner({
      scan: ok(COLLECT_SCAN),
      sudo: (command) => {
        if (command.includes('/home/alice')) {
          // /data/alice is missing → the alice plan is only partially measured.
          return ok('2048\t/home/alice\n');
        }
        return ok(command.includes('/home/bob') ? '512\t/home/bob\n' : '');
      },
    });
    const result = await collectHostUsers(makeHost(), runner, {
      now: NOW,
      usageDue: true,
      sudoAvailable: true,
    });

    expect(result.usageRefreshed).toBe(false);
    expect(result.accounts[0].homeSizeBytes).toBe(2048);
    expect(result.accounts[0].dataSizeBytes).toBeNull();
  });

  it('skips paths already recorded in knownUsage and falls back to those sizes', async () => {
    const scan = [
      'P\t1',
      'U\talice\t1001\t1001\t/home/alice\t/bin/bash\tAlice',
      'G\talice\t1001\t',
      'H\talice\t1\troot\troot\t755',
      'D\talice\t1\troot\troot\t700',
    ].join('\n');
    const { runner, sudoCalls } = makeRunner({
      scan: ok(scan),
      sudo: () => ok('4096\t/data/alice\n'),
    });
    const result = await collectHostUsers(makeHost(), runner, {
      now: NOW,
      usageDue: true,
      sudoAvailable: true,
      knownUsage: { alice: { home: 5000, data: null, at: '2024-04-30T00:00:00Z' } },
    });

    // Only the data path is left to measure; the home path is skipped.
    expect(sudoCalls).toHaveLength(1);
    expect(sudoCalls[0]).toContain('/data/alice');
    expect(sudoCalls[0]).not.toContain('/home/alice');
    expect(result.accounts[0].homeSizeBytes).toBe(5000);
    expect(result.accounts[0].dataSizeBytes).toBe(4096);
    expect(result.usageRefreshed).toBe(true);
  });

  it('propagates a non-zero scan exit status with the verbatim message', async () => {
    const { runner } = makeRunner({
      scan: { stdout: '', stderr: 'boom', exitStatus: 2 },
    });
    await expect(
      collectHostUsers(makeHost(), runner, { now: NOW, usageDue: false }),
    ).rejects.toThrow('用户扫描命令执行失败（退出码 2）');
  });

  it('marks usageReadable=false when a du call throws but still returns accounts', async () => {
    const { runner } = makeRunner({
      scan: ok(COLLECT_SCAN),
      sudo: () => {
        throw new Error('sudo authentication failed');
      },
    });
    const result = await collectHostUsers(makeHost(), runner, {
      now: NOW,
      usageDue: true,
      sudoAvailable: true,
    });

    expect(result.usageReadable).toBe(false);
    expect(result.usageRefreshed).toBe(false);
    expect(result.accounts).toHaveLength(2);
  });
});
