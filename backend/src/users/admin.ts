/**
 * Guarded account provisioning for the server-users feature.
 *
 * 1:1 port of `servermanage/user_admin.py:78-461` (same constants, same regex,
 * same step ids, same command strings, same Chinese error/warning text, same
 * plan structure with snake_case keys, same hash payload). Everything here is
 * deliberately conservative, exactly like the Python oracle:
 *
 * - only four fixed operations exist (create, password, docker, data);
 * - commands are built from validated arguments, never from free-form text;
 * - the new password travels through the SSH stdin channel (`chpasswd`) and is
 *   never part of a command line, a log line, an audit row or an API response;
 * - a plan must be previewed first (put in a {@link PlanCache}) and only then is
 *   `executePlan` allowed to run it;
 * - nothing destructive is automatic: a partially applied plan stops immediately
 *   and reports the manual rollback commands instead of deleting data.
 *
 * Intentional differences from Python (see report on the task):
 * - `executePlan(plan, runner, cache, opts?)` takes the preview `cache` and
 *   re-verifies `plan_hash` before running, so an expired or tampered plan is
 *   rejected. Python's `execute_plan(plan, runner, *, timeout)` executes
 *   directly and has no cache/tamper guard.
 * - `now` is a `Date` (JavaScript) instead of `datetime`; timestamps are still
 *   rendered as `datetime.isoformat()` would (`YYYY-MM-DDTHH:MM:SS.ffffff+00:00`).
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';

import { dumpJson } from '../storage/json';

/** The operations the UI may request.  Anything else is rejected. */
export const OPERATIONS = ['create', 'password', 'docker', 'data'] as const;

export type Operation = (typeof OPERATIONS)[number];

export const OPERATION_LABELS: Record<Operation, string> = {
  create: '创建账号',
  'password': '重置密码',
  docker: '加入 docker 组',
  data: '创建 /data 目录',
};

/** `useradd`-compatible names: lowercase, no leading dash, no spaces. */
export const ACCOUNT_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/** Names that must never be created through the web UI (system accounts). */
export const RESERVED_ACCOUNTS: ReadonlySet<string> = new Set([
  'root',
  'daemon',
  'bin',
  'sys',
  'sync',
  'games',
  'man',
  'lp',
  'mail',
  'news',
  'uucp',
  'proxy',
  'www-data',
  'backup',
  'list',
  'irc',
  'gnats',
  'nobody',
  'systemd-network',
  'systemd-resolve',
  'messagebus',
  'sshd',
  'docker',
  'adm',
  'sudo',
  'wheel',
]);

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 64;
/** `string.ascii_letters + string.digits` — the generated-alphabet (62 chars). */
export const PASSWORD_ALPHABET = [
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)),
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  ...Array.from({ length: 10 }, (_, i) => String.fromCharCode(48 + i)),
].join('');
export const PLAN_TTL_SECONDS = 600;
export const COMMAND_TIMEOUT_SECONDS = 120;
export const MAX_CACHED_PLANS = 32;

/** Raised when a plan cannot be built from the supplied arguments. */
export class AdminPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminPlanError';
  }
}

/** A single plan step. Field names are snake_case, identical to the Python dict. */
export interface PlanStep {
  id: string;
  title: string;
  command: string;
  elevated: boolean;
  stdin: string | null;
  stdin_label: string | null;
  skipped_reason: string | null;
}

/** A human-reviewable plan; `steps[*].stdin` is secret and must not leave the server. */
export interface AdminPlan {
  operation: Operation;
  operation_label: string;
  host: string;
  account: string;
  created_at: string;
  expires_at: string;
  nonce: string;
  plan_hash: string;
  steps: PlanStep[];
  warnings: string[];
  blocked: boolean;
  blocked_reasons: string[];
  rollback_hint: string;
}

/** A step with every secret removed (what the API may send to the browser). */
export interface PublicPlanStep {
  id: string;
  title: string;
  command: string;
  elevated: boolean;
  stdin_label: string | null;
  has_stdin: boolean;
  skipped_reason: string | null;
}

