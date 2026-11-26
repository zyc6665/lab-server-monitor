/**
 * Read-only server user scanning — 1:1 TypeScript port of
 * `servermanage/user_scan.py` (lines 100-582).
 *
 * The remote side runs one fixed, whitelisted bash script that reads
 * `/etc/passwd` and `/etc/group` directly (never `getent`, which would resolve
 * LDAP/AD accounts) plus `stat` for the home and `/data/<user>` directory
 * metadata. Optional disk usage comes from a single `du` call through sudo,
 * with every path quoted and restricted to `/home/` or `/data/`.
 *
 * No user input ever reaches a shell command: the scan script is a constant,
 * and usage paths are derived from validated usernames and remote passwd data.
 *
 * Naming: each Python function is camelCased (`validate_username` ->
 * `validateUsername`, `collect_host_users` -> `collectHostUsers`, …); the
 * leading-underscore helpers (`_safe_usage_path`, `_optional_field`,
 * `_scan_metadata`, `_parse_scan_output`) keep their underscore prefix.
 * Python's `X | None` becomes `X | null`; multi-value returns become typed
 * result objects/tuples whose field names mirror the Python tuple order.
 */

import type { HostConfig } from '../config/config';
import type { CommandResult, HostUserAccount } from '../collect/types';

/** `servermanage/user_scan.py:27` — `USERNAME_RE`. */
const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** `servermanage/user_scan.py:29` — allowed `du` roots. */
const USAGE_PREFIXES = ['/home/', '/data/'] as const;

/** `servermanage/user_scan.py:30`. */
const DOCKER_GROUP = 'docker';

/** `servermanage/user_scan.py:31`. */
const SUDO_GROUPS = new Set(['sudo', 'wheel']);

/**
 * Fixed bash script (`servermanage/user_scan.py:46-97`). It takes no parameters
 * and interpolates nothing from the caller: every value printed comes from the
 * remote `/etc/passwd`, `/etc/group` or `stat`. Output records are TAB
 * separated:
 *
 *   P  <data exists 0|1>
 *   U  <name> <uid> <gid> <home> <shell> <gecos>   (every passwd line)
 *   G  <name> <gid> <comma separated members>      (every group line)
 *   H  <name> <exists 0|1> <owner> <group> <mode>
 *   D  <name> <exists 0|1> <owner> <group> <mode>  (only when /data exists)
 *
 * The literal below is generated from Python's `build_scan_command()` via
 * `json.dumps`, so it is byte-for-byte identical (literal `\t`/`\n` sequences,
 * real newlines) to the oracle.
 */
const SCAN_COMMAND: string = "export LC_ALL=C\nif test -d /data; then printf 'P\\t1\\n'; else printf 'P\\t0\\n'; fi\nawk -F: '{ printf \"U\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n\", $1, $3, $4, $6, $7, $5 }' /etc/passwd 2>/dev/null || true\nawk -F: '{ printf \"G\\t%s\\t%s\\t%s\\n\", $1, $3, $4 }' /etc/group 2>/dev/null || true\nawk -F: '$3 >= 1000 && $7 !~ /(nologin|false)$/ { printf \"%s\\t%s\\n\", $1, $6 }' /etc/passwd 2>/dev/null | while IFS='\t' read -r name home; do\n  if test -d \"$home\"; then\n    meta=$(stat -c '%U:%G:%a' -- \"$home\" 2>/dev/null || true)\n  else\n    meta=\"\"\n  fi\n  owner=-\n  group=-\n  mode=-\n  if test -n \"$meta\"; then\n    IFS=: read -r owner group mode <<EOF\n$meta\nEOF\n    owner=${owner:--}\n    group=${group:--}\n    mode=${mode:--}\n  fi\n  if test -d \"$home\"; then\n    printf 'H\\t%s\\t1\\t%s\\t%s\\t%s\\n' \"$name\" \"$owner\" \"$group\" \"$mode\"\n  else\n    printf 'H\\t%s\\t0\\t-\\t-\\t-\\n' \"$name\"\n  fi\n  if test -d /data; then\n    data_path=\"/data/$name\"\n    if test -d \"$data_path\"; then\n      meta=$(stat -c '%U:%G:%a' -- \"$data_path\" 2>/dev/null || true)\n    else\n      meta=\"\"\n    fi\n    owner=-\n    group=-\n    mode=-\n    if test -n \"$meta\"; then\n      IFS=: read -r owner group mode <<EOF\n$meta\nEOF\n      owner=${owner:--}\n      group=${group:--}\n      mode=${mode:--}\n    fi\n    if test -d \"$data_path\"; then\n      printf 'D\\t%s\\t1\\t%s\\t%s\\t%s\\n' \"$name\" \"$owner\" \"$group\" \"$mode\"\n    else\n      printf 'D\\t%s\\t0\\t-\\t-\\t-\\n' \"$name\"\n    fi\n  fi\ndone\n";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * `servermanage/user_scan.py:100-107` — `UserScanRunner` protocol.
 *
 * The Python protocol is synchronous; here the methods may return a promise so
 * a production `SshClient` adapter can be plugged in. `timeout` is passed
 * through to the runner unchanged — the caller supplies it in whatever unit
 * its runner expects (the Python oracle passes seconds).
 */
