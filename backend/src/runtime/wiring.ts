/**
 * Scheduler wiring — Task 10 of the P4 scheduler/alerts/notify plan
 * (`docs/superpowers/plans/2026-11-25-p4-scheduler-alerts-notify-plan.md`).
 *
 * This module assembles the concrete {@link ScheduledTask}s the runtime
 * scheduler should run and, when a database + config are available, starts the
 * background {@link Scheduler} loop. It is the TypeScript analogue of
 * `servermanage/app.py::ServerMonitor._build_tasks` / `start` / `stop`
 * (`app.py:1094-1176`).
 *
 * Tasks registered (matching Task 10's interface):
 * - `collect` — interval `monitoring.poll_interval_seconds`; runs the P3
 *   `collectAllHosts` collection cycle and persists the resulting host reports
 *   through the P1 storage layer (`persistHostReports`, `saveHostSnapshot`,
 *   `saveHostCheckResults`). All collaborators are injectable through
 *   {@link SchedulerWiringDeps} so tests never touch SSH or the real clock.
 * - `daily-report` / `weekly-report` — calendar tasks driven by
 *   `report.daily_time` and `report.weekly.{time,weekday}`. They run the P5
 *   report pipeline: assemble (`report/assemble.ts`), render
 *   (`report/render.ts`), and email (`alerts/mailer.ts`). All three
 *   collaborators are injectable via {@link SchedulerWiringDeps}.
 * - `prune` — hourly (3600 s, mirroring the oracle `retention_cleanup`
 *   cadence) retention + log cleanup: `pruneRetention` from
 *   `storage/runtime.ts` and `cleanupLogs` from `runtime/maintenance.ts`.
 *
 * The oracle additionally registers `disk_poll` and `user_scan`; P5 Task 11b
 * wires those here as the `disk-poll` and `user-scan` tasks (see
 * {@link buildDiskPollTask} / {@link buildUserScanTask}). `disk-poll` always
 * runs (it self-skips when `disk_health.enabled` is false); `user-scan` is only
 * registered when at least one host opts into user monitoring, matching
 * `ServerMonitor._build_tasks`.
 */
import type { AppConfig, HostConfig } from '../config/config';
import { loadEffectiveSettings, type Settings } from '../config/service';
import {
  collectAllHosts as defaultCollectAllHosts,
  hostToSshConnectConfig,
  type CollectAllOptions,
  type CollectorConfig,
  type CollectorRunner,
  type RunHostChecks as CollectorRunHostChecks,
} from '../collect/collectors';
import { SshClient } from '../collect/ssh-client';
import {
  hottestTemperatureC,
  type HostCheckResult,
  type HostMetrics,
  type HostReport,
} from '../collect/types';
import {
  runHostChecks as defaultAvailabilityRunHostChecks,
  type CheckRunner,
} from './availability';
import { cleanupLogs as defaultCleanupLogs, type CleanupResult } from './maintenance';
import { Scheduler, type CalendarSpec, type ScheduledTask } from './scheduler';
import {
  persistHostReports,
  saveHostCheckResults,
  saveHostSnapshot,
  type HostCheckResultInput,
  type HostMetricsInput,
  type HostReportInput,
  type PersistHostReportsOptions,
} from '../storage/hosts';
import {
  pruneRetention as defaultPruneRetention,
  type RetentionConfig,
  type RetentionCounts,
} from '../storage/runtime';
import {
  buildDailyReport,
  DEFAULT_BUSY_THRESHOLD,
  DEFAULT_IDLE_THRESHOLD,
  DEFAULT_WEEKLY_SUBJECT_PREFIX,
  generateWeeklyReport,
  type WeeklyReportConfigLike,
} from '../report/assemble';
import {
  renderReport as defaultRenderReport,
  type ReportVariant,
} from '../report/render';
import type { DailyReport, RenderedReport, WeeklyReport } from '../report/model';
import {
  buildMessage,
  sendReport as defaultSendReport,
  type MailMessage,
  type SendReportOptions,
  type SmtpConfig,
} from '../alerts/mailer';
import { readSecretText } from '../config/admin';
import { SECRET_SMTP_PASSWORD } from '../config/secrets';
import {
  collectDiskHealth as defaultCollectDiskHealth,
  type CollectDiskHealthOptions,
  type DiskHealthCollectConfig,
  type DiskHealthRunner,
} from '../disk/collect';
import { diskReportFromSnapshot, type DiskHealthReport } from '../disk/report';
import {
  getDiskHealth,
  pruneDiskHealth as defaultPruneDiskHealth,
  saveDiskHealth as defaultSaveDiskHealth,
} from '../storage/disk';
import { evaluateDiskAlerts as defaultEvaluateDiskAlerts, type AlertEvent } from '../alerts/rules';
import {
  isUserMonitoringEnabled,
  runUserScan as defaultRunUserScan,
  type RunUserScanOptions,
  type ScanSummary,
} from '../users/collection';
import { getCollectionStatusRegistry } from './collection-status';

