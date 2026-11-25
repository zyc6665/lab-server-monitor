/**
 * Synthetic availability checks — a line-for-line port of
 * `servermanage/availability.py:37-341`.
 *
 * The Python oracle builds small shell probes (`timeout … bash -c`, `curl`,
 * `pgrep`, `systemctl`) whose stdout/exit status is projected onto a
 * {@link HostCheckResult}. This module reproduces that behaviour exactly:
 *
 * - **Target validation** lives in {@link validateCheckTarget} (and the
 *   per-type helpers below). Every rejection raises {@link CheckTargetError}
 *   with the same Chinese message the Python code produces, so a malicious
 *   target can never reach a shell command.
 * - {@link buildCheckCommand} renders the shell command **byte for byte** like
 *   Python. In particular {@link shlexQuote} mirrors `shlex.quote` (ASCII-only
 *   `\w`, single-quote escaping as `'\''`).
 * - {@link parseCheckResult} maps one {@link CommandResult} to a
 *   {@link HostCheckResult}; {@link runHostChecks} runs the enabled checks
 *   sequentially and isolates every per-check failure into an `error` result
 *   instead of aborting the batch (Python `try/except Exception`).
 *
 * ## Deviations from the Python module (intentional)
 *
 * - Argument order: Python is `run_host_checks(host, runner, checks,
 *   command_timeout)`; the TypeScript surface is
 *   `runHostChecks(host, checks, runner, { timeoutMs })` as requested by the P4
 *   plan. `timeoutMs` is milliseconds (the raw `command_timeout` seconds ×
 *   1000) and is converted back to whole seconds for the per-check ceiling.
 * - `runner.run(command, timeoutMs)` receives milliseconds, matching the
 *   `CollectorRunner` shape from `collect/collectors.ts`; Python passes seconds.
 * - Results use the camelCase {@link HostCheckResult} from `collect/types.ts`
 *   (`latencyMs` / `checkedAt`). Callers that persist through the host-route
 *   layer (which reads snake_case `latency_ms`) must map those fields.
 */
import { isIP } from 'node:net';

import type { HostCheckConfig, HostConfig } from '../config/config';
import { HostSettingsError } from '../config/hosts';
import type { CommandResult, HostCheckResult } from '../collect/types';
import { nowIsoUtc } from '../storage/time';

/** Check types the oracle knows about (`SUPPORTED_CHECK_TYPES`). */
export const SUPPORTED_CHECK_TYPES = ['tcp', 'http', 'process', 'service'] as const;

type CheckType = (typeof SUPPORTED_CHECK_TYPES)[number];

/** Rejection raised for any invalid check target (`CheckTargetError(ValueError)`). */
export class CheckTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckTargetError';
  }
}

/** Minimal runner contract consumed by {@link runHostChecks}. */
export interface CheckRunner {
  /** Runs one shell command; `timeoutMs` is a wall-clock budget in milliseconds. */
  run(command: string, timeoutMs: number): CommandResult | Promise<CommandResult>;
  /** Optional cleanup hook (e.g. close a pooled SSH client). */
  close?(): void;
}

/** Options for {@link runHostChecks}. */
export interface RunHostChecksOptions {
  /**
   * Whole-run command ceiling in **milliseconds** (Python `command_timeout`
   * seconds × 1000). `0` / missing disables the ceiling.
   */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// String / numeric helpers
// ---------------------------------------------------------------------------

/** Python `repr(value)` for the scalar shapes used in error messages. */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') {
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/'/g, "\\'");
    return `'${escaped}'`;
  }
  return String(value);
}

/** Python `_has_control_or_space`: any whitespace, C0 control, or DEL. */
function hasControlOrSpace(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (ch.trim() === '' || code < 32 || code === 127) return true;
  }
  return false;
}