export interface UserScanRunner {
  run(command: string, timeout: number): Promise<CommandResult> | CommandResult;
  runSudo(command: string, timeout: number): Promise<CommandResult> | CommandResult;
}

/** One parsed `/etc/passwd` row (`servermanage/user_scan.py:144-153`). */
export interface PasswdEntry {
  username: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
  gecos: string;
}

/** Owner/group/mode metadata for a home or `/data/<user>` directory. */
export interface ScanMetadata {
  exists: boolean;
  owner: string | null;
  group: string | null;
  mode: string | null;
}

/** Result of `_parse_scan_output` (Python tuple, same field order). */
export interface ParsedScanOutput {
  users: PasswdEntry[];
  groupMembers: Record<string, string[]>;
  gidNames: Map<number, string>;
  homes: Record<string, ScanMetadata>;
  dataDirs: Record<string, ScanMetadata>;
  dataSupported: boolean;
}

/** A previously measured usage snapshot (`known_usage` value). */
export interface KnownUsage {
  home?: number | null;
  data?: number | null;
  at?: string | null;
}

/** Progress callback: `(name, index, total, upcoming)`. */
export type UsageProgress = (
  name: string,
  index: number,
  total: number,
  upcoming: string,
) => void;

/** Options for {@link collectHostUsers} (mirrors Python keyword arguments). */
export interface CollectHostUsersOptions {
  /** Current instant, ISO-8601 (Python `now: datetime`). */
  now: string;
  /** Python `usage_due`. */
  usageDue: boolean;
  /** Python `command_timeout` (default 120). */
  commandTimeout?: number;
  /** Python `usage_timeout` (default `None`). */
  usageTimeout?: number | null;
  /** Python `sudo_available` (default `True`). */
  sudoAvailable?: boolean;
  /** Python `known_usage` (default `None`). */
  knownUsage?: Record<string, KnownUsage> | null;
  /** Python `usage_progress` (default `None`). */
  usageProgress?: UsageProgress | null;
}

/** Result of {@link collectHostUsers} (Python tuple order). */
export interface CollectHostUsersResult {
  accounts: HostUserAccount[];
  usageReadable: boolean;
  usageRefreshed: boolean;
}

// ---------------------------------------------------------------------------
// Python-compatible primitives
// ---------------------------------------------------------------------------

/**
 * Python 3 `str.splitlines()` line boundaries. Unlike JS `String.split(/\n/)`
 * this also breaks on lone `\r`, `\v`, `\f`, `\x1c-\x1e`, `\x85`, `\u2028`,
 * `\u2029`, and never yields a trailing empty string for a final boundary.
 */
function pythonSplitlines(text: string): string[] {
  if (text === '') {
    return [];
  }
  const boundary = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;
  const result: string[] = [];
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text)) !== null) {
    result.push(text.slice(start, match.index));
    start = match.index + match[0].length;
  }
  if (start < text.length) {
    result.push(text.slice(start));
  }
  return result;
}

