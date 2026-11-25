/**
 * Report assembly — P5 Task 11a.
 *
 * 1:1 port of the Python oracle `servermanage/weekly.py` (report generation)
 * plus the `DailyReport` assembly step from `servermanage/app.py`
 * (`run_daily_report`). The weekly aggregation reads the already-persisted
 * daily summaries through the P1 storage layer, attaches the current
 * `host_check_snapshot` rows, then classifies every host as busy / idle using
 * the intensity score.
 *
 * Design notes:
 * - `generateWeeklyReport` takes an *open* `better-sqlite3` handle (`db`),
 *   matching the rest of the TS backend (the Python oracle takes a `db_path`
 *   and opens its own connection per call).
 * - `now` only drives the week-range computation. `generatedAt` always uses the
 *   wall clock, exactly like Python's `datetime.now(timezone.utc)` inside
 *   `generate_weekly_report`.
 * - `referenceDate` may be a `YYYY-MM-DD` string or a `Date` (interpreted as a
 *   UTC calendar day); it bypasses `tz`/`now`, mirroring the oracle's
 *   `reference_date` override.
 */
import type { HostReport } from '../collect/types';
import { roundHalfEven } from '../collect/types';
import { getHostCheckResults } from '../storage/hosts';
import {
  fetchDailyPointsForWeek,
  fetchWeeklyMetrics,
  type WeeklyMetric,
} from '../storage/metrics-read';
import { toLocalWall } from '../runtime/schedule-time';
import type {
  DailyPoint,
  DailyReport,
  WeeklyCheck,
  WeeklyHostSummary,
  WeeklyReport,
} from './model';

type SqliteDatabase = import('better-sqlite3').Database;

// ---------------------------------------------------------------------------
// Constants (servermanage/weekly.py:20-22, models.py WeeklyReportConfig)
// ---------------------------------------------------------------------------

/** `_MIN_SAMPLES_FOR_CLASSIFICATION` — below this a host is never classified. */
export const MIN_SAMPLES_FOR_CLASSIFICATION = 3;
export const DEFAULT_WEEKLY_SUBJECT_PREFIX = '[Server Weekly Report]';
export const DEFAULT_BUSY_THRESHOLD = 70;
export const DEFAULT_IDLE_THRESHOLD = 20;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Subset of `WeeklyReportConfig` (`models.py:520`) consumed here. */
export interface WeeklyReportConfigLike {
  enabled?: boolean;
  subjectPrefix?: string;
  busyThreshold?: number;
  idleThreshold?: number;
  time?: string;
  weekday?: number;
}

export interface GenerateWeeklyReportOptions {
  /** Explicit `today`; bypasses `now`/`tz` (Python `reference_date`). */
  referenceDate?: Date | string | null;
  config?: WeeklyReportConfigLike | null;
  /** IANA timezone for the "today" derivation + storage reads. Default `UTC`. */
  tz?: string;
  /** Injected clock for the week-range derivation (default `new Date()`). */
  now?: Date | null;
}

export interface BuildDailyReportOptions {
  generatedAt: string;
  subjectPrefix: string;
}