export type PublicPlan = Omit<AdminPlan, 'steps'> & { steps: PublicPlanStep[] };

/** Left-pad a non-negative integer to `width` digits. */
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Render `d` exactly like Python's `datetime.isoformat()` for an aware UTC
 * datetime: `YYYY-MM-DDTHH:MM:SS+00:00`, or with `.ffffff` when the microsecond
 * component is non-zero (Python omits a zero fractional part).
 */
function pyIsoformat(d: Date): string {
  const base =
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}` +
    `T${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}`;
  const microseconds = d.getUTCMilliseconds() * 1000;
  const fraction = microseconds === 0 ? '' : `.${pad(microseconds, 6)}`;
  return `${base}${fraction}+00:00`;
}

/** Recursively copy an object with keys sorted, mirroring `json.dumps(..., sort_keys=True)`. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortDeep(item));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortDeep(record[key]);
    }
    return out;
  }
  return value;
}

/** `hashlib.sha256(value.encode("utf-8")).hexdigest()`. */
export function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Return the normalised account name or raise {@link AdminPlanError}. */
export function validateAccountName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new AdminPlanError('账号名必须是字符串');
  }
  const value = name.trim();
  if (!value) {
    throw new AdminPlanError('请填写账号名');
  }
  if (value !== value.toLowerCase()) {
    throw new AdminPlanError('账号名只能使用小写字母');
  }
  if (!ACCOUNT_RE.test(value)) {
    throw new AdminPlanError('账号名只能包含小写字母、数字、下划线或短横线，且不能以数字或短横线开头');
  }
  if (RESERVED_ACCOUNTS.has(value)) {
    throw new AdminPlanError('这是系统账号名，不能创建');
  }
  return value;
}

/** Validate an admin-supplied password (no newline, no colon, no space). */
export function validatePassword(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AdminPlanError('密码必须是字符串');
  }
  if (value.length < PASSWORD_MIN_LENGTH) {
    throw new AdminPlanError(`密码至少需要 ${PASSWORD_MIN_LENGTH} 位`);
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    throw new AdminPlanError(`密码不能超过 ${PASSWORD_MAX_LENGTH} 位`);
  }
  if (value.includes(':') || value.includes('\n') || value.includes('\r')) {
    throw new AdminPlanError('密码不能包含冒号或换行');
  }
  for (const ch of value) {
    if (/\s/u.test(ch)) {
      throw new AdminPlanError('密码不能包含空格');
    }
  }
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 33 || code > 126) {
      throw new AdminPlanError('密码只能使用可见的 ASCII 字符');
    }
  }
  return value;
}

/** Return a random alphanumeric password (never logged). */
export function generatePassword(length = 16): string {
  const size = Math.max(PASSWORD_MIN_LENGTH, Math.min(PASSWORD_MAX_LENGTH, Math.trunc(length)));
  let out = '';
  for (let i = 0; i < size; i += 1) {
    out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return out;
}

// Aliases matching the spec's lowercase spellings.
export const validatepassword = validatePassword;
export const generatepassword = generatePassword;

/** The stdin label used by both `chpasswd` steps (identical to Python). */
const STDIN_LABEL = '通过标准输入设置密码（不会出现在命令或日志里）';

interface StepInit {
  elevated?: boolean;
  stdin?: string | null;
  stdin_label?: string | null;
  skipped_reason?: string | null;
}

/** Build a step dict mirroring `_step` (defaults: elevated=true, everything else null). */
function step(id: string, title: string, command: string, init: StepInit = {}): PlanStep {
  return {
    id,
    title,
    command,
    elevated: init.elevated ?? true,
    stdin: init.stdin ?? null,
    stdin_label: init.stdin_label ?? null,
    skipped_reason: init.skipped_reason ?? null,
  };
}

function dataCommand(name: string): string {
  return `mkdir -p -- /data/${name} && chown ${name}:${name} -- /data/${name} && chmod 755 -- /data/${name}`;
}

function statCommand(name: string): string {
  return `stat -c '%U %G %a %n' -- /data/${name}`;
}

/** Parameters for {@link buildPlan}; field names follow the Python keyword args. */
export interface BuildPlanParams {
  /** One of {@link OPERATIONS}. */
  operation: string;
  /** Host display name (required; trimmed). Python `host_name`. */
  host_name?: string;
  /** Account name (required; validated/normalised). */
  account: string;
  /** Admin-supplied password for create/reset; generated when absent. Python `password`. */
  password?: string | null;
  account_exists?: boolean;
  docker_group?: boolean;
  data_supported?: boolean;
  /** Python `sudo_configured`. */
  sudo_configured?: boolean;
  with_docker?: boolean;
  with_data?: boolean;
  /** Clock override for deterministic plans/tests. */
  now?: Date;
}

/**
 * Build a human-reviewable plan for `operation` on one account.
 *
 * The returned object is safe to render in the browser **except** for
 * `steps[*].stdin`; callers must use {@link publicPlan} before sending it over
 * the API.
 */
export function buildPlan(params: BuildPlanParams): AdminPlan {
  const { operation } = params;
  if (!(OPERATIONS as readonly string[]).includes(operation)) {
    throw new AdminPlanError(`未知操作：${operation}`);
  }
  const name = validateAccountName(params.account);
  const host = (params.host_name ?? '').trim();
  if (!host) {
    throw new AdminPlanError('缺少主机名');
  }

  const accountExists = params.account_exists ?? false;
  const dockerGroup = params.docker_group ?? true;
  const dataSupported = params.data_supported ?? true;
  const sudoPassword = params.sudo_configured ?? true;
  const withDocker = params.with_docker ?? true;
  const withData = params.with_data ?? true;
  const moment = params.now ?? new Date();

  const steps: PlanStep[] = [];
  const warnings: string[] = [];
  const blocked: string[] = [];

  if (!sudoPassword) {
    blocked.push(
      '这台主机还没有配置 sudo 密码，无法执行需要 root 的操作。请先在主机设置里填写 sudo 密码。',
    );
  }

  if (operation === 'create') {
    if (accountExists) {
      blocked.push(`账号 ${name} 已经存在，不能重复创建；可以改用“重置密码”或“加入 docker 组”。`);
    } else {
      steps.push(
        step('useradd', '创建账号与家目录', `useradd -m -d /home/${name} -s /bin/bash -- ${name}`),
      );
      const newPassword = params.password ? validatePassword(params.password) : generatePassword();
      steps.push(
        step('chpasswd', '设置初始密码', 'chpasswd', {
          stdin: `${name}:${newPassword}`,
          stdin_label: STDIN_LABEL,
        }),
      );
      if (withDocker) {
        if (dockerGroup) {
          steps.push(step('docker', '加入 docker 组', `gpasswd -a ${name} docker`));
        } else {
          warnings.push('这台主机没有 docker 组，跳过加入 docker 组。');
        }
      }
      if (withData) {
        if (dataSupported) {
          steps.push(step('data', '创建 /data 目录并设置权限', dataCommand(name)));
        } else {
          warnings.push('这台主机没有 /data 目录，跳过创建个人目录。');
        }
      }
    }
    const verify: PlanStep[] = [step('verify-id', '验证账号与组', `id -- ${name}`, { elevated: false })];
    if (withData && dataSupported) {
      verify.push(step('verify-data', '验证 /data 目录权限', statCommand(name), { elevated: false }));
    }
    steps.push(...verify);
  } else if (operation === 'password') {
    if (!accountExists) {
      blocked.push(`账号 ${name} 不存在，无法重置密码。`);
    }
    const newPassword = params.password ? validatePassword(params.password) : generatePassword();
    steps.push(
      step('chpasswd', '重置密码', 'chpasswd', {
        stdin: `${name}:${newPassword}`,
        stdin_label: STDIN_LABEL,
      }),
    );
    steps.push(step('verify-id', '验证账号', `id -- ${name}`, { elevated: false }));
  } else if (operation === 'docker') {
    if (!accountExists) {
      blocked.push(`账号 ${name} 不存在，请先创建账号。`);
    }
    if (!dockerGroup) {
      blocked.push('这台主机没有 docker 组，无法加入。');
    }
    steps.push(step('docker', '加入 docker 组', `gpasswd -a ${name} docker`));
    steps.push(step('verify-groups', '验证组成员', `id -nG -- ${name}`, { elevated: false }));
    warnings.push('组成员关系在用户下次登录时生效，已经登录的会话需要重新登录。');
  } else {
    // data
    if (!accountExists) {
      blocked.push(`账号 ${name} 不存在，请先创建账号。`);
    }
    if (!dataSupported) {
      blocked.push('这台主机没有 /data 目录，无法创建个人目录。');
    }
    steps.push(step('data', '创建 /data 目录并设置权限', dataCommand(name)));
    steps.push(step('verify-data', '验证 /data 目录权限', statCommand(name), { elevated: false }));
  }

  const nonce = randomBytes(8).toString('hex');
  const planHash = hashPlan(operation as Operation, host, name, steps, nonce, moment);
  return {
    operation: operation as Operation,
    operation_label: OPERATION_LABELS[operation as Operation],
    host,
    account: name,
    created_at: pyIsoformat(moment),
    expires_at: pyIsoformat(new Date(moment.getTime() + PLAN_TTL_SECONDS * 1000)),
    nonce,
    plan_hash: planHash,
    steps,
    warnings,
    blocked: blocked.length > 0,
    blocked_reasons: blocked,
    rollback_hint: rollbackHint(operation, name),
  };
}

/** Manual rollback guidance; the tool never deletes data automatically. */
export function rollbackHint(operation: string, name: string): string {
  if (operation === 'create') {
    return (
      '如果中途失败，可能只创建了账号或目录。回滚需要你手工确认：' +
      `\`sudo userdel -r ${name}\`（会删除家目录）以及 \`sudo rm -rf /data/${name}\`。` +
      '本工具不会自动删除任何数据。'
    );
  }
  if (operation === 'data') {
    return `如果目录是本次新建的，可以手工执行 \`sudo rmdir /data/${name}\`（仅在目录为空时有效）。`;
  }
  return `本操作只修改密码或组成员关系，可用原密码或 \`sudo gpasswd -d ${name} docker\` 撤销。`;
}

