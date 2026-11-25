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
 *   `report.daily_time` and `report.weekly.{time,weekday}`. The P5 report
 *   generation/email pipeline is **not migrated yet**, so these are registered
 *   as placeholders that return `'skipped: report not migrated'` (see
 *   `TODO(P5)` below).
 * - `prune` — hourly (3600 s, mirroring the oracle `retention_cleanup`
 *   cadence) retention + log cleanup: `pruneRetention` from
 *   `storage/runtime.ts` and `cleanupLogs` from `runtime/maintenance.ts`.
 *
 * The oracle additionally registers `disk_poll` and `user_scan`; those are
 * intentionally out of scope for Task 10 (disk-health collection / user
 * scanning belong to later migrations) and are documented as residual TODOs in
 * the task report rather than registered here.
 */
import type { AppConfig } from '../config/config';
import { loadEffectiveSettings, type Settings } from '../config/service';
import {
  collectAllHosts as defaultCollectAllHosts,
  type CollectAllOptions,
  type CollectorConfig,
  type CollectorRunner,
  type RunHostChecks as CollectorRunHostChecks,
} from '../collect/collectors';
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
  /** Injectable clock (defaults to `() => new Date()`); used by `prune`. */
  now?: () => Date;
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

function buildCollectTask(
  db: SqliteDatabase,
  config: AppConfig,
  settings: Settings,
  deps: SchedulerWiringDeps,
): ScheduledTask {
  const monitoring = section(settings, 'monitoring');
  const intervalSeconds = readNumber(monitoring, 'poll_interval_seconds') ?? 600;
  const collectHosts = deps.collectAllHosts ?? defaultCollectAllHosts;
  const persist = deps.persistReports ?? defaultPersistReports;

  return {
    name: 'collect',
    intervalSeconds,
    run: async () => {
      const collectorConfig = buildCollectorConfig(config, settings);
      const options: CollectAllOptions = {
        runHostChecks: deps.runHostChecks ?? collectorRunHostChecks,
      };
      const reports = await collectHosts(collectorConfig, options);
      const storageReports = reports.map(toStorageReport);
      const tz = readString(monitoring, 'timezone', 'UTC');
      persist(db, storageReports, { diskMounts: diskMountsByHost(config), tz });
      const failed = reports.filter((report) => !report.success).length;
      return `collected ${reports.length} host(s), ${failed} failed`;
    },
  };
}

function buildReportTask(
  name: string,
  calendar: CalendarSpec,
): ScheduledTask {
  return {
    name,
    calendar,
    // TODO(P5): generate + email the report once the P5 report pipeline is
    // migrated. Until then the slot is consumed so catch-up semantics stay
    // observable (the task still records a run in `task_state`).
    run: () => 'skipped: report not migrated',
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

  const tasks: ScheduledTask[] = [buildCollectTask(db, config, settings, deps)];

  const report = section(settings, 'report');
  const weekly = asSection(report['weekly']);
  if (readBoolean(report, 'daily_enabled', true)) {
    tasks.push(
      buildReportTask('daily-report', {
        kind: 'daily',
        hhmm: readString(report, 'daily_time', '09:00'),
      }),
    );
  }
  if (readBoolean(weekly, 'enabled', true)) {
    tasks.push(
      buildReportTask('weekly-report', {
        kind: 'weekly',
        hhmm: readString(weekly, 'time', '16:00'),
        weekday: readNumber(weekly, 'weekday') ?? 4,
      }),
    );
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
