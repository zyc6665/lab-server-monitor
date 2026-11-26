/**
 * Host user collection + persistence orchestration — a 1:1 port of
 * `servermanage/user_collection.py:48-420` (the collection/persistence layer).
 *
 * The module walks every *user-monitoring-enabled* host, runs
 * {@link collectHostUsers} (the `user_scan` port), normalises the returned
 * accounts against the previous snapshot, and persists the result through the
 * P1 storage layer (`../storage/users`). A host whose scan throws keeps its
 * previous snapshot/baseline and only gets a `last_error` recorded.
 *
 * ### Python -> Node mapping
 *
 * - `is_user_monitoring_enabled` -> {@link isUserMonitoringEnabled}
 * - `_utc` / `_parse_iso`         -> {@link toUtcDate} / {@link parseIsoDate}
 * - `_usage_is_stale`             -> {@link usageIsStale}
 * - `_account_from_baseline`      -> {@link accountFromBaseline}
 * - `_persist_failure`            -> internal `persistFailure`
 * - `_close_runner`               -> internal `closeRunner`
 * - `_scan_host`                  -> internal `scanHost`
 * - `run_user_scan`               -> {@link runUserScan}
 *
 * ### Deliberate differences from the Python oracle
 *
 * 1. `runUserScan` has no `engine` parameter (the task's signature omits it), so
 *    the alert-engine reconciliation in `_scan_host`'s normal branch
 *    (`engine.process` / `engine.resolve_missing`) is not performed. Snapshot,
 *    baseline, usage-history and scan-state writes are unchanged; only the
 *    `user-*` alert event emission is missing and is expected to live in a
 *    separate alert stage.
 * 2. The Node `AppConfig` has no `user_monitoring` / `ssh` section, so those
 *    effective settings are read from the settings store via
 *    `loadEffectiveSettings(db)` (same source `composition.ts` uses).
 * 3. `db` is a long-lived `better-sqlite3` handle (passed by the caller) rather
 *    than a `db_path` reopened per call, matching the rest of the Node storage
 *    layer.
 * 4. Concurrency is expressed with async worker lanes instead of a Python
 *    `ThreadPoolExecutor`; the cap (`max(1, min(4, hosts))`) is identical.
 */
import type { AppConfig, HostConfig } from '../config/config';
import { loadEffectiveSettings } from '../config/service';
import type { CommandResult, HostUserAccount } from '../collect/types';
import { hostToSshConnectConfig } from '../collect/collectors';
import { SshClient } from '../collect/ssh-client';
import { nowIsoUtc } from '../storage/time';
import {
  appendUserUsageHistory,
  getHostUserSnapshot,
  getUserScanState,
  saveHostUserScanResult,
  saveUserScanState,
  type UserAccountInput,
  type UserRow,
} from '../storage/users';
import {
  collectHostUsers,
  type CollectHostUsersOptions,
  type CollectHostUsersResult,
  type KnownUsage,
  type UsageProgress,
  type UserScanRunner,
} from './scan';

type SqliteDatabase = import('better-sqlite3').Database;

/** Effective `user_monitoring` settings consumed by the collector. */
export interface UserMonitoringConfig {
  /** Whether user monitoring is globally enabled. */
  enabled: boolean;
  /** `scan_interval_seconds` (currently informational). */
  scanIntervalSeconds: number;
  /** `usage_interval_seconds` — drives the usage-due / known-usage windows. */
  usageIntervalSeconds: number;
  /** `usage_timeout_seconds` (or `null` for "no explicit cap"). */
  usageTimeoutSeconds: number | null;
  /** `command_timeout` — the scan command budget in seconds. */
  commandTimeout: number;
  /** `write_enabled` — advisory flag mirrored from settings. */
  writeEnabled: boolean;
}

/**
 * Final result of {@link runUserScan}. Field names are snake_case to stay
 * byte-compatible with the Python oracle's summary dict *and* with the P2
 * users route: `usageScanState` (users.ts) reads exactly `running`,
 * `hosts_done`, `hosts_total`, `started_at`, `current_host`,
 * `current_account`, `next_account`, `accounts_done`, `accounts_total`.
 */