// Alias matching the spec's `_rollbackHint` name.
export const _rollbackHint = rollbackHint;

/**
 * Compute the plan hash exactly like `_hash_plan`: a SHA-256 over Python-style
 * `json.dumps(payload, ensure_ascii=False, sort_keys=True)` of the operation,
 * host, account, nonce, `created_at` and per-step `{id, command, elevated,
 * stdin_sha256}` (stdin hashed, never embedded).
 */
export function hashPlan(
  operation: string,
  host: string,
  account: string,
  steps: ReadonlyArray<PlanStep>,
  nonce: string,
  moment: Date,
): string {
  const payload = {
    operation,
    host,
    account,
    nonce,
    created_at: pyIsoformat(moment),
    steps: steps.map((item) => ({
      id: item.id,
      command: item.command,
      elevated: item.elevated,
      stdin_sha256: item.stdin ? digest(item.stdin) : null,
    })),
  };
  const encoded = dumpJson(sortDeep(payload));
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

// Alias matching the spec's `_hashPlan` name.
export const _hashPlan = hashPlan;

/** Return a copy of `plan` with every secret removed. */
export function publicPlan(plan: AdminPlan): PublicPlan {
  const { steps, ...rest } = plan;
  return {
    ...rest,
    steps: steps.map((item) => ({
      id: item.id,
      title: item.title,
      command: item.command,
      elevated: item.elevated,
      stdin_label: item.stdin_label,
      has_stdin: Boolean(item.stdin),
      skipped_reason: item.skipped_reason,
    })),
  };
}

/** Commands are already secret-free; kept for callers that log them. */
export function maskCommand(command: string): string {
  return command;
}

/** Options for {@link PlanCache}. */
export interface PlanCacheOptions {
  ttl_seconds?: number;
  max_entries?: number;
}

/** A clock override shared by the cache methods and {@link executePlan}. */
export interface ClockOptions {
  now?: Date;
}

/** Short-lived, in-process cache of previewed plans (secrets stay server side). */
export class PlanCache {
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly items = new Map<string, { created: number; plan: AdminPlan }>();

  constructor(opts: PlanCacheOptions = {}) {
    this.ttlMs = (opts.ttl_seconds ?? PLAN_TTL_SECONDS) * 1000;
    this.max = opts.max_entries ?? MAX_CACHED_PLANS;
  }

  put(plan: AdminPlan, clock: ClockOptions = {}): void {
    const moment = (clock.now ?? new Date()).getTime();
    this.prune(moment);
    this.items.set(plan.plan_hash, { created: moment, plan });
    while (this.items.size > this.max) {
      let oldestKey: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, item] of this.items) {
        if (item.created < oldest) {
          oldest = item.created;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) {
        break;
      }
      this.items.delete(oldestKey);
    }
  }

  get(planHash: string, clock: ClockOptions = {}): AdminPlan | null {
    const moment = (clock.now ?? new Date()).getTime();
    this.prune(moment);
    const item = this.items.get(planHash);
    return item ? item.plan : null;
  }

  drop(planHash: string): void {
    this.items.delete(planHash);
  }

  private prune(moment: number): void {
    for (const [key, item] of Array.from(this.items.entries())) {
      if (moment - item.created > this.ttlMs) {
        this.items.delete(key);
      }
    }
  }
}