/** Python `shlex.quote` (ASCII `\w`; empty → `''`; single quotes → `'\''`). */
function shlexQuote(value: string): string {
  if (value === '') return "''";
  // JS `\w` is ASCII-only, matching Python's `re.ASCII` variant.
  if (!/[^\w@%+=:,./-]/.test(value)) return value;
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

/**
 * Python `_coerce_timeout`: rejects booleans/floats/non-integers, then enforces
 * `1 <= timeout <= 30`.
 */
export function coerceTimeoutSeconds(value: unknown): number {
  if (typeof value === 'boolean') {
    throw new CheckTargetError('timeout_seconds 不能是布尔值');
  }
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new CheckTargetError('timeout_seconds 必须是整数');
  }
  let numeric: number;
  if (typeof value === 'number') {
    numeric = value;
  } else if (typeof value === 'string' && /^[+-]?[0-9]+$/.test(value.trim())) {
    numeric = Number(value.trim());
  } else {
    throw new CheckTargetError('timeout_seconds 必须是整数');
  }
  if (!(numeric >= 1 && numeric <= 30)) {
    throw new CheckTargetError('timeout_seconds 必须在 1..30 之间');
  }
  return numeric;
}

// ---------------------------------------------------------------------------
// Target validation (`validate_check_target`)
// ---------------------------------------------------------------------------

const HTTP_FORBIDDEN_TOKENS = ['`', '$(', ';', '|', '&'];
const TCP_HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
const PROCESS_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const SERVICE_RE = /^[A-Za-z0-9@._:-]{1,128}$/;
const DIGITS_RE = /^[0-9]+$/;
const EXPECTED_RE = /^(\d{3})(?:-(\d{3}))?$/;
const BRACKET_V6_RE = /^\[([0-9A-Fa-f:.]+)\]:([0-9]{1,5})$/;

/** Python `_parse_port`. */
function parseTcpPortText(text: string): number {
  if (!DIGITS_RE.test(text)) throw new CheckTargetError(`TCP 端口非法: ${pyRepr(text)}`);
  const port = Number(text);
  if (!(port >= 1 && port <= 65535)) {
    throw new CheckTargetError('TCP 端口必须在 1..65535 之间');
  }
  return port;
}

/** Python `_validate_tcp_host`. */
function validateTcpHost(host: string): void {
  if (host === '') throw new CheckTargetError('TCP 主机为空');
  if (isIP(host) !== 0) return;
  if (!TCP_HOST_RE.test(host) || !/[A-Za-z0-9]/.test(host)) {
    throw new CheckTargetError(`TCP 主机名非法: ${pyRepr(host)}`);
  }
}

/** Python `_split_tcp_target`: returns `{ host, port }`. */
function splitTcpTarget(target: string): { host: string; port: number } {
  if (typeof target !== 'string' || target === '') {
    throw new CheckTargetError('TCP 目标为空');
  }
  if (target.length > 256) throw new CheckTargetError('TCP 目标过长');
  if (hasControlOrSpace(target)) throw new CheckTargetError('TCP 目标包含空白或控制字符');
  if (target.startsWith('[')) {
    const match = BRACKET_V6_RE.exec(target);
    if (!match) throw new CheckTargetError(`TCP IPv6 目标非法: ${pyRepr(target)}`);
    const host = match[1];
    if (isIP(host) !== 6) throw new CheckTargetError(`TCP IPv6 主机非法: ${pyRepr(host)}`);
    return { host, port: parseTcpPortText(match[2]) };
  }
  const colon = target.lastIndexOf(':');
  const host = colon >= 0 ? target.slice(0, colon) : '127.0.0.1';
  const portText = colon >= 0 ? target.slice(colon + 1) : target;
  validateTcpHost(host);
  return { host, port: parseTcpPortText(portText) };
}