/**
 * Python `int(text)` (base 10) or `null` on `ValueError`.
 *
 * Accepts surrounding whitespace, an optional `+`/`-`, ASCII digits and single
 * underscores between digits (`"1_0" -> 10`), but rejects `""`, hex, floats and
 * anything else — matching the oracle's `try: int(...) except ValueError`.
 */
export function pythonInt(text: string): number | null {
  const stripped = text.trim();
  if (stripped === '') {
    return null;
  }
  if (!/^[+-]?[0-9](?:_?[0-9])*$/.test(stripped)) {
    return null;
  }
  const sign = stripped[0] === '-' ? -1 : 1;
  const digits = stripped.replace(/^[+-]/, '').replace(/_/g, '');
  const value = Number(digits);
  if (!Number.isFinite(value)) {
    return null;
  }
  return sign * value;
}

/**
 * Python `posixpath.normpath` for the absolute paths seen here. Collapses
 * repeated slashes, resolves `.`/`..`, drops a trailing slash, and preserves a
 * leading `//` (POSIX special case). Returns `"."` for an empty result.
 */
export function posixNormpath(path: string): string {
  if (path === '') {
    return '.';
  }
  let initialSlashes = path.startsWith('/') ? 1 : 0;
  if (path.startsWith('//') && !path.startsWith('///')) {
    initialSlashes = 2;
  }
  const comps = path.split('/');
  const out: string[] = [];
  for (const comp of comps) {
    if (comp === '' || comp === '.') {
      continue;
    }
    if (comp === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop();
      } else if (initialSlashes === 0) {
        out.push('..');
      }
      continue;
    }
    out.push(comp);
  }
  const joined = out.join('/');
  const prefix = '/'.repeat(initialSlashes);
  const result = prefix + joined;
  return result === '' ? '.' : result;
}

