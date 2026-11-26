/**
 * Collection orchestration — 1:1 TypeScript port of `servermanage/collectors.py`.
 *
 * Two entry points:
 * - {@link collectHostReport} drives one host over a single runner: it executes
 *   every stage of the command map in order, records per-stage failures as
 *   `HostCollectionError`s (non-fatal), and returns a fully parsed `HostReport`.
 *   An ssh exception aborts the host; a parser exception is reported as
 *   `stage: 'parse'`.
 * - {@link collectAllHosts} fans out over `config.servers`, honouring
 *   `config.app.concurrency` with a small order-preserving pool and always
 *   closing each runner.
 *
 * Deliberate divergences from the Python oracle (also noted in the task report):
 * - The Python `parse_results(results, host)` receives the raw command results
 *   and applies the `host.name` hostname fallback itself. The ported
 *   `parseHostMetrics(raw)` only receives successful-stage **stdout strings**,
 *   so this layer applies the `host.name` fallback and the `collectedAt` stamp.
 * - `runHostChecks` is an injectable dependency. Availability checks live in a
 *   later migration (P4); when the dependency is not supplied this layer returns
 *   `checks: []` instead of importing `availability`.
 * - Timeout units: the config `ssh.command_timeout` is in seconds (as in the
 *   Python config), while the ported `SshClient.run` takes **milliseconds**, so
 *   {@link collectAllHosts} converts it (`* 1000`) before calling a runner.
 *   `connectTimeout` stays in seconds because it feeds `SshConnectConfig.connectTimeoutSec`.
 */

import type { HostConfig } from '../config/config';
import { nowIsoUtc } from '../storage/time';
import type { Stage } from './commands';
import { buildCommandMap as defaultBuildCommandMap } from './commands';
import { parseHostMetrics as defaultParseHostMetrics } from './parsers';
import { SshClient } from './ssh-client';
import type { HostKeyPolicy, SshConnectConfig } from './ssh-client';
import { emptyHostMetrics } from './types';
import type {
  CommandResult,
  HostCheckResult,
  HostCollectionError,
  HostMetrics,
  HostReport,
} from './types';

// ---------------------------------------------------------------------------
// Configuration / dependency-injection surface
// ---------------------------------------------------------------------------

const DEFAULT_CONNECT_TIMEOUT_SEC = 10;
const DEFAULT_COMMAND_TIMEOUT_SEC = 20;

/**
 * Structural view of the `ssh` settings section (`config/service.ts`
 * `publicSettings().ssh`). Optional on {@link CollectorConfig} so the existing
 * `AppConfig` (which carries neither `ssh` nor `app`) remains assignable.
 */
export interface CollectorSshConfig {
  connect_timeout: number;
  command_timeout: number;
  host_key_policy?: string;
}

/** Structural view of the `app` runtime section. */
export interface CollectorAppConfig {
  concurrency?: number | null;
}

/**
 * The subset of the application config `collectAllHosts` needs. Mirrors the
 * Python `AppConfig` fields used by `collect_all_hosts`
 * (`config.servers`, `config.ssh.connect_timeout/command_timeout`,
 * `config.app.concurrency`).
 */
export interface CollectorConfig {
  servers: HostConfig[];
  ssh?: CollectorSshConfig | null;
  app?: CollectorAppConfig | null;
}

/** Minimal runner surface a host is collected through (real or fake). */
export interface CollectorRunner {
  run(command: string, timeoutMs: number): Promise<CommandResult> | CommandResult;
  close?(): void;
  /** Optional writable dial timeout (seconds), assigned by `collectHostReport`. */
  connectTimeout?: number;
}

/** Injected availability-check runner (migrated in P4; absent here). */
export type RunHostChecks = (
  host: HostConfig,
  runner: CollectorRunner,
  checks: HostConfig['checks'],
  commandTimeout: number,
) => Promise<HostCheckResult[]> | HostCheckResult[];

/** Options for {@link collectHostReport} (mirrors Python keyword arguments). */
export interface CollectHostOptions {
  connectTimeout: number;
  commandTimeout: number;
  buildCommandMap?: () => Record<Stage, string>;
  parseResults?: (raw: Partial<Record<Stage, string>>) => HostMetrics;
  runHostChecks?: RunHostChecks;
}