/** Minimal `urlsplit` projection (scheme + netloc) used by HTTP validation. */
function splitUrl(target: string): { scheme: string; netloc: string } {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(target);
  const scheme = match ? match[1].toLowerCase() : '';
  const rest = match ? match[2] : target;
  let netloc = '';
  if (rest.startsWith('//')) {
    const after = rest.slice(2);
    const stop = after.search(/[/?#]/);
    netloc = stop >= 0 ? after.slice(0, stop) : after;
  }
  return { scheme, netloc };
}

/** Python `_validate_http_target`; returns the validated target unchanged. */
function validateHttpTarget(target: string): string {
  if (typeof target !== 'string' || target === '') {
    throw new CheckTargetError('HTTP 目标为空');
  }
  if (target.length > 256) throw new CheckTargetError('HTTP 目标过长');
  if (hasControlOrSpace(target)) throw new CheckTargetError('HTTP 目标包含空白或控制字符');
  for (const token of HTTP_FORBIDDEN_TOKENS) {
    if (target.includes(token)) {
      throw new CheckTargetError(`HTTP 目标包含非法字符: ${pyRepr(token)}`);
    }
  }
  if (target.includes('?') || target.includes('#')) {
    throw new CheckTargetError('HTTP 目标不允许查询串或片段');
  }
  const { scheme, netloc } = splitUrl(target);
  // `urlsplit` rejects a malformed bracketed host with "Invalid IPv6 URL".
  if (netloc.startsWith('[') && !/^\[[0-9A-Fa-f:.]+\](?::[0-9]+)?$/.test(netloc)) {
    throw new CheckTargetError('HTTP 目标无法解析: Invalid IPv6 URL');
  }
  if (scheme !== 'http' && scheme !== 'https') {
    throw new CheckTargetError('HTTP 目标只允许 http/https');
  }
  if (netloc === '') throw new CheckTargetError('HTTP 目标缺少主机');
  if (netloc.includes('@')) throw new CheckTargetError('HTTP 目标不允许携带 userinfo/凭据');
  if (target.includes('?') || target.includes('#')) {
    throw new CheckTargetError('HTTP 目标不允许查询串或片段');
  }
  return target;
}

/** Python `_validate_process_target`; returns the validated target unchanged. */
function validateProcessTarget(target: string): string {
  if (typeof target !== 'string' || target.length > 256) {
    throw new CheckTargetError('进程目标非法');
  }
  if (!PROCESS_RE.test(target)) throw new CheckTargetError(`进程名非法: ${pyRepr(target)}`);
  return target;
}

/** Python `_validate_service_target`; returns the validated target unchanged. */
function validateServiceTarget(target: string): string {
  if (typeof target !== 'string' || target.length > 256) {
    throw new CheckTargetError('服务目标非法');
  }
  if (!SERVICE_RE.test(target)) throw new CheckTargetError(`systemd unit 非法: ${pyRepr(target)}`);
  return target;
}

/**
 * Python `validate_check_target`: normalises the type and validates the target
 * for that type, returning the target unchanged.
 */
export function validateCheckTarget(checkType: string, target: string): string {
  const ctype = (checkType ?? '').trim().toLowerCase();
  if (!SUPPORTED_CHECK_TYPES.includes(ctype as CheckType)) {
    throw new CheckTargetError(`不支持的检查类型: ${pyRepr(checkType)}`);
  }
  switch (ctype as CheckType) {
    case 'tcp':
      splitTcpTarget(target);
      return target;
    case 'http':
      return validateHttpTarget(target);
    case 'process':
      return validateProcessTarget(target);
    case 'service':
      return validateServiceTarget(target);
  }
}

// ---------------------------------------------------------------------------
// Command construction (`build_check_command`)
// ---------------------------------------------------------------------------

/**
 * Python `build_check_command`: renders the exact shell command for one check.
 * Timeouts are validated (so injection through `timeout_seconds` is impossible)
 * and the target is validated before quoting.
 */
export function buildCheckCommand(check: HostCheckConfig): string {
  const timeout = coerceTimeoutSeconds(check.timeout_seconds);
  const ctype = (check.type ?? '').trim().toLowerCase();
  switch (ctype) {
    case 'tcp': {
      const { host, port } = splitTcpTarget(check.target);
      const commandHost = host.includes(':') ? `[${host}]` : host;
      const inner = `cat < /dev/null > /dev/tcp/${commandHost}/${port}`;
      return `timeout ${timeout} bash -c ${shlexQuote(inner)}`;
    }
    case 'http': {
      const url = validateHttpTarget(check.target);
      return `curl -sS -o /dev/null -w '%{http_code} %{time_total}' --max-time ${timeout} ${shlexQuote(url)}`;
    }
    case 'process': {
      const name = validateProcessTarget(check.target);
      return `pgrep -x -- ${shlexQuote(name)}`;
    }
    case 'service': {
      const unit = validateServiceTarget(check.target);
      return `systemctl is-active -- ${shlexQuote(unit)}`;
    }
    default:
      throw new CheckTargetError(`不支持的检查类型: ${pyRepr(check.type)}`);
  }
}

// ---------------------------------------------------------------------------
// Result parsing (`parse_check_result`)
// ---------------------------------------------------------------------------

/** Python `_expected_range`: defaults to `200-399`; swaps inverted bounds. */
export function expectedRange(expected?: string | null): [number, number] {
  if (expected === undefined || expected === null || expected === '') return [200, 399];
  const match = EXPECTED_RE.exec(String(expected).trim());
  if (!match) return [200, 399];
  let low = Number(match[1]);
  let high = match[2] === undefined ? low : Number(match[2]);
  if (low > high) [low, high] = [high, low];
  return [low, high];
}

type ParsedCheck = [status: string, message: string, latencyMs: number | null];

/** Python `_parse_http`. */
function parseHttp(check: HostCheckConfig, result: CommandResult): ParsedCheck {
  if (result.exitStatus === 127) return ['error', 'curl 不可用', null];
  const text = (result.stdout ?? '').trim();
  const parts = text === '' ? [] : text.split(/\s+/);
  if (parts.length === 0) return ['error', '无 HTTP 输出', null];
  const code = parts[0];
  let latency: number | null = null;
  if (parts.length > 1) {
    const parsed = Number(parts[1]);
    if (parts[1] !== '' && !Number.isNaN(parsed)) latency = parsed * 1000;
  }
  if (code === '000' || !/^[0-9]{3}$/.test(code)) {
    return ['error', `HTTP ${code}：无法连接`, latency];
  }
  const [low, high] = expectedRange(check.expected);
  const numeric = Number(code);
  if (numeric >= low && numeric <= high) return ['ok', `HTTP ${code}`, latency];
  return ['failed', `HTTP ${code}（期望 ${low}-${high}）`, latency];
}

/** Python `_parse_tcp`. */
function parseTcp(result: CommandResult): ParsedCheck {
  if (result.exitStatus === 0) return ['ok', '端口可连接', null];
  if (result.exitStatus === 127) return ['error', 'timeout/bash 命令不可用', null];
  const detail = (result.stderr ?? '').trim();
  return ['failed', detail === '' ? '端口不可连接' : `端口不可连接：${detail}`, null];
}

/** Python `_parse_process`. */
function parseProcess(result: CommandResult): ParsedCheck {
  const stdout = (result.stdout ?? '').trim();
  if (result.exitStatus === 0 && stdout !== '') return ['ok', '进程运行中', null];
  if (result.exitStatus === 1) return ['failed', '进程未运行', null];
  if (result.exitStatus === 0 && stdout === '') return ['error', '进程检查无输出', null];
  return ['error', `pgrep 退出码 ${result.exitStatus}`, null];
}

/** Python `_parse_service`. */
function parseService(result: CommandResult): ParsedCheck {
  const state = (result.stdout ?? '').trim();
  if (state === 'active') return ['ok', '服务 active', null];
  if (state === 'inactive' || state === 'failed') return ['failed', `服务 ${state}`, null];
  return ['error', `服务状态 ${state === '' ? '未知' : state}`, null];
}

/**
 * Python `parse_check_result`: maps one command result onto a
 * {@link HostCheckResult}, stamping `checkedAt` with the current UTC time.
 */
export function parseCheckResult(check: HostCheckConfig, result: CommandResult): HostCheckResult {
  const ctype = (check.type ?? '').trim().toLowerCase();
  let parsed: ParsedCheck;
  switch (ctype) {
    case 'http':
      parsed = parseHttp(check, result);
      break;
    case 'tcp':
      parsed = parseTcp(result);
      break;
    case 'process':
      parsed = parseProcess(result);
      break;
    case 'service':
      parsed = parseService(result);
      break;
    default:
      parsed = ['error', `不支持的检查类型: ${pyRepr(check.type)}`, null];
      break;
  }
  const [status, message, latencyMs] = parsed;
  return {
    name: check.name,
    type: check.type,
    target: check.target,
    status,
    message,
    latencyMs,
    checkedAt: nowIsoUtc(),
  };
}

/** Python `_error_result`: wraps any thrown validation / runner error. */
function errorResult(check: HostCheckConfig, exc: unknown): HostCheckResult {
  const target = typeof check.target === 'string' ? check.target : '';
  const detail = (exc instanceof Error ? exc.message : String(exc)).trim();
  return {
    name: typeof check.name === 'string' ? check.name : '',
    type: typeof check.type === 'string' ? check.type : '',
    target,
    status: 'error',
    message: detail === '' ? '检查执行失败' : `检查执行失败：${detail}`,
    latencyMs: null,
    checkedAt: nowIsoUtc(),
  };
}

// ---------------------------------------------------------------------------
// Batch execution (`run_host_checks`)
// ---------------------------------------------------------------------------

/** `int(command_timeout)` → seconds; invalid / non-finite → 0 (no ceiling). */
function timeoutCeilingSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.trunc(value / 1000);
}

/**
 * Python `run_host_checks`: runs every enabled check (max 20) sequentially.
 *
 * A failure in one check — validation, command construction, or the runner
 * itself — is captured as an `error` result and never aborts the remaining
 * checks. The per-check timeout is clamped to the whole-run ceiling when one is
 * configured.
 */
export async function runHostChecks(
  host: HostConfig,
  checks: readonly HostCheckConfig[],
  runner: CheckRunner,
  options: RunHostChecksOptions = {},
): Promise<HostCheckResult[]> {
  void host;
  const ceiling = timeoutCeilingSeconds(options.timeoutMs);
  const enabled = checks
    .filter((check) => (check.enabled === undefined ? true : Boolean(check.enabled)))
    .slice(0, 20);
  const results: HostCheckResult[] = [];
  for (const check of enabled) {
    try {
      let timeout = coerceTimeoutSeconds(check.timeout_seconds);
      if (ceiling > 0) timeout = Math.min(timeout, ceiling);
      const command = buildCheckCommand(check);
      const commandResult = await runner.run(command, timeout * 1000);
      results.push(parseCheckResult(check, commandResult));
    } catch (err) {
      results.push(errorResult(check, err));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Route preparation (`prepareHostCheck` injection)
// ---------------------------------------------------------------------------

const EXPECTED_STATUS_RE = /^\d{3}(-\d{3})?$/;

/**
 * Validates one posted check payload into a {@link HostCheckConfig}.
 *
 * Mirrors the route-local `sanitizeSingleCheck` (which itself follows the
 * oracle's inline "test this check" rules): field presence, name/type/target
 * shape, integer timeout and `expected` format. Deep target syntax validation is
 * deliberately left to {@link buildCheckCommand}, so the route surfaces it as a
 * per-check `error` result rather than a 400.
 *
 * Throws {@link HostSettingsError} so the hosts route maps bad payloads to 400.
 */
export function coerceHostCheckConfig(payload: Record<string, unknown>): HostCheckConfig {
  const name = String(payload['name'] ?? '').trim();
  if (!name) throw new HostSettingsError('checks[0].name 不能为空');
  if (name.length > 64) throw new HostSettingsError('checks[0].name 最多 64 个字符');
  const type = String(payload['type'] ?? '').trim().toLowerCase();
  if (!SUPPORTED_CHECK_TYPES.includes(type as CheckType)) {
    throw new HostSettingsError('checks[0].type 必须是 tcp/http/process/service 之一');
  }
  const target = String(payload['target'] ?? '').trim();
  if (!target) throw new HostSettingsError('checks[0].target 不能为空');
  if (target.length > 256) throw new HostSettingsError('checks[0].target 最多 256 个字符');
  const timeoutRaw = payload['timeout_seconds'] === undefined ? 5 : payload['timeout_seconds'];
  if (typeof timeoutRaw === 'boolean' || !Number.isInteger(timeoutRaw)) {
    throw new HostSettingsError('checks[0].timeout_seconds 必须是整数');
  }
  const timeout = timeoutRaw as number;
  if (timeout < 1 || timeout > 30) {
    throw new HostSettingsError('checks[0].timeout_seconds 必须在 1 到 30 之间');
  }
  let expected: string | undefined;
  if (payload['expected'] !== null && payload['expected'] !== undefined) {
    const text = String(payload['expected']).trim();
    if (text) {
      if (!EXPECTED_STATUS_RE.test(text)) {
        throw new HostSettingsError('checks[0].expected 必须是 200 或 200-299 这样的状态码');
      }
      expected = text;
    }
  }
  const check: HostCheckConfig = {
    name,
    type,
    target,
    timeout_seconds: timeout,
    enabled: payload['enabled'] === undefined ? true : Boolean(payload['enabled']),
  };
  if (expected !== undefined) check.expected = expected;
  return check;
}

/** Alias matching the plan's `coerceHostCheck` wording. */
export const coerceHostCheck = coerceHostCheckConfig;