/** Result of {@link previousWeekRange}: both bounds are `YYYY-MM-DD`. */
export interface WeekRange {
  weekStart: string;
  weekEnd: string;
}

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Formats a UTC-midnight epoch (ms) as `YYYY-MM-DD`. */
function isoDateFromUtcMs(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Python `date.weekday()` — Monday = 0 … Sunday = 6. */
function pythonWeekday(utcMidnightMs: number): number {
  return (new Date(utcMidnightMs).getUTCDay() + 6) % 7;
}

/** Resolves an explicit `referenceDate` to a UTC-midnight epoch (ms). */
function referenceDayUtcMs(referenceDate: Date | string): number {
  if (typeof referenceDate === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(referenceDate.trim());
    if (!match) {
      throw new RangeError(`referenceDate must be YYYY-MM-DD, received "${referenceDate}"`);
    }
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  return Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  );
}

const DAY_MS = 86_400_000;

/**
 * Port of `weekly.py::_previous_week_range`: the most recent complete
 * Monday→Sunday week *before* `today`.
 */
export function previousWeekRange(
  options: GenerateWeeklyReportOptions = {},
): WeekRange {
  let todayMs: number;
  if (options.referenceDate !== undefined && options.referenceDate !== null) {
    todayMs = referenceDayUtcMs(options.referenceDate);
  } else {
    const tz = options.tz ?? 'UTC';
    const instant = options.now ?? new Date();
    const wall = toLocalWall(instant, tz);
    todayMs = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  }

  const weekEndMs = todayMs - (pythonWeekday(todayMs) + 1) * DAY_MS;
  const weekStartMs = weekEndMs - 6 * DAY_MS;
  return {
    weekStart: isoDateFromUtcMs(weekStartMs),
    weekEnd: isoDateFromUtcMs(weekEndMs),
  };
}

// ---------------------------------------------------------------------------
// Intensity score + summary construction
// ---------------------------------------------------------------------------

export interface IntensityInput {
  cpuAvg: number | null;
  memoryAvgPercent: number | null;
  gpuUtilAvg: number | null;
}

/**
 * `weekly.py::_compute_intensity_score`. When a host has no GPU samples the
 * GPU weight is dropped and the remaining weights are renormalised over
 * `0.5 + 0.3 = 0.8`.
 */
export function computeIntensityScore(summary: IntensityInput): number {
  const cpu = summary.cpuAvg ?? 0;
  const memory = summary.memoryAvgPercent ?? 0;
  const gpu = summary.gpuUtilAvg ?? 0;
  if (summary.gpuUtilAvg === null) {
    return roundHalfEven((cpu * 0.5 + memory * 0.3) / 0.8, 2);
  }
  return roundHalfEven(cpu * 0.5 + memory * 0.3 + gpu * 0.2, 2);
}

/** Python `float(v) if v is not None else None`. */
function floatOrNull(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** Python `int(v)` for a numeric SQL column. */
function intValue(value: number | null | undefined): number {
  return value === null || value === undefined ? 0 : Math.trunc(Number(value));
}

/** `weekly.py::_build_summary` — one `WeeklyHostSummary` from a `WeeklyMetric`. */
function buildSummary(row: WeeklyMetric): WeeklyHostSummary {
  return {
    hostName: String(row.host_name),
    host: String(row.host),
    sampleCount: intValue(row.sample_count),
    successCount: intValue(row.success_count),
    cpuAvg: floatOrNull(row.cpu_avg),
    cpuMax: floatOrNull(row.cpu_max),
    cpuMin: floatOrNull(row.cpu_min),
    memoryAvgPercent: floatOrNull(row.memory_avg_percent),
    memoryMaxPercent: floatOrNull(row.memory_max_percent),
    diskAvgPercent: floatOrNull(row.disk_avg_percent),
    diskMaxPercent: floatOrNull(row.disk_max_percent),
    gpuUtilAvg: floatOrNull(row.gpu_util_avg),
    gpuUtilMax: floatOrNull(row.gpu_util_max),
    gpuMemoryAvgPercent: floatOrNull(row.gpu_memory_avg_percent),
    gpuMemoryMaxPercent: floatOrNull(row.gpu_memory_max_percent),
    loadAvg: floatOrNull(row.load_avg),
    usersAvg: floatOrNull(row.users_avg),
    processesAvg: floatOrNull(row.processes_avg),
    dailyPoints: [],
    checks: [],
  };
}

function hostKey(hostName: string, host: string): string {
  return `${hostName}\u0000${host}`;
}

// ---------------------------------------------------------------------------
// Weekly report
// ---------------------------------------------------------------------------

/**
 * Generates the weekly report from persisted metrics.
 *
 * Mirrors `weekly.py::generate_weekly_report` including the quirks:
 * - every host with ≥1 weekly row is added to `summaries` (even below the
 *   3-sample classification floor);
 * - `checks` come from the *current* `host_check_snapshot` (not a weekly
 *   history);
 * - `busyHosts` sorted by intensity descending, `idleHosts` ascending.
 */
export function generateWeeklyReport(
  db: SqliteDatabase,
  options: GenerateWeeklyReportOptions = {},
): WeeklyReport {
  const tz = options.tz ?? 'UTC';
  const config = options.config ?? {};
  const subjectPrefix = config.subjectPrefix ?? DEFAULT_WEEKLY_SUBJECT_PREFIX;
  const busyThreshold = config.busyThreshold ?? DEFAULT_BUSY_THRESHOLD;
  const idleThreshold = config.idleThreshold ?? DEFAULT_IDLE_THRESHOLD;

  const { weekStart, weekEnd } = previousWeekRange(options);

  const rows = fetchWeeklyMetrics(db, weekStart, weekEnd, tz);
  const dailyRows = fetchDailyPointsForWeek(db, weekStart, weekEnd, tz);

  const pointsByHost = new Map<string, DailyPoint[]>();
  for (const row of dailyRows) {
    const key = hostKey(row.host_name, row.host);
    const points = pointsByHost.get(key) ?? [];
    points.push({
      day: row.day,
      cpu_avg: row.cpu_avg,
      memory_percent: row.memory_percent,
      gpu_util: row.gpu_util,
    });
    pointsByHost.set(key, points);
  }

  const summaries: WeeklyHostSummary[] = [];
  for (const row of rows) {
    const base = buildSummary(row);
    const checks: WeeklyCheck[] = getHostCheckResults(db, base.hostName).map(
      (check) => ({ ...check }),
    );
    const points = pointsByHost.get(hostKey(row.host_name, row.host)) ?? [];
    summaries.push({ ...base, checks, dailyPoints: points });
  }

  const busyHosts: WeeklyHostSummary[] = [];
  const idleHosts: WeeklyHostSummary[] = [];
  for (const summary of summaries) {
    if (summary.sampleCount < MIN_SAMPLES_FOR_CLASSIFICATION) {
      continue;
    }
    const score = computeIntensityScore(summary);
    if (score >= busyThreshold) {
      busyHosts.push(summary);
    } else if (score <= idleThreshold) {
      idleHosts.push(summary);
    }
  }

  busyHosts.sort((a, b) => computeIntensityScore(b) - computeIntensityScore(a));
  idleHosts.sort((a, b) => computeIntensityScore(a) - computeIntensityScore(b));

  return {
    generatedAt: new Date().toISOString(),
    weekStart,
    weekEnd,
    summaries,
    busyHosts,
    idleHosts,
    subjectPrefix,
  };
}

// ---------------------------------------------------------------------------
// Daily report
// ---------------------------------------------------------------------------

/**
 * Assembles a `DailyReport` from a freshly collected batch. Mirrors the
 * construction in `app.py::run_daily_report`; persistence and delivery are
 * handled by the scheduler wiring.
 */
export function buildDailyReport(
  reports: readonly HostReport[],
  options: BuildDailyReportOptions,
): DailyReport {
  return {
    generatedAt: options.generatedAt,
    reports: [...reports],
    subjectPrefix: options.subjectPrefix,
  };
}
