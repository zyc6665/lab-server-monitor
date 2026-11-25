/**
 * Capacity trend forecasts for memory, disk and GPU memory.
 *
 * Ported 1:1 from the Python oracle `servermanage/capacity.py`: a least-squares
 * line over the daily summary points, then a straight-line projection to the
 * alert threshold. All functions are pure or read-only.
 *
 * Adaptations vs. the Python oracle (also called out at each call site):
 * - **Storage handle**: Python's `build_capacity_forecasts` takes a `db_path`
 *   and re-opens the database inside `fetch_host_history`. The Node storage
 *   layer (`fetchHostHistory`) takes an already-open `better-sqlite3` `Database`
 *   as its first argument, so `buildCapacityForecasts` takes `db` instead and
 *   threads it straight through.
 * - **Rounding**: Python's `round(x, 2)` uses round-half-to-even on the *exact*
 *   binary value of the float. `roundHalfEven` reproduces that exactly (BigInt
 *   decimal expansion) instead of relying on `Math.round` (half-up) or a naive
 *   `value * 100` (which can land on the wrong side of a tie).
 */
import type { HostAlertRules, HostConfig } from '../config/config';
import { DEFAULT_SETTINGS } from '../config/defaults';
import { fetchHostHistory } from '../storage/metrics-read';

type SqliteDatabase = import('better-sqlite3').Database;

/** Thrown when a capacity-forecast request is invalid (Python `ValueError`). */
export class CapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapacityError';
  }
}

/** `(series key, display label, threshold-attribute)` — matches `_METRICS`. */
export const META_METRICS: Array<[string, string, string]> = [
  ['memory', '内存', 'memory_percent'],
  ['disk', '磁盘', 'disk_percent'],
  ['gpu_memory', 'GPU 显存', 'gpu_memory_percent'],
];

/** One row of a series: an ISO `t` plus the metric value under its key. */
export type CapacitySeriesRow = Record<string, unknown>;

/** Forecast status ladder (same strings as Python). */
export type CapacityStatus = 'insufficient_data' | 'stable' | 'warning' | 'critical';

/** A parsed calendar day (Python `datetime.date`, but just the parts we use). */
export interface CalendarDay {
  y: number;
  m: number;
  d: number;
}

/** Result of {@link forecastSeries} (snake_case keys match the Python dict). */
export interface CapacityForecast {
  key: string;
  current: number | null;
  slope_per_day: number | null;
  days_to_threshold: number | null;
  status: CapacityStatus;
  threshold: number;
}

/** A forecast with its human label attached (`buildCapacityForecasts` output). */
export interface CapacityMetricForecast extends CapacityForecast {
  label: string;
}

/** Per-host forecast block (snake_case keys match the Python dict). */
export interface HostCapacityForecast {
  host_name: string;
  host: string;
  metrics: CapacityMetricForecast[];
}

/** Per-metric threshold overrides keyed by the series metric name. */
export interface CapacityThresholds {
  memory?: number;
  disk?: number;
  gpu_memory?: number;
}

/** Options for {@link buildCapacityForecasts}. */
export interface BuildCapacityForecastsOptions {
  /** IANA timezone for the daily buckets; defaults to `UTC`. */
  tz?: string;
  /** Injected clock; defaults to now. */
  now?: Date;
  /** Base threshold overrides; server-level `alert_rules` win per field. */
  thresholds?: CapacityThresholds;
  /** Forecast horizon in days; must be one of 7/30/90 (default 30). */
  days?: number;
}

// ---------------------------------------------------------------------------
// Python-rounding helpers
// ---------------------------------------------------------------------------

/**
 * Python `round(value, digits)`: round-half-to-even of the exact binary value.
 *
 * A double is exactly `mantissa * 2**exponent`; multiplying by `10**digits`
 * gives `mantissa * 5**digits * 2**(exponent+digits)`, which BigInt represents
 * exactly. Rounding that rational to the nearest integer (ties to even) is
 * therefore exact — no epsilon heuristic, no `2.675 -> 2.68` surprises.
 */