export interface ScanSummary {
  hosts_total: number;
  hosts_done: number;
  hosts_failed: number;
  accounts: number;
  errors: Record<string, string>;
  started_at: string;
  finished_at: string;
  /** Always `false` once the run has settled. */
  running: boolean;
  current_host: string | null;
  current_account: string | null;
  next_account: string | null;
  accounts_done: number;
  accounts_total: number;
}

/** A single progress tick handed to the optional `progress` callback. */
export interface ScanProgressUpdate {
  hosts_total?: number;
  hosts_done?: number;
  hosts_failed?: number;
  accounts?: number;
  errors?: Record<string, string>;
  current_host?: string | null;
  current_account?: string | null;
  next_account?: string | null;
  accounts_done?: number;
  accounts_total?: number;
}

export type ScanProgress = (update: ScanProgressUpdate) => void;

/** The injectable host-scanner (defaults to {@link collectHostUsers}). */
export type HostUserScanner = (
  host: HostConfig,
  runner: UserScanRunner,
  options: CollectHostUsersOptions,
) => Promise<CollectHostUsersResult> | CollectHostUsersResult;

/** The injectable runner factory (defaults to a real `SshClient` runner). */
export type UserScanRunnerFactory = (
  host: HostConfig,
  connectTimeoutSec: number,
) => UserScanRunner & { close?: () => void | Promise<void> };

/** Options for {@link runUserScan}. */
export interface RunUserScanOptions {
  db: SqliteDatabase;
  config: Pick<AppConfig, 'servers'>;
  /** Overrides `config.servers` (still filtered by monitoring-enabled). */
  hosts?: readonly HostConfig[];
  /** Overrides the scan function (tests inject a fake). */
  runScan?: HostUserScanner;
  /** Fixed "now" instant; defaults to the current wall clock. */
  now?: Date | string | null;
  /** Overrides the runner factory (tests inject a stub). */
  runnerFactory?: UserScanRunnerFactory;
  /** Ignore the interval and force a fresh usage measurement. */
  forceUsage?: boolean;
  /** Optional live progress sink. */
  progress?: ScanProgress | null;
}

// ---------------------------------------------------------------------------
// Time helpers (`_utc` / `_parse_iso`)
// ---------------------------------------------------------------------------

/**
 * Parses an ISO-8601 string into a `Date`. A value without an explicit offset
 * is treated as UTC (mirrors Python's naive-datetime handling in `_utc`).
 * Returns `null` for non-strings, empty strings, and unparseable input —
 * exactly like `_parse_iso`.
 */
export function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const hasOffset = /(?:z|[+-]\d{2}:?\d{2})$/i.test(text);
  const milliseconds = Date.parse(hasOffset ? text : `${text}Z`);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

/** Port of `_utc`: `null` -> now, `Date` clone, string parsed (UTC default). */
function toUtcDate(value: Date | string | null | undefined): Date {
  if (value === null || value === undefined) return new Date();
  if (value instanceof Date) return new Date(value.getTime());
  return parseIsoDate(value) ?? new Date();
}

// ---------------------------------------------------------------------------
// `_usage_is_stale`
// ---------------------------------------------------------------------------

/**
 * Port of `_usage_is_stale`. Usage is stale when it was not refreshed this run,
 * unless a refresh actually landed; a missing baseline is stale; a forced/due
 * round is stale; otherwise it goes stale once the age exceeds `interval * 1.5`.
 */
export function usageIsStale(
  now: Date,
  lastUsage: Date | null,
  intervalSeconds: number,
  usageRefreshed: boolean,
  options: { usageDue?: boolean } = {},
): boolean {
  if (usageRefreshed) return false;
  if (lastUsage === null) return true;
  if (options.usageDue) return true;
  return (now.getTime() - lastUsage.getTime()) / 1000 > intervalSeconds * 1.5;
}

