import { describe, it, expect } from 'vitest';

import {
  ACCOUNT_RE,
  AdminPlanError,
  COMMAND_TIMEOUT_SECONDS,
  MAX_CACHED_PLANS,
  OPERATIONS,
  OPERATION_LABELS,
  PASSWORD_ALPHABET,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PLAN_TTL_SECONDS,
  RESERVED_ACCOUNTS,
  buildPlan,
  digest,
  executePlan,
  generatePassword,
  generatepassword,
  hashPlan,
  maskCommand,
  publicPlan,
  rollbackHint,
  validateAccountName,
  validatePassword,
  validatepassword,
  PlanCache,
} from '../../src/users/admin';
import type { AdminPlan, CommandResult, PlanRunner, PlanStep } from '../../src/users/admin';

const FIXED_NOW = new Date('2026-01-02T03:04:05.678Z');
const PASSWORD = 'Str0ng-Passw0rd';
const RESET = 'password';

function stepById(plan: AdminPlan, id: string): PlanStep {
  const found = plan.steps.find((item) => item.id === id);
  if (!found) {
    throw new Error(`missing step ${id}`);
  }
  return found;
}

class FakeRunner implements PlanRunner {
  readonly calls: Array<{ method: 'run' | 'run_sudo'; command: string; stdin: string | null }> = [];

  constructor(private readonly handler?: (command: string) => CommandResult) {}

  run(command: string, _timeout: number): CommandResult {
    this.calls.push({ method: 'run', command, stdin: null });
    return this.handler ? this.handler(command) : { exit_status: 0, stdout: '', stderr: '' };
  }

  run_sudo(command: string, _timeout: number, opts?: { stdin_data?: string | null }): CommandResult {
    this.calls.push({ method: 'run_sudo', command, stdin: opts?.stdin_data ?? null });
    return this.handler ? this.handler(command) : { exit_status: 0, stdout: '', stderr: '' };
  }
}

describe('constants', () => {
  it('exposes the four fixed operations and their labels', () => {
    expect(OPERATIONS).toEqual(['create', RESET, 'docker', 'data']);
    expect(OPERATION_LABELS.create).toBe('创建账号');
    expect(OPERATION_LABELS[RESET]).toBe('重置密码');
    expect(OPERATION_LABELS.docker).toBe('加入 docker 组');
    expect(OPERATION_LABELS.data).toBe('创建 /data 目录');
  });

  it('pins the numeric limits and account regex', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(64);
    expect(PLAN_TTL_SECONDS).toBe(600);
    expect(COMMAND_TIMEOUT_SECONDS).toBe(120);
    expect(MAX_CACHED_PLANS).toBe(32);
    expect(ACCOUNT_RE.test('a_b-1')).toBe(true);
    expect(RESERVED_ACCOUNTS.has('root')).toBe(true);
    expect(RESERVED_ACCOUNTS.has('docker')).toBe(true);
  });

  it('builds the 62-char ascii_letters + digits alphabet in Python order', () => {
    expect(PASSWORD_ALPHABET).toHaveLength(62);
    expect(PASSWORD_ALPHABET).toMatch(/^[A-Za-z0-9]{62}$/);
    expect(PASSWORD_ALPHABET.slice(0, 26)).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(PASSWORD_ALPHABET.slice(26, 52)).toBe(
      Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)).join(''),
    );
    expect(PASSWORD_ALPHABET.slice(52)).toBe('0123456789');
  });
});

describe('validateAccountName', () => {
  it('trims and returns a valid lowercase account name', () => {
    expect(validateAccountName('  alice ')).toBe('alice');
    expect(validateAccountName('_svc-01')).toBe('_svc-01');
  });

  it('accepts the 32-character boundary and rejects 33 characters', () => {
    expect(validateAccountName('a'.repeat(32))).toBe('a'.repeat(32));
    expect(() => validateAccountName('a'.repeat(33))).toThrow(
      '账号名只能包含小写字母、数字、下划线或短横线，且不能以数字或短横线开头',
    );
  });

  it('rejects non-strings, blanks and uppercase with the verbatim messages', () => {
    expect(() => validateAccountName(123)).toThrow('账号名必须是字符串');
    expect(() => validateAccountName('   ')).toThrow('请填写账号名');
    expect(() => validateAccountName('Alice')).toThrow('账号名只能使用小写字母');
  });

  it('rejects illegal characters and reserved system accounts', () => {
    const illegal = '账号名只能包含小写字母、数字、下划线或短横线，且不能以数字或短横线开头';
    expect(() => validateAccountName('1abc')).toThrow(illegal);
    expect(() => validateAccountName('bad name')).toThrow(illegal);
    expect(() => validateAccountName('user@host')).toThrow(illegal);
    expect(() => validateAccountName('root')).toThrow('这是系统账号名，不能创建');
    expect(() => validateAccountName('docker')).toThrow('这是系统账号名，不能创建');
  });
});

