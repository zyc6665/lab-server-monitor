/**
 * Host connection probe — a 1:1 TypeScript port of the Python oracle
 * `servermanage/host_probe.py`.
 *
 * The probe connects to a candidate host, reads a fixed set of fields
 * (hostname / OS / kernel / CPU / memory / mounts), detects whether STORCLI is
 * installed and whether passwordless sudo works, and reports a normalised
 * result. Connection failures are mapped to stable status codes with
 * user-facing Chinese messages.
 *
 * The Python implementation talks to a `runner` object exposing `run(command,
 * timeout)` (and an optional `run_sudo(command, timeout)`). That shape is kept
 * verbatim here (`ProbeRunner`) so behaviour can be tested with a fake runner
 * and so the production `SshClient` can be adapted to it.
 */

import type { CommandResult } from './types';
import {
  HostKeyMismatch,
  SshClient,
  SudoAuthError,
  SudoUnavailable,
} from './ssh-client';
import type { SshConnectConfig } from './ssh-client';

// ---------------------------------------------------------------------------
// Constants & messages (mirrors DEFAULT_TIMEOUT and the module-level strings)
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT = 8;

export const AUTH_MESSAGE = '认证失败：请检查用户名、密码或私钥是否正确';
export const TIMEOUT_MESSAGE = '连接超时：请检查主机地址、端口和网络连通性';
export const REFUSED_MESSAGE = '无法连接主机：请检查主机地址、端口和网络';
export const HOST_KEY_MESSAGE = '主机密钥校验失败：主机密钥可能已变更';
export const SUDO_WARNING =
  '未检测到可用的 sudo 提权；可在主机编辑中配置 sudo 密码，或配置免密 sudo 后重试';
export const STORCLI_WARNING = '未检测到 storcli，磁盘健康将不可用';

// ---------------------------------------------------------------------------
// Types (ProbeResult mirrors the Python dataclass, including its defaults)
// ---------------------------------------------------------------------------

/** One parsed row of `df -hP`. Field names follow the Python dict exactly. */
export interface ProbeMount {
  /** Filesystem / device (Python key: `fs`). */
  fs: string;
  /** Total size as printed, e.g. "200G". */
  total: string;
  /** Used size as printed. */
  used: string;
  /** Available size as printed. */
  available: string;
  /** Use% as an integer (Python key: `percent`). */
  percent: number;
  /** Mount point, re-joined in case it contains spaces. */
  mountpoint: string;
}

export interface ProbeResult {
  ok: boolean;
  status: string;
  message: string;
  hostname: string | null;
  osRelease: string | null;
  kernel: string | null;
  cpuCores: number | null;
  memoryTotalMb: number | null;
  mounts: ProbeMount[];
  storcliAvailable: boolean;
  storcliPath: string | null;
  sudoAvailable: boolean;
  warnings: string[];
}

/**
 * The runner abstraction the probe drives. `SshClient` is adapted to this in
 * `defaultRunnerFactory`; tests inject a fake.
 */
export interface ProbeRunner {
  run(command: string, timeoutMs: number): Promise<CommandResult>;
  /** Optional sudo runner; Python's `run_sudo`. */
  runSudo?(command: string, timeoutMs: number): Promise<CommandResult>;
  close?(): void;
}

/**
 * A candidate host to probe. Only the fields needed to build a connection are
 * typed; extra fields are tolerated because the Python `candidate` is a loose
 * dict-like object.
 */
export interface ProbeCandidate {
  host: string;
  port?: number;
  username?: string;
  authType?: string;
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  keyPassphrase?: string;
  sudoPassword?: string;
  name?: string;
  [extra: string]: unknown;
}

export type ProbeRunnerFactory = (candidate: ProbeCandidate) => ProbeRunner;