type SqliteDatabase = import('better-sqlite3').Database;

// ---------------------------------------------------------------------------
// Dependency-injection surface
// ---------------------------------------------------------------------------

/** Persists a batch of already-snake_cased host reports (defaults to storage). */
export type PersistReportsFn = (
  db: SqliteDatabase,
  reports: readonly HostReportInput[],
  options: PersistHostReportsOptions,
) => void;

/** Log-cleanup signature accepted by the `prune` task. */
export type CleanupLogsFn = (
  logDir: string,
  retentionHours?: number,
  now?: Date | null,
) => CleanupResult;

/** Renders a report to subject/text/html (`report/render.ts` `renderReport`). */
export type RenderReportFn = (
  report: DailyReport | WeeklyReport,
  variant: ReportVariant,
) => RenderedReport;

/** Delivers a rendered message (`alerts/mailer.ts` `sendReport`). */
export type SendReportFn = (
  smtp: SmtpConfig,
  message: MailMessage,
  options?: SendReportOptions,
) => Promise<void>;

/**
 * Optional collaborators for {@link buildScheduledTasks}. Every field defaults
 * to the real implementation; tests override the ones that would otherwise
 * touch SSH, the wall clock, or the filesystem.
 */
export interface SchedulerWiringDeps {
  /** Replacement for P3 `collectAllHosts` (tests stub out SSH entirely). */
  collectAllHosts?: (config: CollectorConfig, opts: CollectAllOptions) => Promise<HostReport[]>;
  /** Replacement for the storage persistence step of `collect`. */
  persistReports?: PersistReportsFn;
  /** Replacement for the P3 availability `runHostChecks` used during collect. */
  runHostChecks?: CollectorRunHostChecks;
  /** Replacement for `storage/runtime.ts` `pruneRetention`. */
  pruneRetention?: (
    db: SqliteDatabase,
    config: RetentionConfig | { app?: RetentionConfig },
    opts?: { now?: Date | string | null },
  ) => RetentionCounts;
  /** Replacement for `runtime/maintenance.ts` `cleanupLogs`. */
  cleanupLogs?: CleanupLogsFn;
  /** Replacement for `report/render.ts` `renderReport` (report tasks). */
  renderReport?: RenderReportFn;
  /** Replacement for `alerts/mailer.ts` `sendReport` (report tasks). */
  sendReport?: SendReportFn;
  /** Injectable clock (defaults to `() => new Date()`); used by `prune` + reports. */
  now?: () => Date;
  /** Replacement for the P5 `disk/collect.ts` `collectDiskHealth`. */
  collectDisk?: typeof defaultCollectDiskHealth;
  /** Builds an SSH-backed disk runner for one host (tests inject fake runners). */
  createDiskRunner?: (host: HostConfig) => DiskHealthRunner;
  /** Replacement for `storage/disk.ts` `saveDiskHealth`. */
  saveDisk?: (db: SqliteDatabase, report: DiskHealthReport) => void;
  /** Replacement for `alerts/rules.ts` `evaluateDiskAlerts`. */
  evaluateDisk?: (report: DiskHealthReport) => AlertEvent[];
  /** Replacement for `storage/disk.ts` `pruneDiskHealth`. */
  pruneDisk?: (
    db: SqliteDatabase,
    retentionDays?: number,
    maxBatchesPerHost?: number,
  ) => unknown;
  /** Alert engine used by `disk-poll` (defaults to a real `AlertEngine`). */
  diskAlertEngine?: DiskPollAlertEngine | null;
  /** Replacement for the P5 `users/collection.ts` `runUserScan`. */
  runUserScan?: (options: RunUserScanOptions) => Promise<ScanSummary>;
}

/**
 * Minimal alert-engine surface used by the `disk-poll` task: enough to deliver
 * disk events and account for recovered alerts. The production default is an
 * `alerts/engine.ts` `AlertEngine`; tests inject a fake.
 */
export interface DiskPollAlertEngine {
  process(events: AlertEvent[]): Promise<readonly AlertEvent[]> | readonly AlertEvent[];
  resolve_missing?(
    hostName: string,
    fingerprints: readonly string[],
    options?: { category?: string; notify?: boolean },
  ): unknown | Promise<unknown>;
}