function roundHalfEven(value: number, digits: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  if (value === 0) {
    return 0;
  }
  const negative = value < 0;
  const abs = Math.abs(value);

  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, abs);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exponent: number;
  if (expBits === 0) {
    // Subnormal: value = mantissa * 2**-1074.
    exponent = -1074;
  } else {
    mantissa |= 1n << 52n;
    exponent = expBits - 1023 - 52;
  }

  const scaled = mantissa * 5n ** BigInt(digits);
  const shift = exponent + digits;
  let magnitude: bigint;
  if (shift >= 0) {
    magnitude = scaled << BigInt(shift);
  } else {
    const denominator = 1n << BigInt(-shift);
    let quotient = scaled / denominator;
    const remainder = scaled % denominator;
    const twice = remainder * 2n;
    if (twice > denominator) {
      quotient += 1n;
    } else if (twice === denominator && quotient % 2n !== 0n) {
      quotient += 1n;
    }
    magnitude = quotient;
  }

  const rounded = Number(magnitude) / 10 ** digits;
  return negative ? -rounded : rounded;
}

// ---------------------------------------------------------------------------
// linearSlope
// ---------------------------------------------------------------------------

/**
 * Least-squares slope of `(x, y)` points, or `null` when undefined.
 *
 * Sums in the same left-to-right order as Python so float drift matches.
 */
export function linearSlope(points: Array<[number, number]>): number | null {
  const count = points.length;
  if (count < 2) {
    return null;
  }
  let xSum = 0;
  let ySum = 0;
  for (const [x] of points) {
    xSum += x;
  }
  for (const [, y] of points) {
    ySum += y;
  }
  const xMean = xSum / count;
  const yMean = ySum / count;
  let denominator = 0;
  for (const [x] of points) {
    denominator += (x - xMean) ** 2;
  }
  if (denominator === 0) {
    return null;
  }
  let numerator = 0;
  for (const [x, y] of points) {
    numerator += (x - xMean) * (y - yMean);
  }
  return numerator / denominator;
}

// ---------------------------------------------------------------------------
// parseDay
// ---------------------------------------------------------------------------

/**
 * Parse the leading `YYYY-MM-DD` of an ISO string into its calendar parts
 * (port of Python `date.fromisoformat(text[:10])`). Returns `null` for anything
 * that is not a valid calendar date.
 */
export function parseDay(value: unknown): CalendarDay | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value);
  const head = text.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) {
    return null;
  }
  const y = Number(head.slice(0, 4));
  const m = Number(head.slice(5, 7));
  const d = Number(head.slice(8, 10));
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

/** Whole days since the Unix epoch for a calendar day (DST-free day delta). */
function dayNumber(day: CalendarDay): number {
  return Math.round(Date.UTC(day.y, day.m - 1, day.d) / 86400000);
}

/** Port of Python `float(raw)` returning `null` instead of raising. */
function coerceNumber(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'boolean') {
    return raw ? 1 : 0;
  }
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') {
      return null;
    }
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// forecastSeries
// ---------------------------------------------------------------------------

/** Options for {@link forecastSeries}. */
export interface ForecastSeriesOptions {
  threshold: number;
  minPoints?: number;
  horizonDays?: number;
}

/**
 * Forecast one metric from `[{t, [key]: value}]` rows. Port of
 * Python `forecast_series`.
 */