// ---------------------------------------------------------------------------
// `is_user_monitoring_enabled`
// ---------------------------------------------------------------------------

/**
 * Port of `is_user_monitoring_enabled`: a host-level `user_monitoring` boolean
 * wins over the global switch; `undefined`/missing inherits the global value.
 */
export function isUserMonitoringEnabled(
  host: Pick<HostConfig, 'user_monitoring'>,
  config: { user_monitoring: { enabled: boolean } },
): boolean {
  if (typeof host.user_monitoring === 'boolean') return host.user_monitoring;
  return Boolean(config.user_monitoring.enabled);
}

// ---------------------------------------------------------------------------
// Settings readers
// ---------------------------------------------------------------------------

/** Coerces a loose settings value to a truncated integer with a fallback. */
function toInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/** Reads the effective `user_monitoring` section into typed config. */
function readUserMonitoringConfig(raw: Record<string, unknown>): UserMonitoringConfig {
  return {
    enabled: raw.enabled !== false,
    scanIntervalSeconds: toInt(raw.scan_interval_seconds, 3600),
    usageIntervalSeconds: toInt(raw.usage_interval_seconds, 259200),
    usageTimeoutSeconds:
      raw.usage_timeout_seconds === null || raw.usage_timeout_seconds === undefined
        ? null
        : toInt(raw.usage_timeout_seconds, 1800),
    commandTimeout: toInt(raw.command_timeout, 120),
    writeEnabled: raw.write_enabled === true,
  };
}

interface SshRuntimeSettings {
  connectTimeoutSec: number;
  hostKeyPolicy: string | undefined;
}

/** Reads the bits of `ssh.*` the runner factory needs. */
function readSshSettings(raw: Record<string, unknown>): SshRuntimeSettings {
  const connect = Number(raw.connect_timeout);
  return {
    connectTimeoutSec: Number.isFinite(connect) && connect > 0 ? connect : 10,
    hostKeyPolicy: typeof raw.host_key_policy === 'string' ? raw.host_key_policy : undefined,
  };
}

// ---------------------------------------------------------------------------
// Runner helpers (`_close_runner` + the default SSH runner factory)
// ---------------------------------------------------------------------------

/** Builds the production runner factory over a fresh {@link SshClient}. */
type UserScanClientLike = {
  run(command: string, timeoutMs: number): Promise<CommandResult>;
  runSudo(command: string, password: string, timeoutMs: number): Promise<CommandResult>;
  close(): void;
};

export function createUserScanRunnerFactory(
  ssh: SshRuntimeSettings,
  makeClient: (cfg: ReturnType<typeof hostToSshConnectConfig>) => UserScanClientLike = (cfg) => new SshClient(cfg),
): UserScanRunnerFactory {
  return (host, connectTimeoutSec) => {
    const cfg = hostToSshConnectConfig(host, connectTimeoutSec, ssh.hostKeyPolicy);
    const client = makeClient(cfg);
    const sudo = host.sudo_password;
    return {
      // The user-scan/admin protocol passes timeouts in whole seconds (Python
      // oracle semantics); the SSH client expects milliseconds.
      run: (command, timeoutSeconds) => client.run(command, timeoutSeconds * 1000),
      runSudo: (command, timeoutSeconds) =>
        client.runSudo(command, typeof sudo === 'string' ? sudo : '', timeoutSeconds * 1000),
      close: () => {
        client.close();
      },
    };
  };
}

/** Port of `_close_runner`: best-effort, never throws. */
async function closeRunner(
  runner: UserScanRunner & { close?: () => void | Promise<void> },
): Promise<void> {
  const close = runner.close;
  if (typeof close !== 'function') return;
  try {
    await close.call(runner);
  } catch (error) {
    console.error('关闭用户扫描连接失败', error);
  }
}

// ---------------------------------------------------------------------------
// `_persist_failure`
// ---------------------------------------------------------------------------