/** Builds a runner for one host; receives the config connect timeout (seconds). */
export type RunnerFactory = (
  host: HostConfig,
  connectTimeout: number,
) => Promise<CollectorRunner> | CollectorRunner;

/** Options for {@link collectAllHosts}. */
export interface CollectAllOptions {
  buildRunner?: RunnerFactory;
  buildCommandMap?: () => Record<Stage, string>;
  parseResults?: (raw: Partial<Record<Stage, string>>) => HostMetrics;
  runHostChecks?: RunHostChecks;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Port of `_result_failed`: `exit_status != 0`; `undefined`/`null` also fail. */
function resultFailed(result: CommandResult | null | undefined): boolean {
  return result == null || result.exitStatus !== 0;
}

/** Port of `str(exc)` for a thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A failure `HostReport` that keeps the exact errors accumulated so far. */
function reportWithErrors(host: HostConfig, errors: HostCollectionError[]): HostReport {
  return {
    hostName: host.name,
    host: host.host,
    success: false,
    metrics: emptyHostMetrics(),
    errors,
    checks: [],
    users: [],
  };
}

/** Convenience wrapper for a single-stage failure report. */
function failureReport(host: HostConfig, stage: string, message: string): HostReport {
  return reportWithErrors(host, [{ stage, message }]);
}

/**
 * Port of the `if getattr(ssh_runner, "connect_timeout", None) is not None: ...
 * except Exception: pass` block: only assign when the attribute already exists
 * and is not `None`, and swallow assignment errors (e.g. readonly property).
 */
function assignConnectTimeout(runner: CollectorRunner, connectTimeout: number): void {
  const target = runner as { connectTimeout?: number | null };
  if (target.connectTimeout === undefined || target.connectTimeout === null) {
    return;
  }
  try {
    target.connectTimeout = connectTimeout;
  } catch {
    // Best-effort, matching Python's `except Exception: pass`.
  }
}

/** Normalise an arbitrary `host_key_policy` string to a valid policy. */
function toHostKeyPolicy(value: string | undefined): HostKeyPolicy {
  return value === 'strict' || value === 'insecure' || value === 'tofu' ? value : 'tofu';
}

/** Port of `SSHClientWrapper._build_connect_kwargs` onto {@link SshConnectConfig}. */
export function hostToSshConnectConfig(
  host: HostConfig,
  connectTimeoutSec: number,
  hostKeyPolicy?: string,
): SshConnectConfig {
  const cfg: SshConnectConfig = {
    host: host.host,
    port: host.port,
    username: host.username,
    connectTimeoutSec,
    hostKeyPolicy: toHostKeyPolicy(hostKeyPolicy),
  };

  const auth = host.auth;
  if (auth.type === 'password') {
    if (auth.password != null) {
      cfg.password = auth.password;
    }
  } else if (auth.type === 'key') {
    if (auth.key_data) {
      cfg.privateKey = auth.key_data;
    } else if (auth.key_path) {
      cfg.privateKeyPath = auth.key_path;
    } else {
      throw new Error('SSH key is not configured');
    }
    if (auth.passphrase) {
      cfg.keyPassphrase = auth.passphrase;
    }
  }
  return cfg;
}

/** `max(1, config.app.concurrency ?? 1)`, tolerant of non-finite input. */
function resolveConcurrency(config: CollectorConfig): number {
  const configured = config.app?.concurrency ?? 1;
  const integer = Math.trunc(configured);
  if (!Number.isFinite(integer)) {
    return 1;
  }
  return Math.max(1, integer);
}

// ---------------------------------------------------------------------------
// Single-host collection
// ---------------------------------------------------------------------------

/**
 * Port of `collect_host_report`. Runs every stage sequentially over
 * `sshRunner`, records per-stage failures, parses the successful stdout, and
 * applies checks when injected.
 */
export async function collectHostReport(
  host: HostConfig,
  sshRunner: CollectorRunner,
  opts: CollectHostOptions,
): Promise<HostReport> {
  assignConnectTimeout(sshRunner, opts.connectTimeout);

  const commandMap = (opts.buildCommandMap ?? defaultBuildCommandMap)();
  const parseResults = opts.parseResults ?? defaultParseHostMetrics;

  const results = new Map<Stage, CommandResult>();
  const errors: HostCollectionError[] = [];

  for (const [stage, command] of Object.entries(commandMap) as Array<[Stage, string]>) {
    let result: CommandResult;
    try {
      result = await sshRunner.run(command, opts.commandTimeout);
    } catch (error) {
      // An ssh-layer exception aborts the whole host immediately.
      errors.push({ stage: 'ssh', message: errorMessage(error) });
      return reportWithErrors(host, errors);
    }

    results.set(stage, result);
    if (resultFailed(result)) {
      errors.push({ stage, message: result?.stderr || `command exited ${result?.exitStatus}` });
    }
  }

  // Only successful stages contribute their stdout to the parser.
  const raw: Partial<Record<Stage, string>> = {};
  for (const [stage, result] of results) {
    if (!resultFailed(result)) {
      raw[stage] = result.stdout;
    }
  }

  let metrics: HostMetrics;
  try {
    metrics = parseResults(raw);
  } catch (error) {
    errors.push({ stage: 'parse', message: errorMessage(error) });
    return reportWithErrors(host, errors);
  }

  if (!metrics.hostname) {
    metrics = { ...metrics, hostname: host.name };
  }
  if (!metrics.collectedAt) {
    metrics = { ...metrics, collectedAt: nowIsoUtc() };
  }

  let checks: HostCheckResult[] = [];
  if (opts.runHostChecks) {
    try {
      checks = (await opts.runHostChecks(host, sshRunner, host.checks, opts.commandTimeout)) ?? [];
    } catch (error) {
      // Availability checks are non-fatal: record and continue.
      errors.push({ stage: 'checks', message: errorMessage(error) });
      checks = [];
    }
  }

  return {
    hostName: host.name,
    host: host.host,
    success: !errors.some((error) => error.stage === 'ssh'),
    metrics,
    errors,
    checks,
    users: [],
  };
}

// ---------------------------------------------------------------------------
// Multi-host collection
// ---------------------------------------------------------------------------

/**
 * Order-preserving, dependency-free `p-limit` style pool: at most `limit`
 * invocations of `fn` run at once, and results keep the input order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R> | R,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) {
    return results;
  }

  const effectiveLimit = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length));
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: effectiveLimit }, () => worker()));
  return results;
}

/**
 * Port of `collect_all_hosts`. Collects every configured server, sequentially
 * when concurrency is 1 or there is a single host, otherwise via
 * {@link mapWithConcurrency}. Each runner is closed in `finally`; a factory or
 * collection exception becomes a per-host `stage: 'ssh'` failure.
 */
export async function collectAllHosts(
  config: CollectorConfig,
  opts: CollectAllOptions = {},
): Promise<HostReport[]> {
  const hosts = config.servers ?? [];
  if (hosts.length === 0) {
    return [];
  }

  const ssh = config.ssh ?? undefined;
  const connectTimeout = ssh?.connect_timeout ?? DEFAULT_CONNECT_TIMEOUT_SEC;
  // Config is seconds; the runner contract (`SshClient.run`) is milliseconds.
  const commandTimeout = (ssh?.command_timeout ?? DEFAULT_COMMAND_TIMEOUT_SEC) * 1000;

  const buildRunner: RunnerFactory =
    opts.buildRunner ??
    ((host, timeoutSec) =>
      new SshClient(hostToSshConnectConfig(host, timeoutSec, ssh?.host_key_policy)));
  const buildCommandMap = opts.buildCommandMap ?? defaultBuildCommandMap;
  const parseResults = opts.parseResults ?? defaultParseHostMetrics;
  const runHostChecks = opts.runHostChecks;

  const collectOne = async (host: HostConfig): Promise<HostReport> => {
    let runner: CollectorRunner | undefined;
    try {
      runner = await buildRunner(host, connectTimeout);
      return await collectHostReport(host, runner, {
        connectTimeout,
        commandTimeout,
        buildCommandMap,
        parseResults,
        runHostChecks,
      });
    } catch (error) {
      return failureReport(host, 'ssh', errorMessage(error));
    } finally {
      if (runner) {
        try {
          runner.close?.();
        } catch {
          // Mirror Python's best-effort `close()` in the `finally` block.
        }
      }
    }
  };

  const concurrency = resolveConcurrency(config);
  if (concurrency === 1 || hosts.length === 1) {
    const reports: HostReport[] = [];
    for (const host of hosts) {
      reports.push(await collectOne(host));
    }
    return reports;
  }

  return mapWithConcurrency(hosts, concurrency, (host) => collectOne(host));
}