export function forecastSeries(
  series: ReadonlyArray<CapacitySeriesRow>,
  key: string,
  opts: ForecastSeriesOptions,
): CapacityForecast {
  const minPoints = opts.minPoints ?? 5;
  const horizonDays = opts.horizonDays ?? 30;
  const threshold = Number(opts.threshold);

  const valid: Array<[CalendarDay, number]> = [];
  for (const item of series) {
    const raw = item[key];
    if (raw === null || raw === undefined) {
      continue;
    }
    const value = coerceNumber(raw);
    if (value === null) {
      continue;
    }
    const day = parseDay(item['t']);
    if (day === null) {
      continue;
    }
    valid.push([day, value]);
  }

  const result: CapacityForecast = {
    key,
    current: valid.length > 0 ? roundHalfEven(valid[valid.length - 1][1], 2) : null,
    slope_per_day: null,
    days_to_threshold: null,
    status: 'insufficient_data',
    threshold,
  };
  if (valid.length < minPoints) {
    return result;
  }

  const firstDay = dayNumber(valid[0][0]);
  const points: Array<[number, number]> = valid.map(([day, value]) => [
    dayNumber(day) - firstDay,
    value,
  ]);
  const slope = linearSlope(points);
  const current = valid[valid.length - 1][1];
  result.current = roundHalfEven(current, 2);
  result.slope_per_day = slope !== null ? roundHalfEven(slope, 2) : null;

  if (current >= threshold) {
    result.days_to_threshold = 0;
    result.status = 'critical';
    return result;
  }

  if (slope === null || slope <= 0.01) {
    result.status = 'stable';
    return result;
  }

  const daysToThreshold = (threshold - current) / slope;
  result.days_to_threshold = roundHalfEven(Math.max(0, daysToThreshold), 2);
  if (daysToThreshold <= 7) {
    result.status = 'critical';
  } else if (daysToThreshold <= horizonDays) {
    result.status = 'warning';
  } else {
    result.status = 'stable';
  }
  return result;
}

// ---------------------------------------------------------------------------
// buildCapacityForecasts
// ---------------------------------------------------------------------------

/** Map a threshold attribute to its key in {@link CapacityThresholds}. */
const ATTR_OVERRIDE_KEY: Record<string, keyof CapacityThresholds> = {
  memory_percent: 'memory',
  disk_percent: 'disk',
  gpu_memory_percent: 'gpu_memory',
};

/** Default threshold for `attr` from the settings `alerts.thresholds` section. */
function settingsThreshold(attr: string): number {
  const alerts = DEFAULT_SETTINGS['alerts'];
  const thresholds =
    alerts && typeof alerts['thresholds'] === 'object' && alerts['thresholds'] !== null
      ? (alerts['thresholds'] as Record<string, unknown>)
      : {};
  const raw = thresholds[attr];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 90;
}

/**
 * Effective threshold for one metric. Priority matches Python
 * `_threshold_for`: server `alert_rules` override > option `thresholds` >
 * settings default.
 */
function thresholdFor(
  attr: string,
  overrides: CapacityThresholds | undefined,
  rules: HostAlertRules | undefined,
): number {
  if (rules) {
    const ruleValue = rules[attr as keyof HostAlertRules];
    if (ruleValue !== undefined && ruleValue !== null) {
      return Number(ruleValue);
    }
  }
  const overrideKey = ATTR_OVERRIDE_KEY[attr];
  if (overrides && overrideKey) {
    const candidate = overrides[overrideKey];
    if (candidate !== undefined && candidate !== null) {
      return Number(candidate);
    }
  }
  return settingsThreshold(attr);
}

/**
 * Return per-host capacity forecasts for all configured servers. Port of
 * Python `build_capacity_forecasts`, adapted to take an open `db` handle (see
 * the module header).
 */
export function buildCapacityForecasts(
  db: SqliteDatabase,
  servers: HostConfig[],
  opts: BuildCapacityForecastsOptions = {},
): HostCapacityForecast[] {
  const days = opts.days ?? 30;
  if (days !== 7 && days !== 30 && days !== 90) {
    throw new CapacityError('days must be 7, 30 or 90');
  }
  const rangeKey = `${days}d`;
  const hosts: HostCapacityForecast[] = [];

  for (const server of servers) {
    let series: CapacitySeriesRow[];
    try {
      series = fetchHostHistory(db, server.name, {
        rangeKey,
        tz: opts.tz ?? 'UTC',
        now: opts.now,
      }) as unknown as CapacitySeriesRow[];
    } catch {
      // Python catches ValueError (e.g. an unknown range key) and treats the
      // host as having no history.
      series = [];
    }

    const metrics: CapacityMetricForecast[] = [];
    for (const [key, label, attr] of META_METRICS) {
      const forecast = forecastSeries(series, key, {
        threshold: thresholdFor(attr, opts.thresholds, server.alert_rules),
        horizonDays: days,
      });
      metrics.push({ ...forecast, label });
    }
    hosts.push({ host_name: server.name, host: server.host, metrics });
  }

  return hosts;
}