/**
 * Port of `_persist_failure`: records `last_error` on the scan state and leaves
 * the snapshot/baseline untouched. Failures here are swallowed.
 */
function persistFailure(db: SqliteDatabase, hostName: string, message: string): void {
  try {
    saveUserScanState(db, hostName, { lastError: message });
  } catch (error) {
    console.error(`记录主机 ${hostName} 用户扫描失败状态时出错`, error);
  }
}

// ---------------------------------------------------------------------------
// `_account_from_baseline`
// ---------------------------------------------------------------------------

/** Coerces a loose value to a string, mapping null/undefined to `''`. */
function strOrEmpty(value: unknown): string {
  if (typeof value === 'string') return value;
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Port of `_account_from_baseline`: reconstructs a `HostUserAccount` for a
 * baseline row that is no longer present. `state` is `"missing"` and usage
 * metadata defaults to "not measured".
 */
export function accountFromBaseline(
  hostName: string,
  row: UserRow,
  now: string,
): HostUserAccount {
  return {
    hostName,
    username: String(row.username),
    uid: toInt(row.uid, 0),
    gid: toInt(row.gid, 0),
    primaryGroup: (row.primary_group as string | null | undefined) ?? null,
    gecos: strOrEmpty(row.gecos),
    home: strOrEmpty(row.home),
    shell: strOrEmpty(row.shell),
    groups: Array.isArray(row.groups) ? row.groups.map((group) => String(group)) : [],
    inDocker: Boolean(row.in_docker),
    inSudo: Boolean(row.in_sudo),
    homeExists: Boolean(row.home_exists),
    homeOwner: (row.home_owner as string | null | undefined) ?? null,
    homeGroup: (row.home_group as string | null | undefined) ?? null,
    homeMode: (row.home_mode as string | null | undefined) ?? null,
    homeSizeBytes: (row.home_size_bytes as number | null | undefined) ?? null,
    dataExists: Boolean(row.data_exists),
    dataOwner: (row.data_owner as string | null | undefined) ?? null,
    dataGroup: (row.data_group as string | null | undefined) ?? null,
    dataMode: (row.data_mode as string | null | undefined) ?? null,
    dataSizeBytes: (row.data_size_bytes as number | null | undefined) ?? null,
    dataSupported: Boolean(row.data_supported),
    usageReadable: Boolean(row.usage_readable),
    usageStale: Boolean(row.usage_stale),
    usageCollectedAt: typeof row.usage_collected_at === 'string' ? row.usage_collected_at : null,
    collectedAt: now,
    state: 'missing',
  };
}

// ---------------------------------------------------------------------------
// HostUserAccount -> UserAccountInput (asdict equivalent)
// ---------------------------------------------------------------------------

/** Converts the scan result's camelCase account into the snake_case storage row. */
function accountToInput(account: HostUserAccount): UserAccountInput {
  return {
    username: account.username,
    uid: account.uid,
    gid: account.gid,
    primary_group: account.primaryGroup,
    gecos: account.gecos,
    home: account.home,
    shell: account.shell,
    groups: account.groups,
    in_docker: account.inDocker,
    in_sudo: account.inSudo,
    home_exists: account.homeExists,
    home_owner: account.homeOwner,
    home_group: account.homeGroup,
    home_mode: account.homeMode,
    home_size_bytes: account.homeSizeBytes,
    data_exists: account.dataExists,
    data_owner: account.dataOwner,
    data_group: account.dataGroup,
    data_mode: account.dataMode,
    data_size_bytes: account.dataSizeBytes,
    data_supported: account.dataSupported,
    usage_stale: account.usageStale,
    usage_readable: account.usageReadable,
    usage_collected_at: account.usageCollectedAt,
    collected_at: account.collectedAt,
  };
}

// ---------------------------------------------------------------------------
// `_scan_host`
// ---------------------------------------------------------------------------

interface ScanHostParams {
  db: SqliteDatabase;
  host: HostConfig;
  monitoring: UserMonitoringConfig;
  runner: UserScanRunner;
  scan: HostUserScanner;
  moment: Date;
  momentIso: string;
  forceUsage: boolean;
  reportProgress: ScanProgress | null;
}

/**
 * Port of `_scan_host`: decides whether usage is due, seeds known usage,
 * invokes the scanner, normalises the accounts against the previous snapshot,
 * and persists the outcome. Returns the normalised accounts.
 */
async function scanHost(params: ScanHostParams): Promise<HostUserAccount[]> {
  const { db, host, monitoring, runner, scan, moment, momentIso, forceUsage, reportProgress } =
    params;
  const interval = monitoring.usageIntervalSeconds;

  const lastState = getUserScanState(db, host.name);
  const lastUsage = parseIsoDate(lastState ? lastState.last_usage_at : null);
  const usageDue =
    forceUsage
    || lastUsage === null
    || moment.getTime() - lastUsage.getTime() >= interval * 1000;

  const previousRows = getHostUserSnapshot(db, host.name);
  const previousByName = new Map<string, UserRow>();
  for (const row of previousRows) {
    previousByName.set(String(row.username), row);
  }

  // Only recent measurements can seed `known_usage` (avoid re-measuring a
  // still-fresh size, but never trust one older than one interval).
  const knownUsage: Record<string, KnownUsage> = {};
  const freshAfter = moment.getTime() - interval * 1000;
  for (const row of previousRows) {
    const username = String(row.username);
    const collected = parseIsoDate(row.usage_collected_at);
    if (collected === null || collected.getTime() < freshAfter) continue;
    const home = row.home_size_bytes as number | null | undefined;
    const data = row.data_size_bytes as number | null | undefined;
    if ((home === null || home === undefined) && (data === null || data === undefined)) {
      continue;
    }
    knownUsage[username] = {
      home: home ?? null,
      data: data ?? null,
      at: typeof row.usage_collected_at === 'string' ? row.usage_collected_at : null,
    };
  }

  const usageProgress: UsageProgress = (name, index, total, upcoming) => {
    if (!reportProgress) return;
    reportProgress({
      current_host: host.name,
      current_account: name,
      next_account: upcoming,
      accounts_done: index,
      accounts_total: total,
    });
  };

  const result = await scan(host, runner, {
    now: momentIso,
    usageDue,
    commandTimeout: monitoring.commandTimeout,
    usageTimeout: monitoring.usageTimeoutSeconds,
    sudoAvailable: Boolean(host.sudo_password),
    knownUsage,
    usageProgress,
  });

  const firstScan = lastState === null || !lastState.last_scan_at;
  const stale = usageIsStale(moment, lastUsage, interval, result.usageRefreshed, { usageDue });

  // Normalise: never let an unmeasured account erase a size we already know.
  const normalized: HostUserAccount[] = [];
  for (const account of result.accounts) {
    const previous = previousByName.get(account.username);
    let homeSize = account.homeSizeBytes;
    if (homeSize === null || homeSize === undefined) {
      homeSize = (previous?.home_size_bytes as number | null | undefined) ?? null;
    }
    let dataSize = account.dataSizeBytes;
    if (dataSize === null || dataSize === undefined) {
      dataSize = (previous?.data_size_bytes as number | null | undefined) ?? null;
    }
    let usageCollectedAt = account.usageCollectedAt;
    if (usageCollectedAt === null || usageCollectedAt === undefined) {
      const previousAt = previous ? parseIsoDate(previous.usage_collected_at) : null;
      const chosen = previousAt ?? lastUsage;
      usageCollectedAt = chosen ? nowIsoUtc(chosen) : null;
    }
    normalized.push({
      ...account,
      homeSizeBytes: homeSize,
      dataSizeBytes: dataSize,
      usageReadable: Boolean(result.usageReadable),
      usageStale: stale,
      usageCollectedAt,
    });
  }

  const inputs = normalized.map(accountToInput);

  if (firstScan) {
    // First scan is silent: seed the baseline without emitting alerts.
    saveHostUserScanResult(db, host.name, inputs, {
      now: moment,
      usageRefreshed: result.usageRefreshed,
      seedOnly: true,
    });
    appendUserUsageHistory(db, host.name, inputs, { now: moment });
    return normalized;
  }

  saveHostUserScanResult(db, host.name, inputs, {
    now: moment,
    usageRefreshed: result.usageRefreshed,
  });
  appendUserUsageHistory(db, host.name, inputs, { now: moment });
  // Alert-engine reconciliation (Python's `engine.process` / `resolve_missing`)
  // is intentionally omitted — see the module-level "deliberate differences".
  return normalized;
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/** Runs `worker` over `items` with at most `limit` concurrent lanes. */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const lanes = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const runners = Array.from({ length: lanes }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// `run_user_scan`
// ---------------------------------------------------------------------------

/**
 * Port of `run_user_scan`: scans every user-monitoring-enabled host and
 * persists the results. Never rejects for individual host failures — those are
 * recorded in `errors` and counted in `hosts_failed`.
 */
export async function runUserScan(options: RunUserScanOptions): Promise<ScanSummary> {
  const { db } = options;
  const scan = options.runScan ?? collectHostUsers;
  const moment = toUtcDate(options.now ?? null);
  const momentIso = nowIsoUtc(moment);
  const startedAt = momentIso;
  const forceUsage = options.forceUsage === true;

  const settings = loadEffectiveSettings(db);
  const monitoring = readUserMonitoringConfig(settings.user_monitoring);
  const ssh = readSshSettings(settings.ssh);
  const runnerFactory = options.runnerFactory ?? createUserScanRunnerFactory(ssh);

  const monitoringSnapshot = { user_monitoring: { enabled: monitoring.enabled } };
  const candidates = options.hosts ? [...options.hosts] : [...options.config.servers];
  const hosts = candidates.filter((host) => isUserMonitoringEnabled(host, monitoringSnapshot));

  const progress = options.progress ?? null;
  let hostsDone = 0;
  let hostsFailed = 0;
  let accountsTotal = 0;
  const errors: Record<string, string> = {};

  const reportHostProgress = (): void => {
    if (!progress) return;
    progress({
      hosts_total: hosts.length,
      hosts_done: hostsDone,
      hosts_failed: hostsFailed,
      accounts: accountsTotal,
      errors: { ...errors },
    });
  };

  const reportAccountProgress: ScanProgress = (update) => {
    if (!progress) return;
    progress({
      hosts_total: hosts.length,
      hosts_done: hostsDone,
      hosts_failed: hostsFailed,
      accounts: accountsTotal,
      errors: { ...errors },
      ...update,
    });
  };

  reportHostProgress();

  const worker = async (host: HostConfig): Promise<void> => {
    let runner: (UserScanRunner & { close?: () => void | Promise<void> }) | null = null;
    try {
      runner = runnerFactory(host, ssh.connectTimeoutSec);
      const scanned = await scanHost({
        db,
        host,
        monitoring,
        runner,
        scan,
        moment,
        momentIso,
        forceUsage,
        reportProgress: progress ? reportAccountProgress : null,
      });
      hostsDone += 1;
      accountsTotal += scanned.length;
      reportHostProgress();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      persistFailure(db, host.name, message);
      hostsFailed += 1;
      errors[host.name] = message;
      reportHostProgress();
    } finally {
      if (runner) await closeRunner(runner);
    }
  };

  await runWithConcurrency(hosts, Math.max(1, Math.min(4, hosts.length)), worker);

  return {
    hosts_total: hosts.length,
    hosts_done: hostsDone,
    hosts_failed: hostsFailed,
    accounts: accountsTotal,
    errors,
    started_at: startedAt,
    finished_at: nowIsoUtc(),
    running: false,
    current_host: null,
    current_account: null,
    next_account: null,
    accounts_done: accountsTotal,
    accounts_total: accountsTotal,
  };
}