/** Python `shlex.quote` (`servermanage/user_scan.py:208`). */
export function shlexQuote(value: string): string {
  if (value === '') {
    return "''";
  }
  if (!/[^\w@%+=:,./-]/.test(value)) {
    return value;
  }
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/** Python `repr()` for the values used in `_safe_usage_path` error messages. */
function pyRepr(value: unknown): string {
  if (typeof value === 'string') {
    // Python picks `'` or `"` quoting based on the content; the paths here only
    // ever contain `'`, so single quotes (escaped) always reproduce `repr()`.
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    return `'${escaped}'`;
  }
  if (value === null || value === undefined) {
    return 'None';
  }
  if (value === true) {
    return 'True';
  }
  if (value === false) {
    return 'False';
  }
  return String(value);
}

/** Monotonic clock in seconds (Python `time.monotonic()`). */
function monotonicSeconds(): number {
  return Number(process.hrtime.bigint()) / 1e9;
}

/** `list(dict.fromkeys(items))` — dedupe preserving first-seen order. */
function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

// ---------------------------------------------------------------------------
// Parsers & validators
// ---------------------------------------------------------------------------

/** `servermanage/user_scan.py:110-114` — `validate_username`. */
export function validateUsername(name: unknown): boolean {
  if (typeof name !== 'string') {
    return false;
  }
  // `exec` + full-length check reproduces `re.fullmatch` exactly (JS `$` would
  // otherwise accept a trailing `\n`).
  const match = USERNAME_RE.exec(name);
  return match !== null && match[0] === name;
}

/** `servermanage/user_scan.py:117-154` — `parse_passwd`. */
export function parsePasswd(text: string): PasswdEntry[] {
  const users: PasswdEntry[] = [];
  for (const raw of pythonSplitlines(text)) {
    const line = raw.replace(/\r+$/, '');
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const fields = line.split(':');
    if (fields.length !== 7) {
      continue;
    }
    const [name, , uidText, gidText, gecos, home, shell] = fields;
    if (name === '') {
      continue;
    }
    const uid = pythonInt(uidText);
    const gid = pythonInt(gidText);
    if (uid === null || gid === null) {
      continue;
    }
    if (uid < 1000) {
      continue;
    }
    if (shell.endsWith('/nologin') || shell.endsWith('/false')) {
      continue;
    }
    users.push({ username: name, uid, gid, home, shell, gecos });
  }
  return users;
}

/**
 * `servermanage/user_scan.py:157-178` — `parse_group`.
 *
 * Returns `[name -> members, gid -> name]`; the gid map keeps the *first* name
 * seen for a gid (`dict.setdefault`), while a repeated group name overwrites
 * its member list (`groups[name] = members`).
 */
export function parseGroup(text: string): [Record<string, string[]>, Map<number, string>] {
  const groups: Record<string, string[]> = {};
  const gidMap = new Map<number, string>();
  for (const raw of pythonSplitlines(text)) {
    const line = raw.replace(/\r+$/, '');
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const fields = line.split(':');
    if (fields.length !== 4) {
      continue;
    }
    const [name, , gidText, membersText] = fields;
    if (name === '') {
      continue;
    }
    const gid = pythonInt(gidText);
    if (gid === null) {
      continue;
    }
    const members = membersText
      .split(',')
      .map((member) => member.trim())
      .filter((member) => member !== '');
    groups[name] = members;
    if (!gidMap.has(gid)) {
      gidMap.set(gid, name);
    }
  }
  return [groups, gidMap];
}

/** `servermanage/user_scan.py:181-183` — `build_scan_command`. */
export function buildScanCommand(): string {
  return SCAN_COMMAND;
}

/** `servermanage/user_scan.py:186-201` — `_safe_usage_path`. */
export function _safeUsagePath(path: unknown): string {
  const usable =
    typeof path === 'string' &&
    USAGE_PREFIXES.some((prefix) => (path as string).startsWith(prefix));
  if (!usable) {
    throw new Error(`不允许统计该路径的占用: ${pyRepr(path)}`);
  }
  const value = path as string;
  if (value.includes('\n') || value.includes('\r') || value.includes('\x00')) {
    throw new Error(`路径包含非法控制字符: ${pyRepr(value)}`);
  }
  if (value.split('/').includes('..')) {
    throw new Error(`路径不允许包含上级目录: ${pyRepr(value)}`);
  }
  if (posixNormpath(value) !== value.replace(/\/+$/, '')) {
    throw new Error(`路径不是规范形式: ${pyRepr(value)}`);
  }
  return value.replace(/\/+$/, '');
}

/** `servermanage/user_scan.py:204-217` — `build_usage_command`. */
export function buildUsageCommand(paths: string[]): string {
  const targets = paths
    .map((path) => shlexQuote(_safeUsagePath(path)))
    .join(' ');
  // `du` only reads metadata, but on a busy login node it should still yield to
  // interactive work: idle I/O class plus the lowest CPU priority. `ionice` is
  // util-linux-specific, so fall back to plain nice when it is missing.
  return (
    'if command -v ionice >/dev/null 2>&1; then ' +
    `ionice -c3 nice -n 19 du -sx --block-size=1 -- ${targets}; ` +
    `else nice -n 19 du -sx --block-size=1 -- ${targets}; fi`
  );
}

/** `servermanage/user_scan.py:220-237` — `parse_usage`. */
export function parseUsage(text: string): Record<string, number> {
  const usage: Record<string, number> = {};
  for (const raw of pythonSplitlines(text)) {
    const line = raw.replace(/\r+$/, '');
    if (line === '' || !line.includes('\t')) {
      continue;
    }
    const tabIndex = line.indexOf('\t');
    const sizeText = line.slice(0, tabIndex);
    const path = line.slice(tabIndex + 1);
    if (path === '') {
      continue;
    }
    const size = pythonInt(sizeText);
    if (size === null) {
      continue;
    }
    if (size < 0) {
      continue;
    }
    usage[path] = size;
  }
  return usage;
}

/** `servermanage/user_scan.py:240-246` — `_optional_field`. */
export function _optionalField(fields: string[], index: number): string | null {
  if (fields.length <= index) {
    return null;
  }
  const value = fields[index].trim();
  if (value === '' || value === '-') {
    return null;
  }
  return value;
}

/** `servermanage/user_scan.py:249-256` — `_scan_metadata`. */
export function _scanMetadata(fields: string[]): ScanMetadata {
  return {
    exists: fields[2] === '1',
    owner: _optionalField(fields, 3),
    group: _optionalField(fields, 4),
    mode: _optionalField(fields, 5),
  };
}

/** `servermanage/user_scan.py:259-370` — `_parse_scan_output`. */
export function _parseScanOutput(text: string): ParsedScanOutput {
  const users: PasswdEntry[] = [];
  const seen = new Set<string>();
  const groupMembers: Record<string, string[]> = {};
  const gidNames = new Map<number, string>();
  const homes: Record<string, ScanMetadata> = {};
  const dataDirs: Record<string, ScanMetadata> = {};
  let dataSupported = false;
  let sawMarker = false;
  let sawUserLine = false;
  let sawUnparseable = false;

  for (const raw of pythonSplitlines(text)) {
    const line = raw.replace(/\r+$/, '');
    if (line === '') {
      continue;
    }
    const fields = line.split('\t');
    const kind = fields[0];

    if (kind === 'U') {
      sawUserLine = true;
      if (fields.length < 6) {
        sawUnparseable = true;
        continue;
      }
      const name = fields[1];
      const uidText = fields[2];
      const gidText = fields[3];
      const home = fields[4];
      const shell = fields[5];
      const gecos = fields.length > 6 ? fields.slice(6).join('\t') : '';
      if (!validateUsername(name) || seen.has(name)) {
        sawUnparseable = true;
        continue;
      }
      const uid = pythonInt(uidText);
      const gid = pythonInt(gidText);
      if (uid === null || gid === null) {
        sawUnparseable = true;
        continue;
      }
      if (uid < 1000) {
        continue;
      }
      if (shell.endsWith('/nologin') || shell.endsWith('/false')) {
        continue;
      }
      seen.add(name);
      users.push({ username: name, uid, gid, home, shell, gecos });
    } else if (kind === 'G') {
      if (fields.length < 3) {
        sawUnparseable = true;
        continue;
      }
      const name = fields[1];
      const membersText = fields.length > 3 ? fields[3] : '';
      if (!validateUsername(name)) {
        sawUnparseable = true;
        continue;
      }
      const gid = pythonInt(fields[2]);
      if (gid === null) {
        sawUnparseable = true;
        continue;
      }
      const members = membersText
        .split(',')
        .map((member) => member.trim())
        .filter((member) => member !== '');
      groupMembers[name] = members;
      if (!gidNames.has(gid)) {
        gidNames.set(gid, name);
      }
    } else if (kind === 'H' || kind === 'D') {
      if (fields.length < 3 || (fields[2] !== '0' && fields[2] !== '1')) {
        continue;
      }
      const name = fields[1];
      if (!validateUsername(name)) {
        continue;
      }
      const target = kind === 'H' ? homes : dataDirs;
      target[name] = _scanMetadata(fields);
    } else if (kind === 'P') {
      if (fields.length >= 2 && (fields[1] === '0' || fields[1] === '1')) {
        dataSupported = fields[1] === '1';
        sawMarker = true;
      }
    }
  }

  // A truncated/garbled response (empty output, only a marker, no group
  // records) must not be mistaken for "the host now has zero users": that would
  // wipe the snapshot and raise a false `user-present` for every baseline
  // account. The caller stores `last_error` and keeps the old data.
  if (!sawMarker) {
    throw new Error('用户扫描输出缺少结束标记，已保留上次结果');
  }
  if (!sawUserLine) {
    throw new Error('用户扫描输出缺少账号数据，已保留上次结果');
  }
  if (users.length === 0 && sawUnparseable) {
    throw new Error('用户扫描输出无法解析，已保留上次结果');
  }
  if (users.length > 0 && gidNames.size === 0) {
    throw new Error('用户扫描输出缺少组信息，已保留上次结果');
  }

  return { users, groupMembers, gidNames, homes, dataDirs, dataSupported };
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * `servermanage/user_scan.py:373-582` — `collect_host_users`.
 *
 * Returns `{ accounts, usageReadable, usageRefreshed }`. `du` runs only when
 * `usageDue` is true, `sudoAvailable` is set and at least one candidate
 * directory exists; sudo failures are reported through `usageReadable` instead
 * of raising. Hosts without a sudo password skip `du` entirely: an
 * unprivileged `du` would either walk other people's homes for minutes or hit
 * `sudo -n` and time out.
 *
 * `knownUsage` maps a username to sizes measured on an earlier round; those
 * paths are left out of `du` so a host whose first run was cut off by the
 * timeout keeps making progress instead of re-walking the same huge
 * directories every round.
 */
export async function collectHostUsers(
  host: HostConfig,
  runner: UserScanRunner,
  options: CollectHostUsersOptions,
): Promise<CollectHostUsersResult> {
  const now = options.now;
  const usageDue = options.usageDue;
  const commandTimeout = options.commandTimeout ?? 120;
  const usageTimeout = options.usageTimeout ?? null;
  let sudoAvailable = options.sudoAvailable ?? true;
  const knownUsage = options.knownUsage ?? {};
  const usageProgress = options.usageProgress ?? null;

  const result = await runner.run(buildScanCommand(), commandTimeout);
  if (result.exitStatus !== 0) {
    throw new Error(`用户扫描命令执行失败（退出码 ${result.exitStatus}）`);
  }

  const { users, groupMembers, gidNames, homes, dataDirs, dataSupported } =
    _parseScanOutput(result.stdout);

  const supplemental: Record<string, string[]> = {};
  for (const [groupName, members] of Object.entries(groupMembers)) {
    for (const member of members) {
      if (!supplemental[member]) {
        supplemental[member] = [];
      }
      supplemental[member].push(groupName);
    }
  }

  let usageReadable = true;
  let usageRefreshed = false;
  const usageSizes: Record<string, number> = {};

  if (usageDue) {
    if (!sudoAvailable) {
      // Without a stored password we can still succeed when the host has
      // NOPASSWD sudo. Probe that cheaply first: `sudo -n true` fails in a
      // second on a password-protected host, while the real `du` would block
      // for the whole (long) timeout before giving up.
      try {
        const probe = await runner.runSudo(
          'true',
          Math.min(15, usageTimeout || commandTimeout),
        );
        sudoAvailable = probe.exitStatus === 0;
      } catch {
        sudoAvailable = false;
      }
      if (!sudoAvailable) {
        usageReadable = false;
      }
    }
  }

  if (usageDue && sudoAvailable) {
    // Measure one account at a time so the page can show which user is being
    // walked right now, and so an account that takes minutes never hides the
    // progress of the ones behind it. The whole round shares one budget: when
    // it is gone the remaining accounts simply wait for the next round (partial
    // results are stored).
    const plan: Array<[string, string[]]> = [];
    for (const user of users) {
      const name = user.username;
      const home = user.home;
      const homeMeta = homes[name] ?? ({} as ScanMetadata);
      const dataMeta = dataDirs[name] ?? ({} as ScanMetadata);
      const known = knownUsage[name] ?? {};
      const paths: string[] = [];
      if (homeMeta.exists && home.startsWith('/home/')) {
        if (known.home === undefined || known.home === null) {
          paths.push(home);
        }
      }
      if (dataSupported && dataMeta.exists) {
        if (known.data === undefined || known.data === null) {
          paths.push(`/data/${name}`);
        }
      }
      if (paths.length > 0) {
        plan.push([name, dedupe(paths)]);
      }
    }

    if (plan.length > 0) {
      const budget = Math.max(60, Math.trunc(usageTimeout || commandTimeout));
      const deadline = monotonicSeconds() + budget;
      const total = plan.length;
      const measured = new Set<string>();
      for (let index = 0; index < plan.length; index += 1) {
        const [name, paths] = plan[index];
        const remaining = deadline - monotonicSeconds();
        if (remaining <= 5) {
          break;
        }
        if (usageProgress !== null) {
          const upcoming = index + 1 < total ? plan[index + 1][0] : '';
          try {
            usageProgress(name, index, total, upcoming);
          } catch {
            // progress is best effort
          }
        }
        let usageCommand: string;
        try {
          usageCommand = buildUsageCommand(paths);
        } catch {
          usageReadable = false;
          continue;
        }
        // `sudo` execs a single program: wrap the compound script for bash, and
        // cap this account with `timeout`. `du` prints a path as soon as that
        // path is done, so a cut-off account still contributes the directories
        // it finished. Ceiling the remaining time avoids the first round losing
        // a second to `int()` on a fractional clock.
        const span = Math.max(10, Math.ceil(remaining));
        const inner = `timeout -k 10 ${span} bash -c ${shlexQuote(usageCommand)}`;
        const wrapped = 'bash -lc ' + shlexQuote(inner);
        let usageResult: CommandResult;
        try {
          usageResult = await runner.runSudo(wrapped, span + 15);
        } catch {
          // SudoAuthError / SudoUnavailable (and any other failure) mark usage
          // unreadable and stop the round; usage must never abort the scan.
          usageReadable = false;
          break;
        }
        const parsed = parseUsage(usageResult.stdout);
        const parsedKeys = Object.keys(parsed);
        if (parsedKeys.length > 0) {
          for (const key of parsedKeys) {
            usageSizes[key] = parsed[key];
            measured.add(key);
          }
        } else if (usageResult.exitStatus !== 0) {
          // A timed-out or failed account must not mark the host as unreadable:
          // the next round retries just this account.
          continue;
        }
      }

      const planPaths = new Set<string>();
      for (const [, paths] of plan) {
        for (const path of paths) {
          planPaths.add(path);
        }
      }
      usageRefreshed = [...planPaths].every((path) => measured.has(path));
    }
  }

  const accounts: HostUserAccount[] = [];
  for (const user of users) {
    const name = user.username;
    const gid = user.gid;
    const primaryGroup = gidNames.get(gid) ?? null;
    const groups: string[] = [];
    if (primaryGroup) {
      groups.push(primaryGroup);
    }
    const extraGroups = supplemental[name] ?? [];
    for (const groupName of [...extraGroups].sort()) {
      if (!groups.includes(groupName)) {
        groups.push(groupName);
      }
    }

    const homeMeta = homes[name] ?? ({} as ScanMetadata);
    const home = user.home;
    const homeExists = Boolean(homeMeta.exists);
    const dataMeta = dataDirs[name] ?? ({} as ScanMetadata);
    const dataExists = Boolean(dataSupported && dataMeta.exists);

    const known = knownUsage[name] ?? {};
    let homeSize: number | null = null;
    if (homeExists && home.startsWith('/home/')) {
      homeSize = usageSizes[home] !== undefined ? usageSizes[home] : (known.home ?? null);
    }
    let dataSize: number | null = null;
    if (dataExists) {
      const dataPath = `/data/${name}`;
      dataSize = usageSizes[dataPath] !== undefined ? usageSizes[dataPath] : (known.data ?? null);
    }
    const measuredNow =
      usageSizes[home] !== undefined || usageSizes[`/data/${name}`] !== undefined;
    const usageAt = measuredNow ? now : (known.at ?? null);

    accounts.push({
      hostName: host.name,
      username: name,
      uid: user.uid,
      gid,
      primaryGroup,
      gecos: user.gecos,
      home,
      shell: user.shell,
      groups,
      inDocker: groups.includes(DOCKER_GROUP),
      inSudo: groups.some((group) => SUDO_GROUPS.has(group)),
      homeExists,
      homeOwner: homeMeta.owner ?? null,
      homeGroup: homeMeta.group ?? null,
      homeMode: homeMeta.mode ?? null,
      homeSizeBytes: homeSize,
      dataExists,
      dataOwner: dataExists ? (dataMeta.owner ?? null) : null,
      dataGroup: dataExists ? (dataMeta.group ?? null) : null,
      dataMode: dataExists ? (dataMeta.mode ?? null) : null,
      dataSizeBytes: dataSize,
      dataSupported,
      usageReadable,
      usageStale: false,
      usageCollectedAt: usageAt,
      collectedAt: now,
      state: 'present',
    });
  }

  return { accounts, usageReadable, usageRefreshed };
}