describe('validatePassword', () => {
  it('returns a valid password unchanged', () => {
    expect(validatePassword(PASSWORD)).toBe(PASSWORD);
  });

  it('enforces the minimum and maximum length', () => {
    expect(() => validatePassword('short')).toThrow('密码至少需要 12 位');
    expect(() => validatePassword('a'.repeat(65))).toThrow('密码不能超过 64 位');
  });

  it('rejects colons, newlines, spaces and non-ASCII characters', () => {
    expect(() => validatePassword('Valid:Passw0rd')).toThrow('密码不能包含冒号或换行');
    expect(() => validatePassword('Valid Passw0rd')).toThrow('密码不能包含空格');
    expect(() => validatePassword('ValidPassw0rd\u0001')).toThrow('密码只能使用可见的 ASCII 字符');
    expect(() => validatePassword('VälidPassw0rd')).toThrow('密码只能使用可见的 ASCII 字符');
  });

  it('rejects non-string values', () => {
    expect(() => validatePassword(123)).toThrow('密码必须是字符串');
  });

  it('is also exported under its lowercase spec alias', () => {
    expect(validatepassword).toBe(validatePassword);
  });
});

describe('generatePassword', () => {
  it('defaults to 16 alphanumeric characters', () => {
    const value = generatePassword();
    expect(value).toHaveLength(16);
    expect(value).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('clamps to the 12..64 bounds', () => {
    expect(generatePassword(5)).toHaveLength(12);
    expect(generatePassword(100)).toHaveLength(64);
    expect(generatePassword(24)).toHaveLength(24);
  });

  it('is exported under its lowercase spec alias', () => {
    expect(generatepassword).toBe(generatePassword);
  });
});

describe('buildPlan - create', () => {
  function createPlan(overrides: Partial<Parameters<typeof buildPlan>[0]> = {}): AdminPlan {
    return buildPlan({
      operation: 'create',
      host_name: ' lab-host ',
      account: 'alice',
      [RESET]: PASSWORD,
      now: FIXED_NOW,
      ...overrides,
    });
  }

  it('emits useradd/chpasswd/docker/data plus verify steps with exact commands', () => {
    const plan = createPlan();
    expect(plan.operation).toBe('create');
    expect(plan.operation_label).toBe('创建账号');
    expect(plan.host).toBe('lab-host');
    expect(plan.account).toBe('alice');
    expect(plan.blocked).toBe(false);
    expect(plan.steps.map((item) => item.id)).toEqual([
      'useradd',
      'chpasswd',
      'docker',
      'data',
      'verify-id',
      'verify-data',
    ]);

    expect(stepById(plan, 'useradd').command).toBe('useradd -m -d /home/alice -s /bin/bash -- alice');
    expect(stepById(plan, 'useradd').elevated).toBe(true);
    expect(stepById(plan, 'chpasswd').command).toBe('chpasswd');
    expect(stepById(plan, 'chpasswd').stdin).toBe('alice:' + PASSWORD);
    expect(stepById(plan, 'chpasswd').stdin_label).toBe('通过标准输入设置密码（不会出现在命令或日志里）');
    expect(stepById(plan, 'docker').command).toBe('gpasswd -a alice docker');
    expect(stepById(plan, 'data').command).toBe(
      'mkdir -p -- /data/alice && chown alice:alice -- /data/alice && chmod 755 -- /data/alice',
    );
    expect(stepById(plan, 'verify-id').command).toBe('id -- alice');
    expect(stepById(plan, 'verify-id').elevated).toBe(false);
    expect(stepById(plan, 'verify-data').command).toBe("stat -c '%U %G %a %n' -- /data/alice");
    expect(stepById(plan, 'verify-data').elevated).toBe(false);
  });

  it('generates an alphanumeric password when none is supplied', () => {
    const plan = buildPlan({ operation: 'create', host_name: 'h', account: 'alice', now: FIXED_NOW });
    const stdin = stepById(plan, 'chpasswd').stdin as string;
    expect(stdin.startsWith('alice:')).toBe(true);
    expect(stdin.slice('alice:'.length)).toMatch(/^[A-Za-z0-9]{16}$/);
  });

  it('blocks (but still verifies) when the account already exists', () => {
    const plan = createPlan({ account_exists: true });
    expect(plan.blocked).toBe(true);
    expect(plan.blocked_reasons).toEqual([
      '账号 alice 已经存在，不能重复创建；可以改用“重置密码”或“加入 docker 组”。',
    ]);
    expect(plan.steps.map((item) => item.id)).toEqual(['verify-id', 'verify-data']);
  });

  it('skips docker and /data with warnings when unavailable', () => {
    const noDocker = createPlan({ docker_group: false });
    expect(noDocker.steps.map((item) => item.id)).not.toContain('docker');
    expect(noDocker.warnings).toContain('这台主机没有 docker 组，跳过加入 docker 组。');

    const noData = createPlan({ data_supported: false });
    expect(noData.steps.map((item) => item.id)).not.toContain('data');
    expect(noData.steps.map((item) => item.id)).not.toContain('verify-data');
    expect(noData.warnings).toContain('这台主机没有 /data 目录，跳过创建个人目录。');
  });

  it('records the sudo-missing block', () => {
    const plan = buildPlan({
      operation: 'create',
      host_name: 'h',
      account: 'alice',
      sudo_configured: false,
      now: FIXED_NOW,
    });
    expect(plan.blocked).toBe(true);
    expect(plan.blocked_reasons).toContain(
      '这台主机还没有配置 sudo 密码，无法执行需要 root 的操作。请先在主机设置里填写 sudo 密码。',
    );
  });
});

describe('buildPlan - reset', () => {
  it('emits chpasswd + verify-id with the reset titles', () => {
    const plan = buildPlan({
      operation: RESET,
      host_name: 'h',
      account: 'bob',
      [RESET]: PASSWORD,
      account_exists: true,
      now: FIXED_NOW,
    });
    expect(plan.operation_label).toBe('重置密码');
    expect(plan.steps.map((item) => item.id)).toEqual(['chpasswd', 'verify-id']);
    expect(stepById(plan, 'chpasswd').title).toBe('重置密码');
    expect(stepById(plan, 'chpasswd').stdin).toBe('bob:' + PASSWORD);
    expect(stepById(plan, 'verify-id').title).toBe('验证账号');
  });

  it('blocks when the account does not exist', () => {
    const plan = buildPlan({
      operation: RESET,
      host_name: 'h',
      account: 'bob',
      account_exists: false,
      now: FIXED_NOW,
    });
    expect(plan.blocked).toBe(true);
    expect(plan.blocked_reasons).toContain('账号 bob 不存在，无法重置密码。');
    expect(plan.steps.map((item) => item.id)).toEqual(['chpasswd', 'verify-id']);
  });
});

describe('buildPlan - docker', () => {
  it('emits gpasswd + membership verify with the login warning', () => {
    const plan = buildPlan({
      operation: 'docker',
      host_name: 'h',
      account: 'bob',
      account_exists: true,
      docker_group: true,
      now: FIXED_NOW,
    });
    expect(plan.steps.map((item) => item.id)).toEqual(['docker', 'verify-groups']);
    expect(stepById(plan, 'docker').command).toBe('gpasswd -a bob docker');
    expect(stepById(plan, 'verify-groups').command).toBe('id -nG -- bob');
    expect(plan.warnings).toContain('组成员关系在用户下次登录时生效，已经登录的会话需要重新登录。');
  });

  it('blocks when the account or docker group is missing', () => {
    const plan = buildPlan({
      operation: 'docker',
      host_name: 'h',
      account: 'bob',
      account_exists: false,
      docker_group: false,
      now: FIXED_NOW,
    });
    expect(plan.blocked_reasons).toContain('账号 bob 不存在，请先创建账号。');
    expect(plan.blocked_reasons).toContain('这台主机没有 docker 组，无法加入。');
  });
});

describe('buildPlan - data', () => {
  it('emits mkdir/chown/chmod + stat verify', () => {
    const plan = buildPlan({
      operation: 'data',
      host_name: 'h',
      account: 'bob',
      account_exists: true,
      now: FIXED_NOW,
    });
    expect(plan.steps.map((item) => item.id)).toEqual(['data', 'verify-data']);
    expect(stepById(plan, 'data').command).toBe(
      'mkdir -p -- /data/bob && chown bob:bob -- /data/bob && chmod 755 -- /data/bob',
    );
    expect(stepById(plan, 'verify-data').command).toBe("stat -c '%U %G %a %n' -- /data/bob");
  });

  it('blocks when the account or /data is missing', () => {
    const plan = buildPlan({
      operation: 'data',
      host_name: 'h',
      account: 'bob',
      account_exists: false,
      data_supported: false,
      now: FIXED_NOW,
    });
    expect(plan.blocked_reasons).toContain('账号 bob 不存在，请先创建账号。');
    expect(plan.blocked_reasons).toContain('这台主机没有 /data 目录，无法创建个人目录。');
  });
});

describe('buildPlan - validation', () => {
  it('rejects unknown operations with the verbatim message', () => {
    expect(() =>
      buildPlan({ operation: 'reboot', host_name: 'h', account: 'alice', now: FIXED_NOW }),
    ).toThrow('未知操作：reboot');
    expect(() =>
      buildPlan({ operation: 'reboot', host_name: 'h', account: 'alice', now: FIXED_NOW }),
    ).toThrow(AdminPlanError);
  });

  it('rejects a missing host name', () => {
    expect(() => buildPlan({ operation: 'create', host_name: '   ', account: 'alice' })).toThrow(
      '缺少主机名',
    );
  });
});

describe('plan structure', () => {
  it('uses the Python snake_case field names', () => {
    const plan = buildPlan({
      operation: 'create',
      host_name: 'h',
      account: 'alice',
      [RESET]: PASSWORD,
      now: FIXED_NOW,
    });
    expect(Object.keys(plan).sort()).toEqual(
      [
        'account',
        'blocked',
        'blocked_reasons',
        'created_at',
        'expires_at',
        'host',
        'nonce',
        'operation',
        'operation_label',
        'plan_hash',
        'rollback_hint',
        'steps',
        'warnings',
      ].sort(),
    );
    expect(Object.keys(plan.steps[0]).sort()).toEqual(
      ['command', 'elevated', 'id', 'skipped_reason', 'stdin', 'stdin_label', 'title'].sort(),
    );
  });

  it('renders created_at/expires_at 600s apart in Python isoformat', () => {
    const plan = buildPlan({
      operation: 'create',
      host_name: 'h',
      account: 'alice',
      [RESET]: PASSWORD,
      now: FIXED_NOW,
    });
    expect(plan.created_at).toBe('2026-01-02T03:04:05.678000+00:00');
    expect(plan.expires_at).toBe('2026-01-02T03:14:05.678000+00:00');
    expect(new Date(plan.expires_at).getTime() - new Date(plan.created_at).getTime()).toBe(600000);
  });

  it('produces a 16-char hex nonce and a 64-char hex plan_hash', () => {
    const plan = buildPlan({
      operation: 'create',
      host_name: 'h',
      account: 'alice',
      [RESET]: PASSWORD,
      now: FIXED_NOW,
    });
    expect(plan.nonce).toMatch(/^[0-9a-f]{16}$/);
    expect(plan.plan_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hashPlan / digest', () => {
  const steps: PlanStep[] = [
    { id: 'chpasswd', title: 't', command: 'chpasswd', elevated: true, stdin: 'alice:secret', stdin_label: null, skipped_reason: null },
    { id: 'verify-id', title: 'v', command: 'id -- alice', elevated: false, stdin: null, stdin_label: null, skipped_reason: null },
  ];

  it('is deterministic for identical inputs', () => {
    const a = hashPlan('create', 'h', 'alice', steps, 'deadbeefdeadbeef', FIXED_NOW);
    const b = hashPlan('create', 'h', 'alice', steps, 'deadbeefdeadbeef', FIXED_NOW);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the nonce, timestamp or stdin changes', () => {
    const base = hashPlan('create', 'h', 'alice', steps, 'deadbeefdeadbeef', FIXED_NOW);
    expect(hashPlan('create', 'h', 'alice', steps, '0000000000000000', FIXED_NOW)).not.toBe(base);
    expect(hashPlan('create', 'h', 'alice', steps, 'deadbeefdeadbeef', new Date('2026-01-02T03:04:06.000Z'))).not.toBe(base);
    const otherStdin = [{ ...steps[0], stdin: 'alice:other' }, steps[1]];
    expect(hashPlan('create', 'h', 'alice', otherStdin, 'deadbeefdeadbeef', FIXED_NOW)).not.toBe(base);
  });

  it('digest hashes the UTF-8 bytes with sha256', () => {
    expect(digest('alice:secret')).toMatch(/^[0-9a-f]{64}$/);
    expect(digest('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  });
});

describe('publicPlan', () => {
  it('strips the secret stdin and exposes has_stdin/stdin_label', () => {
    const plan = buildPlan({
      operation: 'create',
      host_name: 'h',
      account: 'alice',
      [RESET]: PASSWORD,
      now: FIXED_NOW,
    });
    const pub = publicPlan(plan);
    const chpasswd = pub.steps.find((item) => item.id === 'chpasswd')!;
    expect(chpasswd.has_stdin).toBe(true);
    expect(chpasswd.stdin_label).toBe('通过标准输入设置密码（不会出现在命令或日志里）');
    expect('stdin' in chpasswd).toBe(false);
    expect(pub.steps.find((item) => item.id === 'useradd')!.has_stdin).toBe(false);
    expect(JSON.stringify(pub)).not.toContain(PASSWORD);
    // The original plan is untouched.
    expect(stepById(plan, 'chpasswd').stdin).toBe('alice:' + PASSWORD);
  });
});

describe('maskCommand', () => {
  it('returns commands unchanged and never adds a password', () => {
    expect(maskCommand('id -- alice')).toBe('id -- alice');
    expect(maskCommand('gpasswd -a alice docker')).toBe('gpasswd -a alice docker');
    expect(maskCommand('id -- alice')).not.toContain(PASSWORD);
  });
});

describe('rollbackHint', () => {
  it('gives the exact create / data / reset hints', () => {
    expect(rollbackHint('create', 'alice')).toBe(
      '如果中途失败，可能只创建了账号或目录。回滚需要你手工确认：`sudo userdel -r alice`（会删除家目录）以及 `sudo rm -rf /data/alice`。本工具不会自动删除任何数据。',
    );
    expect(rollbackHint('data', 'alice')).toBe(
      '如果目录是本次新建的，可以手工执行 `sudo rmdir /data/alice`（仅在目录为空时有效）。',
    );
    expect(rollbackHint(RESET, 'alice')).toBe(
      '本操作只修改密码或组成员关系，可用原密码或 `sudo gpasswd -d alice docker` 撤销。',
    );
    expect(rollbackHint('docker', 'alice')).toBe(
      '本操作只修改密码或组成员关系，可用原密码或 `sudo gpasswd -d alice docker` 撤销。',
    );
  });
});

describe('PlanCache', () => {
  function makePlan(account = 'alice'): AdminPlan {
    return buildPlan({
      operation: 'create',
      host_name: 'h',
      account,
      [RESET]: PASSWORD,
      now: FIXED_NOW,
    });
  }

  it('stores and returns a cached plan by hash', () => {
    const cache = new PlanCache();
    const plan = makePlan();
    cache.put(plan, { now: FIXED_NOW });
    expect(cache.get(plan.plan_hash, { now: FIXED_NOW })).toBe(plan);
    expect(cache.get('unknown')).toBeNull();
  });

  it('expires entries after the TTL', () => {
    const cache = new PlanCache({ ttl_seconds: 10 });
    const plan = makePlan();
    cache.put(plan, { now: FIXED_NOW });
    expect(cache.get(plan.plan_hash, { now: new Date(FIXED_NOW.getTime() + 9000) })).toBe(plan);
    expect(cache.get(plan.plan_hash, { now: new Date(FIXED_NOW.getTime() + 10001) })).toBeNull();
  });

  it('drops entries on demand', () => {
    const cache = new PlanCache();
    const plan = makePlan();
    cache.put(plan, { now: FIXED_NOW });
    cache.drop(plan.plan_hash);
    expect(cache.get(plan.plan_hash, { now: FIXED_NOW })).toBeNull();
  });

  it('evicts the oldest entry beyond max_entries', () => {
    const cache = new PlanCache({ max_entries: 2 });
    const first = makePlan('u1');
    const second = makePlan('u2');
    const third = makePlan('u3');
    cache.put(first, { now: FIXED_NOW });
    cache.put(second, { now: FIXED_NOW });
    cache.put(third, { now: FIXED_NOW });
    expect(cache.get(first.plan_hash, { now: FIXED_NOW })).toBeNull();
    expect(cache.get(second.plan_hash, { now: FIXED_NOW })).toBe(second);
    expect(cache.get(third.plan_hash, { now: FIXED_NOW })).toBe(third);
  });
});

describe('executePlan', () => {
  function freshPlan(): AdminPlan {
    return buildPlan({
      operation: 'create',
      host_name: 'h',
      account: 'alice',
      [RESET]: PASSWORD,
      now: FIXED_NOW,
    });
  }

  it('runs every step through the runner, feeding the password only via sudo stdin', () => {
    const plan = freshPlan();
    const cache = new PlanCache();
    cache.put(plan, { now: FIXED_NOW });
    const runner = new FakeRunner();
    const result = executePlan(plan, runner, cache, { now: FIXED_NOW });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('succeeded');
    expect(result.error).toBe('');
    expect(result.steps.map((item) => item.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);

    const chpasswd = runner.calls.find((call) => call.command === 'chpasswd')!;
    expect(chpasswd.method).toBe('run_sudo');
    expect(chpasswd.stdin).toBe('alice:' + PASSWORD);
    expect(runner.calls.find((call) => call.command === 'id -- alice')!.method).toBe('run');
    expect(runner.calls.every((call) => !call.command.includes(PASSWORD))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it('stops at the first failing step with the verbatim error', () => {
    const plan = freshPlan();
    const cache = new PlanCache();
    cache.put(plan, { now: FIXED_NOW });
    const runner = new FakeRunner((command) =>
      command === 'chpasswd'
        ? { exit_status: 1, stdout: '', stderr: 'bad password' }
        : { exit_status: 0, stdout: '', stderr: '' },
    );
    const result = executePlan(plan, runner, cache, { now: FIXED_NOW });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1].status).toBe('failed');
    expect(result.error).toBe('步骤“设置初始密码”失败（退出码 1）');
  });

  it('maps a thrown runner error to a readable error step', () => {
    const plan = freshPlan();
    const cache = new PlanCache();
    cache.put(plan, { now: FIXED_NOW });
    const runner = new FakeRunner(() => {
      throw new Error('ssh boom');
    });
    const result = executePlan(plan, runner, cache, { now: FIXED_NOW });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].status).toBe('error');
    expect(result.steps[0].exit_status).toBeNull();
    expect(result.error).toBe('ssh boom');
  });

  it('rejects a tampered plan by re-checking the plan hash', () => {
    const plan = freshPlan();
    const tampered = JSON.parse(JSON.stringify(plan)) as AdminPlan;
    tampered.steps[0].command = `${tampered.steps[0].command} ; rm -rf /`;
    const runner = new FakeRunner();
    expect(() => executePlan(tampered, runner, null)).toThrow('计划校验失败：内容已被篡改');
    expect(runner.calls).toHaveLength(0);
  });

  it('rejects an expired (not cached) plan', () => {
    const plan = freshPlan();
    const cache = new PlanCache({ ttl_seconds: 10 });
    cache.put(plan, { now: FIXED_NOW });
    const runner = new FakeRunner();
    expect(() =>
      executePlan(plan, runner, cache, { now: new Date(FIXED_NOW.getTime() + 11000) }),
    ).toThrow('计划已过期或无效，请重新预览');
    expect(runner.calls).toHaveLength(0);
  });

  it('clips very long stdout to 4000 characters plus an ellipsis', () => {
    const plan = freshPlan();
    const cache = new PlanCache();
    cache.put(plan, { now: FIXED_NOW });
    const runner = new FakeRunner(() => ({ exit_status: 0, stdout: 'x'.repeat(5000), stderr: '' }));
    const result = executePlan(plan, runner, cache, { now: FIXED_NOW });
    expect(result.steps[0].stdout).toHaveLength(4001);
    expect(result.steps[0].stdout.endsWith('…')).toBe(true);
  });
});