/** Options for {@link buildScheduledTasks}. */
export interface BuildScheduledTasksOptions {
  db: SqliteDatabase;
  config: AppConfig;
  deps?: SchedulerWiringDeps;
}

/** Options for {@link startSchedulerIfConfigured}. */
export interface StartSchedulerOptions {
  db?: SqliteDatabase | null;
  config?: AppConfig | null;
  deps?: SchedulerWiringDeps;
}

/** Handle returned by {@link startSchedulerIfConfigured}. */
export interface SchedulerHandle {
  scheduler: Scheduler;
  /** Idempotent — safe to call more than once (e.g. from `close()`). */
  stop: () => void;
}

// ---------------------------------------------------------------------------
// Settings helpers (sections are `Record<string, unknown>` at this layer)
// ---------------------------------------------------------------------------

function asSection(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function section(settings: Settings, name: string): Record<string, unknown> {
  return asSection(settings[name]);
}

function readString(obj: Record<string, unknown>, key: string, fallback: string): string {
  const value = obj[key];
  return typeof value === 'string' ? value : fallback;
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readBoolean(obj: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = obj[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readStringArray(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

// ---------------------------------------------------------------------------
// Collect: config assembly + camelCase -> snake_case adaptation
// ---------------------------------------------------------------------------

/** Builds the P3 `CollectorConfig` from the app config + effective settings. */
export function buildCollectorConfig(
  config: AppConfig,
  settings: Settings,
): CollectorConfig {
  const ssh = section(settings, 'ssh');
  const monitoring = section(settings, 'monitoring');
  const hostKeyPolicy = readString(ssh, 'host_key_policy', '');
  return {
    servers: config.servers,
    ssh: {
      connect_timeout: readNumber(ssh, 'connect_timeout') ?? 10,
      command_timeout: readNumber(ssh, 'command_timeout') ?? 20,
      ...(hostKeyPolicy !== '' ? { host_key_policy: hostKeyPolicy } : {}),
    },
    app: { concurrency: readNumber(monitoring, 'concurrency') ?? null },
  };
}

/**
 * Adapts the P3 availability checker `(host, checks, runner, options)` to the
 * P3 collector hook `(host, runner, checks, commandTimeout)`. The collector's
 * runner is structurally a {@link CheckRunner} (`run(command, timeoutMs)`).
 */
function collectorRunHostChecks(
  host: Parameters<CollectorRunHostChecks>[0],
  runner: CollectorRunner,
  checks: Parameters<CollectorRunHostChecks>[2],
  commandTimeout: number,
): ReturnType<CollectorRunHostChecks> {
  const checkRunner: CheckRunner = {
    run: (command, timeoutMs) => runner.run(command, timeoutMs),
    ...(runner.close ? { close: () => runner.close?.() } : {}),
  };
  return defaultAvailabilityRunHostChecks(host, checks, checkRunner, {
    timeoutMs: commandTimeout,
  });
}

function toStorageCheck(result: HostCheckResult): HostCheckResultInput {
  return {
    name: result.name,
    type: result.type,
    target: result.target,
    status: result.status,
    message: result.message,
    latency_ms: result.latencyMs,
    checked_at: result.checkedAt,
  };
}

function toStorageMetrics(metrics: HostMetrics): HostMetricsInput {
  return {
    collected_at: metrics.collectedAt,
    cpu_usage_percent: metrics.cpuUsagePercent,
    memory: metrics.memory
      ? { used_mb: metrics.memory.usedMb, total_mb: metrics.memory.totalMb }
      : null,
    load_average: metrics.loadAverage
      ? {
          load_1: metrics.loadAverage.load1,
          load_5: metrics.loadAverage.load5,
          load_15: metrics.loadAverage.load15,
        }
      : null,
    disk_usage: (metrics.diskUsage ?? []).map((row) => ({
      filesystem: row.filesystem,
      size: row.size,
      used: row.used,
      available: row.available,
      percent: row.percent,
      mountpoint: row.mountpoint,
    })),
    gpu_summary: (metrics.gpuSummary ?? []).map((row) => ({
      utilization_percent: row.utilizationPercent,
      temperature_c: row.temperatureC,
      memory_used_mb: row.memoryUsedMb,
      memory_total_mb: row.memoryTotalMb,
    })),
    total_processes: metrics.totalProcesses,
    logged_in_users: (metrics.loggedInUsers ?? []).map((user) => ({
      username: user.username,
      terminal: user.terminal,
      login_at: user.loginAt,
      remote_host: user.remoteHost,
    })),
    net_rx_bytes: metrics.netRxBytes,
    net_tx_bytes: metrics.netTxBytes,
    thermal_zones: (metrics.thermalZones ?? []).map((zone) => ({ celsius: zone.celsius })),
    hottest_temperature_c: hottestTemperatureC(metrics),
  };
}

/**
 * Adapts a P3 `HostReport` (camelCase metrics/checks) to the P1
 * `HostReportInput` (snake_case) consumed by `persistHostReports` /
 * `saveHostSnapshot` / `saveHostCheckResults`.
 */
export function toStorageReport(report: HostReport): HostReportInput {
  return {
    host_name: report.hostName,
    host: report.host,
    success: report.success,
    metrics: report.metrics ? toStorageMetrics(report.metrics) : null,
    errors: report.errors ?? [],
    checks: (report.checks ?? []).map(toStorageCheck),
    users: report.users ?? [],
  };
}

function diskMountsByHost(config: AppConfig): Record<string, readonly string[]> {
  const map: Record<string, readonly string[]> = {};
  for (const server of config.servers ?? []) {
    if (Array.isArray(server.disk_mounts) && server.disk_mounts.length > 0) {
      map[server.name] = server.disk_mounts;
    }
  }
  return map;
}

/** Default persistence: history + daily summary, latest snapshot, check snapshot. */
function defaultPersistReports(
  db: SqliteDatabase,
  reports: readonly HostReportInput[],
  options: PersistHostReportsOptions,
): void {
  persistHostReports(db, reports, options);
  for (const report of reports) {
    try {
      saveHostSnapshot(db, report);
    } catch {
      // Best-effort — one bad host must not abort the whole persistence pass.
    }
    if (report.checks && report.checks.length > 0) {
      try {
        saveHostCheckResults(db, report.host_name, report.checks);
      } catch {
        // Best-effort — ditto.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Retention config
// ---------------------------------------------------------------------------

function buildRetentionConfig(settings: Settings): RetentionConfig {
  const monitoring = section(settings, 'monitoring');
  return {
    hostMetricsMaxPoints: readNumber(monitoring, 'host_metrics_max_points'),
    diskHealthRetentionDays: readNumber(monitoring, 'disk_health_retention_days'),
    diskHealthMaxBatches: readNumber(monitoring, 'disk_health_max_batches'),
    hostDailySummaryRetentionDays: readNumber(monitoring, 'host_daily_summary_retention_days'),
    alertHistoryRetentionDays: readNumber(monitoring, 'alert_history_retention_days'),
    sshAuditRetentionDays: readNumber(monitoring, 'ssh_audit_retention_days'),
  };
}

// ---------------------------------------------------------------------------
// Task builders
// ---------------------------------------------------------------------------

/** Resolves the concrete servers to collect (all when `names` is null). */
function selectServers(config: AppConfig, names: readonly string[] | null): HostConfig[] {
  if (names === null || names === undefined) {
    return config.servers ?? [];
  }
  const wanted = new Set(names);
  return (config.servers ?? []).filter((host) => wanted.has(host.name));
}

/**
 * Runs one collection cycle (optionally restricted to `names`) and records
 * per-host lifecycle state in the shared {@link CollectionStatusRegistry}.
 *
 * This is the shared body of the periodic `collect` task and the on-demand
 * {@link collectHostsNow} helper used by the hosts routes' `collectHosts`.
 */
async function runCollectCycle(
  db: SqliteDatabase,
  config: AppConfig,
  settings: Settings,
  deps: SchedulerWiringDeps,
  names: readonly string[] | null,
): Promise<string> {
  const monitoring = section(settings, 'monitoring');
  const collectHosts = deps.collectAllHosts ?? defaultCollectAllHosts;
  const persist = deps.persistReports ?? defaultPersistReports;
  const registry = getCollectionStatusRegistry(db);

  const servers = selectServers(config, names);
  const serverNames = servers.map((host) => host.name);
  registry.markRunning(serverNames);

  try {
    const collectorConfig: CollectorConfig = {
      ...buildCollectorConfig(config, settings),
      servers,
    };
    const options: CollectAllOptions = {
      runHostChecks: deps.runHostChecks ?? collectorRunHostChecks,
    };
    const reports = await collectHosts(collectorConfig, options);
    const storageReports = reports.map(toStorageReport);
    const tz = readString(monitoring, 'timezone', 'UTC');
    persist(db, storageReports, { diskMounts: diskMountsByHost(config), tz });

    const failedReports = reports.filter((report) => !report.success);
    const failedNames = new Set(failedReports.map((report) => report.hostName));
    registry.markDone(serverNames.filter((name) => !failedNames.has(name)));
    for (const name of serverNames.filter((n) => failedNames.has(n))) {
      registry.markError([name], 'collection failed');
    }
    return `collected ${reports.length} host(s), ${failedReports.length} failed`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    registry.markError(serverNames, message);
    throw error;
  }
}

/**
 * On-demand collection used by the hosts routes' `collectHosts` provider.
 *
 * Resolves the current settings, runs a collection cycle for `names` (all
 * servers when `null`), and returns the summary string.
 */
export async function collectHostsNow(
  db: SqliteDatabase,
  config: AppConfig,
  names: readonly string[] | null = null,
  deps: SchedulerWiringDeps = {},
): Promise<string> {
  const settings = loadEffectiveSettings(db);
  return runCollectCycle(db, config, settings, deps, names);
}

function buildCollectTask(
  db: SqliteDatabase,
  config: AppConfig,
  settings: Settings,
  deps: SchedulerWiringDeps,
): ScheduledTask {
  const monitoring = section(settings, 'monitoring');
  const intervalSeconds = readNumber(monitoring, 'poll_interval_seconds') ?? 600;

  return {
    name: 'collect',
    intervalSeconds,
    run: async () => runCollectCycle(db, config, settings, deps, null),
  };
}

/** Builds the SSH-backed disk-health runner for one host. */
function createDefaultDiskRunner(host: HostConfig, settings: Settings): DiskHealthRunner {
  const ssh = section(settings, 'ssh');
  const connectTimeoutSec = readNumber(ssh, 'connect_timeout') ?? 10;
  const hostKeyPolicy = readString(ssh, 'host_key_policy', '') || undefined;
  const client = new SshClient(hostToSshConnectConfig(host, connectTimeoutSec, hostKeyPolicy));
  const sudo = host.sudo_password;
  return {
    run: (command, timeoutMs) => client.run(command, timeoutMs),
    runSudo: (command, timeoutMs) =>
      client.runSudo(command, typeof sudo === 'string' ? sudo : '', timeoutMs),
    close: () => client.close(),
  };
}

/** Builds the disk collector config from the `disk_health` settings section. */
function buildDiskCollectConfig(diskHealth: Record<string, unknown>): DiskHealthCollectConfig {
  const storcli = readStringArray(diskHealth, 'storcli_candidates');
  const rules = asSection(diskHealth['rules']);
  return {
    use_sudo: readBoolean(diskHealth, 'use_sudo', true),
    storcli_candidates: storcli.length > 0 ? storcli : null,
    rules:
      Object.keys(rules).length > 0
        ? (rules as unknown as DiskHealthCollectConfig['rules'])
        : null,
  };
}

/**
 * Builds the production disk alert engine from the `alerts` settings section.
 * The heavy `alerts/engine.ts` module (mailer/notify dependencies) is imported
 * lazily so wiring stays cheap when no disk task ever runs. Returns `null` if
 * construction fails, in which case events are still evaluated but not
 * dispatched.
 */
async function buildDefaultDiskAlertEngine(
  db: SqliteDatabase,
  settings: Settings,
): Promise<DiskPollAlertEngine | null> {
  try {
    const alerts = section(settings, 'alerts');
    const { AlertEngine, createNotifierFromTask5 } = await import('../alerts/engine');
    const notifier = createNotifierFromTask5({ smtp: resolveSmtpConfig(db, settings) });
    const config = alerts as unknown as import('../alerts/engine').AlertsConfig;
    return new AlertEngine({ db, config, notifier });
  } catch (error) {
    console.error('初始化磁盘告警引擎失败', error);
    return null;
  }
}

/**
 * Builds the `disk-poll` task (P5 Task 11b): for every enabled host it
 * collects disk health, stores it, evaluates disk alerts, feeds them to the
 * alert engine, and prunes old snapshots — mirroring `run_disk_once` in
 * `servermanage/app.py`. A single host failure is isolated and never aborts the
 * remaining hosts.
 */
export function buildDiskPollTask(
  db: SqliteDatabase,
  config: AppConfig,
  settings: Settings,
  deps: SchedulerWiringDeps,
): ScheduledTask {
  const monitoring = section(settings, 'monitoring');
  const diskHealth = section(settings, 'disk_health');
  const intervalSeconds = readNumber(monitoring, 'disk_poll_interval_seconds') ?? 86_400;

  return {
    name: 'disk-poll',
    intervalSeconds,
    run: async () => {
      if (!readBoolean(diskHealth, 'enabled', true)) {
        return 'disk poll skipped (disk_health.enabled=false)';
      }
      const collectDisk = deps.collectDisk ?? defaultCollectDiskHealth;
      const saveDisk = deps.saveDisk ?? defaultSaveDiskHealth;
      const evaluateDisk = deps.evaluateDisk ?? defaultEvaluateDiskAlerts;
      const pruneDisk = deps.pruneDisk ?? defaultPruneDiskHealth;
      const ssh = section(settings, 'ssh');
      const commandTimeoutSec = readNumber(ssh, 'command_timeout') ?? 20;
      const alerts = section(settings, 'alerts');
      const thresholds = asSection(alerts['thresholds']);
      const temperatureThresholdC = readNumber(thresholds, 'disk_temperature_c') ?? 55;
      const collectConfig = buildDiskCollectConfig(diskHealth);
      const retentionDays = readNumber(monitoring, 'disk_health_retention_days') ?? 7;
      const maxBatches = readNumber(monitoring, 'disk_health_max_batches') ?? 100;
      const buildRunner =
        deps.createDiskRunner ?? ((host: HostConfig) => createDefaultDiskRunner(host, settings));
      const engine =
        deps.diskAlertEngine !== undefined
          ? deps.diskAlertEngine
          : await buildDefaultDiskAlertEngine(db, settings);

      const events: AlertEvent[] = [];
      const active = new Map<string, string[]>();
      let reports = 0;
      let failed = 0;

      for (const host of config.servers ?? []) {
        if (host.disk_health?.enabled === false) {
          continue;
        }
        let runner: DiskHealthRunner | null = null;
        try {
          const snapshot = getDiskHealth(db, host.name);
          const previous = snapshot ? diskReportFromSnapshot(snapshot) : null;
          runner = await buildRunner(host);
          const options: CollectDiskHealthOptions = {
            config: collectConfig,
            previous,
            override: host.disk_health ?? null,
            temperatureThresholdC,
            timeoutMs: commandTimeoutSec * 1000,
          };
          const report = await collectDisk(host, runner, options);
          saveDisk(db, report);
          const hostEvents = evaluateDisk(report);
          for (const event of hostEvents) {
            events.push(event);
          }
          active.set(host.name, hostEvents.map((event) => event.fingerprint));
          reports += 1;
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          console.error(`磁盘采集失败 ${host.name}: ${message}`);
        } finally {
          if (runner && typeof runner.close === 'function') {
            try {
              await runner.close();
            } catch {
              /* best-effort close */
            }
          }
        }
      }

      if (reports > 0) {
        try {
          pruneDisk(db, retentionDays, maxBatches);
        } catch (error) {
          console.error('磁盘数据清理失败', error);
        }
      }

      let notified = 0;
      if (engine && events.length > 0) {
        try {
          const result = await engine.process(events);
          notified = result.length;
        } catch (error) {
          console.error('磁盘告警处理失败', error);
        }
      }
      if (engine && typeof engine.resolve_missing === 'function') {
        const notifyRecovery = readBoolean(alerts, 'notify_on_recovery', true);
        for (const [hostName, fingerprints] of active) {
          try {
            await engine.resolve_missing(hostName, fingerprints, {
              category: 'disk',
              notify: notifyRecovery,
            });
          } catch (error) {
            console.error(`磁盘告警恢复处理失败 ${hostName}`, error);
          }
        }
      }

      return `disk poll: ${reports} host(s), ${failed} failed, ${notified} alert(s)`;
    },
  };
}

/**
 * Builds the `user-scan` task (P5 Task 11b): runs the P5 `runUserScan` cycle
 * over every user-monitoring-enabled host. Only registered when at least one
 * host opts into user monitoring (mirrors `_build_tasks`).
 */
export function buildUserScanTask(
  db: SqliteDatabase,
  config: AppConfig,
  settings: Settings,
  deps: SchedulerWiringDeps,
): ScheduledTask {
  const userMonitoring = asSection(settings['user_monitoring']);
  const intervalSeconds = readNumber(userMonitoring, 'scan_interval_seconds') ?? 3600;
  const runScan = deps.runUserScan ?? defaultRunUserScan;

  return {
    name: 'user-scan',
    intervalSeconds,
    run: async () => {
      const summary = await runScan({ db, config });
      return `user scan: ${summary.hosts_done}/${summary.hosts_total} host(s), ${summary.accounts} account(s), ${summary.hosts_failed} failed`;
    },
  };
}

/**
 * Builds the SMTP client config from the `smtp` settings section, or `null`
 * when no host is configured (the oracle's `config.smtp is None` branch). The
 * password is read from the encrypted secret store, matching `secrets.py`.
 */
function resolveSmtpConfig(db: SqliteDatabase, settings: Settings): SmtpConfig | null {
  const smtp = section(settings, 'smtp');
  const host = readString(smtp, 'host', '').trim();
  if (host === '') {
    return null;
  }
  return {
    host,
    port: readNumber(smtp, 'port') ?? 587,
    username: readString(smtp, 'username', ''),
    password: readSecretText(db, SECRET_SMTP_PASSWORD) ?? '',
    useSsl: readBoolean(smtp, 'use_ssl', false),
    fromAddr: readString(smtp, 'from_addr', ''),
    toAddrs: readStringArray(smtp, 'to_addrs'),
  };
}

/**
 * `daily-report` task — ports `app.py::run_daily_report`: collect a fresh
 * snapshot, persist it, build the `DailyReport`, email the technical variant,
 * then (when enabled) a second executive variant to its own recipients.
 */
function buildDailyReportTask(
  db: SqliteDatabase,
  config: AppConfig,
  settings: Settings,
  deps: SchedulerWiringDeps,
  calendar: CalendarSpec,
): ScheduledTask {
  const report = section(settings, 'report');
  const monitoring = section(settings, 'monitoring');
  const subjectPrefix = readString(report, 'subject_prefix', '[Server Daily Report]');

  const collectHosts = deps.collectAllHosts ?? defaultCollectAllHosts;
  const persist = deps.persistReports ?? defaultPersistReports;
  const render = deps.renderReport ?? defaultRenderReport;
  const send = deps.sendReport ?? defaultSendReport;
  const clock = deps.now ?? (() => new Date());

  return {
    name: 'daily-report',
    calendar,
    run: async () => {
      const collectorConfig = buildCollectorConfig(config, settings);
      const options: CollectAllOptions = {
        runHostChecks: deps.runHostChecks ?? collectorRunHostChecks,
      };
      const reports = await collectHosts(collectorConfig, options);
      const generatedAt = clock().toISOString();
      const daily = buildDailyReport(reports, { generatedAt, subjectPrefix });

      // Python persists first (`storage.enabled`), then bails out on missing SMTP.
      const tz = readString(monitoring, 'timezone', 'UTC');
      persist(db, reports.map(toStorageReport), { diskMounts: diskMountsByHost(config), tz });

      const smtp = resolveSmtpConfig(db, settings);
      if (!smtp) {
        return 'skipped: smtp not configured';
      }

      const rendered = render(daily, 'technical');
      await send(
        smtp,
        buildMessage({
          subject: rendered.subject,
          fromAddr: smtp.fromAddr,
          toAddrs: smtp.toAddrs,
          textBody: rendered.textBody,
          htmlBody: rendered.htmlBody,
        }),
      );

      const executive = asSection(report['executive']);
      if (readBoolean(executive, 'enabled', false)) {
        const executivePrefix = readString(executive, 'subject_prefix', '[Leader Summary]');
        const executiveReport = buildDailyReport(reports, {
          generatedAt,
          subjectPrefix: executivePrefix,
        });
        const executiveRendered = render(executiveReport, 'executive');
        const executiveTo = readStringArray(executive, 'to_addrs');
        await send(
          smtp,
          buildMessage({
            subject: executiveRendered.subject,
            fromAddr: smtp.fromAddr,
            // Python `to_addrs or smtp.to_addrs`: an empty list falls back.
            toAddrs: executiveTo.length > 0 ? executiveTo : smtp.toAddrs,
            textBody: executiveRendered.textBody,
            htmlBody: executiveRendered.htmlBody,
          }),
        );
      }

      return `sent daily report: ${rendered.subject}`;
    },
  };
}

/**
 * `weekly-report` task — ports `app.py::run_weekly_report`: generate the weekly
 * aggregate from the DB, render the `weekly` variant, then email it. Note the
 * oracle renders *before* the SMTP-presence check, so we do too.
 */
function buildWeeklyReportTask(
  db: SqliteDatabase,
  settings: Settings,
  deps: SchedulerWiringDeps,
  calendar: CalendarSpec,
): ScheduledTask {
  const report = section(settings, 'report');
  const weeklySettings = asSection(report['weekly']);
  const monitoring = section(settings, 'monitoring');
  const tz = readString(monitoring, 'timezone', 'UTC') || 'UTC';

  const weeklyConfig: WeeklyReportConfigLike = {
    enabled: readBoolean(weeklySettings, 'enabled', true),
    subjectPrefix: readString(weeklySettings, 'subject_prefix', DEFAULT_WEEKLY_SUBJECT_PREFIX),
    busyThreshold: readNumber(weeklySettings, 'busy_threshold') ?? DEFAULT_BUSY_THRESHOLD,
    idleThreshold: readNumber(weeklySettings, 'idle_threshold') ?? DEFAULT_IDLE_THRESHOLD,
    time: readString(weeklySettings, 'time', '16:00'),
    weekday: readNumber(weeklySettings, 'weekday') ?? 4,
  };

  const render = deps.renderReport ?? defaultRenderReport;
  const send = deps.sendReport ?? defaultSendReport;
  const clock = deps.now ?? (() => new Date());

  return {
    name: 'weekly-report',
    calendar,
    run: async () => {
      const weeklyReport = generateWeeklyReport(db, { config: weeklyConfig, tz, now: clock() });
      const rendered = render(weeklyReport, 'weekly');

      const smtp = resolveSmtpConfig(db, settings);
      if (!smtp) {
        return 'skipped: smtp not configured';
      }

      await send(
        smtp,
        buildMessage({
          subject: rendered.subject,
          fromAddr: smtp.fromAddr,
          toAddrs: smtp.toAddrs,
          textBody: rendered.textBody,
          htmlBody: rendered.htmlBody,
        }),
      );

      return `sent weekly report: ${rendered.subject}`;
    },
  };
}

function buildPruneTask(
  db: SqliteDatabase,
  config: AppConfig,
  settings: Settings,
  deps: SchedulerWiringDeps,
): ScheduledTask {
  const prune = deps.pruneRetention ?? defaultPruneRetention;
  const cleanup = deps.cleanupLogs ?? defaultCleanupLogs;
  return {
    name: 'prune',
    // Hourly, matching the oracle `retention_cleanup` cadence (`app.py:1132`).
    intervalSeconds: 3600,
    run: () => {
      const now = deps.now ? deps.now() : new Date();
      const counts = prune(db, buildRetentionConfig(settings), { now });
      const logs = config.logDir
        ? cleanup(config.logDir, 24, now)
        : { deleted: 0, bytes: 0 };
      return `pruned retention=${JSON.stringify(counts)} logs=${JSON.stringify(logs)}`;
    },
  };
}

/**
 * Builds the concrete scheduled tasks for the runtime scheduler.
 *
 * Settings are read once at build time (mirroring the oracle, which resolves
 * its config before constructing tasks); a settings change therefore takes
 * effect on the next restart, exactly like `poll_interval_seconds`.
 */
export function buildScheduledTasks(options: BuildScheduledTasksOptions): ScheduledTask[] {
  const { db, config } = options;
  const deps = options.deps ?? {};
  const settings = loadEffectiveSettings(db);

  const tasks: ScheduledTask[] = [
    buildCollectTask(db, config, settings, deps),
    buildDiskPollTask(db, config, settings, deps),
  ];

  const report = section(settings, 'report');
  const weekly = asSection(report['weekly']);
  if (readBoolean(report, 'daily_enabled', true)) {
    tasks.push(
      buildDailyReportTask(db, config, settings, deps, {
        kind: 'daily',
        hhmm: readString(report, 'daily_time', '09:00'),
      }),
    );
  }
  if (readBoolean(weekly, 'enabled', true)) {
    tasks.push(
      buildWeeklyReportTask(db, settings, deps, {
        kind: 'weekly',
        hhmm: readString(weekly, 'time', '16:00'),
        weekday: readNumber(weekly, 'weekday') ?? 4,
      }),
    );
  }

  const userMonitoring = asSection(settings['user_monitoring']);
  const userMonitoringEnabled = readBoolean(userMonitoring, 'enabled', true);
  const anyUserHost = (config.servers ?? []).some((host) =>
    isUserMonitoringEnabled(host, { user_monitoring: { enabled: userMonitoringEnabled } }),
  );
  if (anyUserHost) {
    tasks.push(buildUserScanTask(db, config, settings, deps));
  }

  tasks.push(buildPruneTask(db, config, settings, deps));
  return tasks;
}

/**
 * Starts the runtime scheduler when both a database and a config are present.
 *
 * Returns `null` when either is missing (health-only boot). The returned
 * `stop()` is idempotent and safe to call from a server `close()` handler.
 */
export function startSchedulerIfConfigured(
  options: StartSchedulerOptions,
): SchedulerHandle | null {
  const { db, config } = options;
  if (!db || !config) {
    return null;
  }
  const settings = loadEffectiveSettings(db);
  const tz = readString(section(settings, 'monitoring'), 'timezone', 'UTC') || 'UTC';
  const tasks = buildScheduledTasks({ db, config, deps: options.deps });
  const scheduler = new Scheduler(tasks, { db, tz, now: options.deps?.now });
  scheduler.start();

  let stopped = false;
  return {
    scheduler,
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      scheduler.stop();
    },
  };
}