export interface ProbeOptions {
  /** Inject a custom runner factory (tests). Defaults to `SshClient`. */
  sshFactory?: ProbeRunnerFactory;
  /** Per-command timeout in seconds. Defaults to `DEFAULT_TIMEOUT`. */
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers — verbatim ports of the Python private functions
// ---------------------------------------------------------------------------

/**
 * Run `command` and return trimmed stdout, or `null` on a non-zero exit /
 * empty output (appending `无法获取{label}` to `warnings`). Mirrors
 * `_read_field`.
 */
export async function readField(
  runner: ProbeRunner,
  command: string,
  timeout: number,
  warnings: string[],
  label: string,
): Promise<string | null> {
  const result = await runner.run(command, timeout);
  const text = (result.stdout ?? '').trim();
  if (result.exitStatus !== 0 || text === '') {
    warnings.push(`无法获取${label}`);
    return null;
  }
  return text;
}

/** Extract PRETTY_NAME (with surrounding quotes stripped) from /etc/os-release. */
export function parseOsRelease(text: string | null | undefined): string | null {
  if (!text) {
    return null;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine;
    if (line.startsWith('PRETTY_NAME=')) {
      let value = line.split('=').slice(1).join('=').trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      return value === '' ? null : value;
    }
  }
  return null;
}

/** Parse an integer, falling back to the first digit run (mirrors `_parse_int`). */
export function parseInteger(text: string | null | undefined): number | null {
  if (text === null || text === undefined) {
    return null;
  }
  const stripped = text.trim();
  if (stripped === '') {
    return null;
  }
  const direct = Number(stripped);
  if (Number.isInteger(direct)) {
    return direct;
  }
  const match = /\d+/.exec(stripped);
  if (match) {
    return Number.parseInt(match[0], 10);
  }
  return null;
}

/** Read the `total` column of `free -m`'s `Mem:` row (mirrors `_parse_memory_total`). */
export function parseMemoryTotal(text: string | null | undefined): number | null {
  if (!text) {
    return null;
  }
  for (const rawLine of text.split('\n')) {
    const parts = rawLine.split(/\s+/).filter((part) => part !== '');
    if (parts.length >= 2 && parts[0] === 'Mem:') {
      const value = Number(parts[1]);
      return Number.isInteger(value) ? value : null;
    }
  }
  return null;
}

/** Parse `df -hP` output into mounted-filesystem rows (mirrors `_parse_df`). */
export function parseDf(text: string | null | undefined): ProbeMount[] {
  const mounts: ProbeMount[] = [];
  if (!text) {
    return mounts;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine;
    if (line.trim() === '' || line.toLowerCase().startsWith('filesystem')) {
      continue;
    }
    const parts = line.split(/\s+/).filter((part) => part !== '');
    if (parts.length < 6) {
      continue;
    }
    const [fs, total, used, available, percentToken] = parts;
    const rest = parts.slice(5);
    if (!percentToken.endsWith('%')) {
      continue;
    }
    const percentValue = Number.parseInt(percentToken.replace(/%$/, ''), 10);
    if (!Number.isInteger(percentValue)) {
      continue;
    }
    mounts.push({
      fs,
      total,
      used,
      available,
      percent: percentValue,
      mountpoint: rest.join(' '),
    });
  }
  return mounts;
}

/**
 * Detect STORCLI. Tries `storcli` then `storcli64` via `command -v`, returning
 * the first path found (mirrors `_detect_storcli` exactly — the Python oracle
 * only probes these two bare binary names).
 */
export async function detectStorcli(
  runner: ProbeRunner,
  timeout: number,
): Promise<string | null> {
  for (const binary of ['storcli', 'storcli64']) {
    const result = await runner.run(`command -v ${binary}`, timeout);
    const lines = (result.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (result.exitStatus === 0 && lines.length > 0) {
      return lines[0];
    }
  }
  return null;
}

/**
 * Run the full field probe against a connected runner (mirrors `_run_probe`).
 * Field read order is fixed: hostname, os-release, kernel, cpu, memory, df.
 */
export async function runProbe(runner: ProbeRunner, timeout: number): Promise<ProbeResult> {
  const warnings: string[] = [];

  const hostname = await readField(runner, 'hostname', timeout, warnings, '主机名');
  const osReleaseText = await readField(
    runner,
    'cat /etc/os-release',
    timeout,
    warnings,
    '系统版本',
  );
  const kernel = await readField(runner, 'uname -r', timeout, warnings, '内核版本');
  const cpuText = await readField(runner, 'nproc', timeout, warnings, 'CPU 核数');
  const memoryText = await readField(runner, 'free -m', timeout, warnings, '内存信息');
  const dfText = await readField(runner, 'df -hP', timeout, warnings, '磁盘挂载');

  const storcliPath = await detectStorcli(runner, timeout);
  const storcliAvailable = storcliPath !== null;
  let sudoAvailable = false;

  if (storcliPath !== null) {
    try {
      const sudoResult =
        typeof runner.runSudo === 'function'
          ? await runner.runSudo.call(runner, `${storcliPath} -v`, timeout)
          : await runner.run(`sudo -n ${storcliPath} -v`, timeout);
      sudoAvailable = sudoResult.exitStatus === 0;
    } catch (error) {
      if (error instanceof SudoAuthError || error instanceof SudoUnavailable) {
        sudoAvailable = false;
      } else {
        throw error;
      }
    }
    if (!sudoAvailable) {
      warnings.push(SUDO_WARNING);
    }
  } else {
    warnings.push(STORCLI_WARNING);
  }

  return {
    ok: true,
    status: 'ok',
    message: '连接成功',
    hostname,
    osRelease: parseOsRelease(osReleaseText),
    kernel,
    cpuCores: parseInteger(cpuText),
    memoryTotalMb: parseMemoryTotal(memoryText),
    mounts: parseDf(dfText),
    storcliAvailable,
    storcliPath,
    sudoAvailable,
    warnings,
  };
}

/** Build a failure result with all other fields at their Python defaults. */
export function failureResult(status: string, message: string): ProbeResult {
  return {
    ok: false,
    status,
    message,
    hostname: null,
    osRelease: null,
    kernel: null,
    cpuCores: null,
    memoryTotalMb: null,
    mounts: [],
    storcliAvailable: false,
    storcliPath: null,
    sudoAvailable: false,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const AUTH_PATTERN =
  /all configured authentication methods failed|authentication failed|auth fail|invalid user|permission denied|no supported authentication/i;
const HOST_KEY_PATTERN =
  /host ?key|hostkey|host key verification failed|key mismatch|man-in-the-middle|remote host identification has changed/i;
const TIMEOUT_PATTERN = /timed ?out|timedout|timeout/i;
const SSH_PATTERN = /ssh|handshake|kex|banner|channel open|protocol (?:error|failure)|connection lost/i;
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'EPIPE',
  'EADDRNOTAVAIL',
]);
const CONNECTION_PATTERN =
  /econnrefused|connection refused|no route to host|network is unreachable|host (?:is )?unreachable|connection reset|connection closed|connect failed/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function errorName(error: unknown): string {
  const fromRecord = asRecord(error)?.['name'];
  if (typeof fromRecord === 'string') {
    return fromRecord;
  }
  return error instanceof Error ? error.name : '';
}

function errorCode(error: unknown): string {
  const code = asRecord(error)?.['code'];
  return typeof code === 'string' ? code : '';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  const message = asRecord(error)?.['message'];
  if (typeof message === 'string') {
    return message;
  }
  return String(error);
}

/**
 * Map an arbitrary thrown value to a {@link ProbeResult} failure, mirroring the
 * Python `probe_host` exception ladder. Because Node has no single ssh library
 * exception hierarchy, classification uses `instanceof` for our own error
 * classes and otherwise `error.name` / `error.code` / `error.message`:
 *
 *   1. auth        — name contains "Authentication" (or an auth message)
 *   2. host key    — `HostKeyMismatch` or a host-key message
 *   3. timeout     — name/code ETIMEDOUT/TimeoutError or a timeout message
 *   4. ssh_error   — name contains "SSH" or an SSH-protocol message
 *   5. connection  — a connection error code (ECONNREFUSED, ...) or message
 *   6. error       — everything else
 */
export function mapProbeError(error: unknown): ProbeResult {
  const name = errorName(error);
  const code = errorCode(error);
  const message = errorMessage(error);

  const isAuth = /Authentication/i.test(name) || AUTH_PATTERN.test(message);
  const isHostKey =
    error instanceof HostKeyMismatch || HOST_KEY_PATTERN.test(name) || HOST_KEY_PATTERN.test(message);
  const isTimeout =
    code === 'ETIMEDOUT' ||
    /TimeoutError|TimedOut/i.test(name) ||
    TIMEOUT_PATTERN.test(message);
  const isSsh = /SSH/i.test(name) || SSH_PATTERN.test(message);
  const isConnection = CONNECTION_CODES.has(code) || CONNECTION_PATTERN.test(message);

  if (isAuth) {
    return failureResult('auth_failed', AUTH_MESSAGE);
  }
  if (isHostKey) {
    return failureResult('host_key_failed', HOST_KEY_MESSAGE);
  }
  if (isTimeout) {
    return failureResult('timeout', TIMEOUT_MESSAGE);
  }
  if (isSsh) {
    return failureResult('ssh_error', `SSH 连接失败：${message}`);
  }
  if (isConnection) {
    return failureResult('connection_failed', REFUSED_MESSAGE);
  }
  return failureResult('error', `探测失败：${message}`);
}

// ---------------------------------------------------------------------------
// Default runner factory (adapts SshClient to ProbeRunner)
// ---------------------------------------------------------------------------

function readSudoPassword(candidate: ProbeCandidate): string {
  if (typeof candidate.sudoPassword === 'string') {
    return candidate.sudoPassword;
  }
  const legacy = candidate['sudo_password'];
  return typeof legacy === 'string' ? legacy : '';
}

export function buildConnectConfig(
  candidate: ProbeCandidate,
  timeout: number,
): SshConnectConfig {
  return {
    host: candidate.host,
    port: typeof candidate.port === 'number' ? candidate.port : 22,
    username: typeof candidate.username === 'string' ? candidate.username : '',
    password: candidate.password,
    privateKey: candidate.privateKey,
    privateKeyPath: candidate.privateKeyPath,
    keyPassphrase: candidate.keyPassphrase,
    connectTimeoutSec: timeout,
    hostKeyPolicy: 'insecure',
  };
}

/**
 * Build a {@link ProbeRunner} backed by a real {@link SshClient}. SSH is only
 * actually opened when `run`/`runSudo` is invoked (constructing the client does
 * not connect).
 */
export function defaultRunnerFactory(
  candidate: ProbeCandidate,
  timeout: number = DEFAULT_TIMEOUT,
): ProbeRunner {
  const client = new SshClient(buildConnectConfig(candidate, timeout));
  const sudoPassword = readSudoPassword(candidate);
  return {
    run: (command, timeoutMs) => client.run(command, timeoutMs),
    runSudo: (command, timeoutMs) => client.runSudo(command, sudoPassword, timeoutMs),
    close: () => client.close(),
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Probe a candidate host end-to-end. Mirrors `probe_host`:
 *
 *   - build a runner via `opts.sshFactory` (or `SshClient`);
 *   - run the field probe;
 *   - map any thrown connection/auth error to a stable failure result;
 *   - always close the runner.
 */
export async function probeHost(
  candidate: ProbeCandidate,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const timeout = typeof opts.timeout === 'number' ? opts.timeout : DEFAULT_TIMEOUT;
  const factory = opts.sshFactory ?? ((target: ProbeCandidate) => defaultRunnerFactory(target, timeout));

  let runner: ProbeRunner | null = null;
  try {
    runner = factory(candidate);
    return await runProbe(runner, timeout);
  } catch (error) {
    return mapProbeError(error);
  } finally {
    if (runner !== null) {
      try {
        runner.close?.();
      } catch {
        // Never let a close failure mask the probe outcome.
      }
    }
  }
}