/** The shape of a command result a {@link PlanRunner} returns. */
export interface CommandResult {
  exit_status: number;
  stdout?: string | null;
  stderr?: string | null;
}

/** Injected command runner; must never be a real SSH connection in tests. */
export interface PlanRunner {
  run(command: string, timeout: number): CommandResult;
  run_sudo(command: string, timeout: number, opts?: { stdin_data?: string | null }): CommandResult;
}

/** Options for {@link executePlan}. */
export interface ExecutePlanOptions extends ClockOptions {
  timeout?: number;
}

export interface ExecutedStep {
  id: string;
  title: string;
  status: 'ok' | 'failed' | 'error';
  exit_status: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecutePlanResult {
  ok: boolean;
  status: 'succeeded' | 'failed' | 'error';
  steps: ExecutedStep[];
  error: string;
}

function clip(text: string | null | undefined, limit = 4000): string {
  const value = text ?? '';
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function safeError(exc: unknown): string {
  let message: string;
  if (exc instanceof Error) {
    message = exc.message;
  } else if (typeof exc === 'string') {
    message = exc;
  } else {
    message = String(exc);
  }
  if (!message && exc instanceof Error) {
    message = exc.constructor.name;
  }
  return message.slice(0, 400);
}

/**
 * Run every step of `plan` in order, stopping at the first failure.
 *
 * Before executing, the plan must be present in `cache` (i.e. it was previewed
 * and has not expired) and its `plan_hash` must still match its content — a
 * tampered or expired plan raises {@link AdminPlanError}. Pass `cache = null`
 * to skip the preview/expiry check (hash integrity is still verified). The
 * returned object never contains the password.
 */
export function executePlan(
  plan: AdminPlan,
  runner: PlanRunner,
  cache?: PlanCache | null,
  opts: ExecutePlanOptions = {},
): ExecutePlanResult {
  if (cache) {
    const cached = cache.get(plan.plan_hash, { now: opts.now });
    if (!cached) {
      throw new AdminPlanError('计划已过期或无效，请重新预览');
    }
  }
  const expectedHash = hashPlan(
    plan.operation,
    plan.host,
    plan.account,
    plan.steps,
    plan.nonce,
    new Date(plan.created_at),
  );
  if (expectedHash !== plan.plan_hash) {
    throw new AdminPlanError('计划校验失败：内容已被篡改');
  }

  const timeout = opts.timeout ?? COMMAND_TIMEOUT_SECONDS;
  const results: ExecutedStep[] = [];
  for (const item of plan.steps) {
    const stdinData = item.stdin;
    try {
      const result = item.elevated
        ? runner.run_sudo(item.command, timeout, { stdin_data: stdinData })
        : runner.run(item.command, timeout);
      const entry: ExecutedStep = {
        id: item.id,
        title: item.title,
        status: result.exit_status === 0 ? 'ok' : 'failed',
        exit_status: result.exit_status,
        stdout: clip(result.stdout),
        stderr: clip(result.stderr),
      };
      results.push(entry);
      if (result.exit_status !== 0) {
        return {
          ok: false,
          status: 'failed',
          steps: results,
          error: `步骤“${item.title}”失败（退出码 ${result.exit_status}）`,
        };
      }
    } catch (exc) {
      results.push({
        id: item.id,
        title: item.title,
        status: 'error',
        exit_status: null,
        stdout: '',
        stderr: safeError(exc),
      });
      return { ok: false, status: 'error', steps: results, error: safeError(exc) };
    }
  }
  return { ok: true, status: 'succeeded', steps: results, error: '' };
}

/** Async twin of {@link PlanRunner}, used by the real (SSH-backed) executor. */
export interface AsyncPlanRunner {
  run(command: string, timeout: number): Promise<CommandResult>;
  run_sudo(
    command: string,
    timeout: number,
    opts?: { stdin_data?: string | null },
  ): Promise<CommandResult>;
}

/**
 * Async twin of {@link executePlan} for a real SSH connection.
 *
 * Validation (cache presence, expiry, tamper hash), per-step status semantics,
 * failure short-circuit and 4000/400-character clipping are identical to
 * {@link executePlan}; the only difference is that each command is awaited.
 * The synchronous `executePlan` stays the oracle-parity path used by unit tests.
 */
export async function executePlanAsync(
  plan: AdminPlan,
  runner: AsyncPlanRunner,
  cache?: PlanCache | null,
  opts: ExecutePlanOptions = {},
): Promise<ExecutePlanResult> {
  if (cache) {
    const cached = cache.get(plan.plan_hash, { now: opts.now });
    if (!cached) {
      throw new AdminPlanError('计划已过期或无效，请重新预览');
    }
  }
  const expectedHash = hashPlan(
    plan.operation,
    plan.host,
    plan.account,
    plan.steps,
    plan.nonce,
    new Date(plan.created_at),
  );
  if (expectedHash !== plan.plan_hash) {
    throw new AdminPlanError('计划校验失败：内容已被篡改');
  }

  const timeout = opts.timeout ?? COMMAND_TIMEOUT_SECONDS;
  const results: ExecutedStep[] = [];
  for (const item of plan.steps) {
    const stdinData = item.stdin;
    try {
      const result = item.elevated
        ? await runner.run_sudo(item.command, timeout, { stdin_data: stdinData })
        : await runner.run(item.command, timeout);
      const entry: ExecutedStep = {
        id: item.id,
        title: item.title,
        status: result.exit_status === 0 ? 'ok' : 'failed',
        exit_status: result.exit_status,
        stdout: clip(result.stdout),
        stderr: clip(result.stderr),
      };
      results.push(entry);
      if (result.exit_status !== 0) {
        return {
          ok: false,
          status: 'failed',
          steps: results,
          error: `步骤“${item.title}”失败（退出码 ${result.exit_status}）`,
        };
      }
    } catch (exc) {
      results.push({
        id: item.id,
        title: item.title,
        status: 'error',
        exit_status: null,
        stdout: '',
        stderr: safeError(exc),
      });
      return { ok: false, status: 'error', steps: results, error: safeError(exc) };
    }
  }
  return { ok: true, status: 'succeeded', steps: results, error: '' };
}
