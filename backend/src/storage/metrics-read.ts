/**
 * Read-side metrics queries mirroring the Python oracle
 * `servermanage/storage/metrics.py` (plus the small `base.py` helpers it uses).
 *
 * Ported 1:1 — same SQL, same aggregation (`AVG`, `CASE`, `SUM`), same bucket
 * boundaries and the same explicit `ORDER BY` keys — so the Node result is the
 * same as Python's for the same database contents:
 *
 * - `fetchHostHistory`          <- `metrics.py::fetch_host_history` (526)
 * - `fetchHostSparklines`       <- `fetch_host_sparklines` (644)
 * - `fetchHostUptimeStrip`      <- `fetch_host_uptime_strip` (693)
 * - `fetchAllHostUptimeStrips`  <- `fetch_all_host_uptime_strips` (398)
 * - `fetchOverviewHistory`      <- `fetch_overview_history` (756)
 * - `fetchWeeklyMetrics`        <- `fetch_weekly_metrics` (872)
 * - `fetchDailyPointsForWeek`   <- `fetch_daily_points_for_week` (444)
 * - `countRecentSamples`        <- `count_recent_samples` (344)
 * - `countRecentSamplesByHost`  <- `count_recent_samples_by_host` (371)
 *
 * Timezone handling: Python threads a `tzinfo` through these functions. Here a
 * timezone is a plain IANA identifier string (`'UTC'`, `'Asia/Shanghai'`, …),
 * matching `init_storage(daily_summary_tz=...)` used by `migrate.ts`. Conversion
 * is done with `Intl.DateTimeFormat`, so DST boundaries are honoured. Stored
 * `collected_at` values carry microsecond precision; we carry the microsecond
 * fraction alongside `Date` (millisecond) so `isoformat`-style output keeps all
 * six digits the way Python does.
 */
type SqliteDatabase = import('better-sqlite3').Database;

// ---------------------------------------------------------------------------
// Time helpers (ports of the relevant `base.py` helpers)
// ---------------------------------------------------------------------------

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/;

interface ParsedInstant {
  /** Whole-millisecond UTC instant (JS `Date` resolution). */
  epochMs: number;
  /** Microsecond fraction of the second (0–999999), preserved from the text. */
  micro: number;
}

/**
 * Parses a stored ISO-8601 timestamp into an absolute instant plus its
 * microsecond fraction. Naive strings are interpreted as UTC, matching
 * `base.py::_parse_collected_at` (which treats naive rows as UTC).
 */
function parseTimestamp(raw: string): ParsedInstant {
  const text = raw.trim();
  const match = ISO_RE.exec(text);
  if (!match) {
    const fallback = Date.parse(text);
    if (Number.isNaN(fallback)) {
      throw new TypeError(`invalid timestamp: ${raw}`);
    }
    return { epochMs: fallback, micro: (fallback % 1000) * 1000 };
  }
  const [, y, mo, d, h, mi, s, frac, offset] = match;
  const micro = frac ? Number((frac + '000000').slice(0, 6)) : 0;
  let epochMs = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Math.floor(micro / 1000),
  );
  if (offset && offset !== 'Z') {
    const digits = offset.slice(1).replace(':', '');
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2, 4));
    const sign = offset[0] === '-' ? -1 : 1;
    epochMs -= sign * (hours * 60 + minutes) * 60000;
  }
  return { epochMs, micro };
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** UTC offset (ms) of `timeZone` at the instant `epochMs` (whole minutes). */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  if (timeZone === 'UTC') {
    return 0;
  }
  const parts = getFormatter(timeZone).formatToParts(new Date(epochMs));
  const fields: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      fields[part.type] = part.value;
    }
  }
  const asUtc = Date.UTC(
    Number(fields.year),
    Number(fields.month) - 1,
    Number(fields.day),
    Number(fields.hour),
    Number(fields.minute),
    Number(fields.second),
  );
  const epochSeconds = Math.floor(epochMs / 1000) * 1000;
  return asUtc - epochSeconds;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Formats an instant in `timeZone` the way Python's `datetime.isoformat()`
 * does: `YYYY-MM-DDTHH:MM:SS[.ffffff]±HH:MM`. The fractional part is only
 * emitted when nonzero (Python omits `.000000`).
 */
function formatIso(epochMs: number, micro: number, timeZone: string): string {
  const offsetMs = zoneOffsetMs(epochMs, timeZone);
  const wall = new Date(epochMs + offsetMs);
  const fraction = micro !== 0 ? `.${String(micro).padStart(6, '0')}` : '';
  const sign = offsetMs < 0 ? '-' : '+';
  const absMinutes = Math.round(Math.abs(offsetMs) / 60000);
  const offHours = Math.floor(absMinutes / 60);
  const offMinutes = absMinutes % 60;
  return (
    `${wall.getUTCFullYear()}-${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())}` +
    `T${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}:${pad2(wall.getUTCSeconds())}` +
    `${fraction}${sign}${pad2(offHours)}:${pad2(offMinutes)}`
  );
}

/** Port of `base.py::_to_iso_utc` for a JS `Date` (aware UTC). */
function toIsoUtc(date: Date): string {
  return formatIso(date.getTime(), date.getUTCMilliseconds() * 1000, 'UTC');
}

/** Local calendar day (`YYYY-MM-DD`) that `epochMs` falls on in `timeZone`. */
function localDateString(epochMs: number, timeZone: string): string {
  const wall = new Date(epochMs + zoneOffsetMs(epochMs, timeZone));
  return `${wall.getUTCFullYear()}-${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())}`;
}

function dateParts(dateStr: string): [number, number, number] {
  const [y, m, d] = dateStr.split('-').map(Number);
  return [y, m, d];
}

/** Adds `delta` calendar days to a `YYYY-MM-DD` string. */
function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateParts(dateStr);
  const shifted = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** UTC instant of local midnight on `dateStr` in `timeZone` (port of `_local_week_utc_bounds`). */
function localMidnightToUtcMs(dateStr: string, timeZone: string): number {
  const [y, m, d] = dateParts(dateStr);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const firstOffset = zoneOffsetMs(guess, timeZone);
  let utc = guess - firstOffset;
  const secondOffset = zoneOffsetMs(utc, timeZone);
  if (secondOffset !== firstOffset) {
    utc = guess - secondOffset;
  }
  return utc;
}

/** Port of `base.py::_tz_key` for a string timezone. */
function tzKey(timeZone: string): string {
  return timeZone;
}

// ---------------------------------------------------------------------------
// Numeric helpers (ports of the `base.py` helpers)
// ---------------------------------------------------------------------------

/** Python `round(value, digits)` with banker's rounding (half to even). */
function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const epsilon = 1e-9 * Math.max(1, Math.abs(scaled));
  if (Math.abs(diff - 0.5) <= epsilon) {
    return (floor % 2 === 0 ? floor : floor + 1) / factor;
  }
  return Math.round(scaled) / factor;
}

/** `base.py::_percent_value`. */
function percentValue(used: number | null, total: number | null): number | null {
  if (used === null || total === null || Number(total) <= 0) {
    return null;
  }
  return (Number(used) / Number(total)) * 100.0;
}

/** `base.py::_memory_percent`. */
function memoryPercent(row: { memory_used_mb: number | null; memory_total_mb: number | null }): number | null {
  const total = row.memory_total_mb;
  const used = row.memory_used_mb;
  if (total && total > 0 && used !== null) {
    return (Number(used) / Number(total)) * 100.0;
  }
  return null;
}

/** `base.py::_gpu_memory_percent`. */
function gpuMemoryPercent(row: {
  gpu_memory_used_mb: number | null;
  gpu_memory_total_mb: number | null;
}): number | null {
  const total = row.gpu_memory_total_mb;
  const used = row.gpu_memory_used_mb;
  if (total && total > 0 && used !== null) {
    return (Number(used) / Number(total)) * 100.0;
  }
  return null;
}

/** `base.py::_mean`. */
function mean(values: Array<number | null | undefined>): number | null {
  const numbers: number[] = [];
  for (const value of values) {
    if (value !== null && value !== undefined) {
      numbers.push(Number(value));
    }
  }
  if (numbers.length === 0) {
    return null;
  }
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

/** `base.py::_max_or_none`. */
function maxOrNone(values: Array<number | null | undefined>): number | null {
  const numbers: number[] = [];
  for (const value of values) {
    if (value !== null && value !== undefined) {
      numbers.push(Number(value));
    }
  }
  return numbers.length === 0 ? null : Math.max(...numbers);
}

/** `base.py::_min_or_none`. */
function minOrNone(values: Array<number | null | undefined>): number | null {
  const numbers: number[] = [];
  for (const value of values) {
    if (value !== null && value !== undefined) {
      numbers.push(Number(value));
    }
  }
  return numbers.length === 0 ? null : Math.min(...numbers);
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface RawMetricRow {
  collected_at: string;
  host_name: string;
  host: string;
  success: number;
  cpu_usage_percent: number | null;
  memory_used_mb: number | null;
  memory_total_mb: number | null;
  disk_used_percent: number | null;
  gpu_utilization_percent: number | null;
  gpu_memory_used_mb: number | null;
  gpu_memory_total_mb: number | null;
  total_processes: number | null;
  logged_in_user_count: number | null;
  load_1: number | null;
  net_rx_bytes: number | null;
  net_tx_bytes: number | null;
  temperature_c: number | null;
}

interface DailySummaryRow {
  day: string;
  host_name: string;
  tz: string;
  host: string;
  sample_count: number;
  success_count: number;
  cpu_sum: number | null;
  cpu_max: number | null;
  cpu_min: number | null;
  memory_pct_sum: number | null;
  memory_pct_max: number | null;
  disk_pct_sum: number | null;
  disk_pct_max: number | null;
  gpu_util_sum: number | null;
  gpu_util_max: number | null;
  gpu_memory_pct_sum: number | null;
  gpu_memory_pct_max: number | null;
  load_sum: number | null;
  users_sum: number | null;
  processes_sum: number | null;
  updated_at: string;
  [key: string]: string | number | null;
}

// ---------------------------------------------------------------------------
// Public result shapes (keys/order match the Python dict literals)
// ---------------------------------------------------------------------------

export interface HostHistoryPoint {
  t: string;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  gpu_util: number | null;
  gpu_memory: number | null;
  temperature: number | null;
  load_1: number | null;
  net_rx: number | null;
  net_tx: number | null;
}

export interface SparklineSeries {
  cpu: number[];
  memory: number[];
}

export type HostSparklines = Record<string, SparklineSeries>;

export interface UptimeBucket {
  index: number;
  start: string;
  total: number;
  ok: number;
}

export interface UptimeStrip {
  hours: number;
  bucket_minutes: number;
  buckets: UptimeBucket[];
  samples: number;
  ok: number;
}

export interface OverviewPoint {
  t: string;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  gpu_util: number | null;
  gpu_memory: number | null;
  load_1: number | null;
}

export interface WeeklyMetric {
  host_name: string;
  host: string;
  sample_count: number;
  success_count: number;
  cpu_avg: number | null;
  cpu_max: number | null;
  cpu_min: number | null;
  memory_avg_percent: number | null;
  memory_max_percent: number | null;
  disk_avg_percent: number | null;
  disk_max_percent: number | null;
  gpu_util_avg: number | null;
  gpu_util_max: number | null;
  gpu_memory_avg_percent: number | null;
  gpu_memory_max_percent: number | null;
  load_avg: number | null;
  users_avg: number | null;
  processes_avg: number | null;
}

export interface DailyPoint {
  day: string;
  host_name: string;
  host: string;
  cpu_avg: number | null;
  memory_percent: number | null;
  gpu_util: number | null;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type RangeKey = '24h' | '7d' | '30d' | '90d';

export interface FetchHostHistoryOptions {
  /** `24h` (raw points) | `7d` | `30d` | `90d` (daily summary). Default `24h`. */
  rangeKey?: RangeKey | string;
  /** IANA timezone, default `UTC`. */
  tz?: string;
  /** Injected clock; defaults to now. */
  now?: Date;
}

export interface FetchHostSparklinesOptions {
  /** Max points per series. Default 24 (min 2). */
  points?: number;
  /** Look-back window in hours. Default 24 (min 1). */
  hours?: number;
  now?: Date;
}

export interface FetchUptimeOptions {
  hours?: number;
  bucketMinutes?: number;
  now?: Date;
}

export interface FetchOverviewHistoryOptions {
  rangeKey?: RangeKey | string;
  tz?: string;
  now?: Date;
  /** Shift the window backwards by whole days. Default 0. */
  offsetDays?: number;
  /** Restrict to a single host name. */
  host?: string | null;
}

export interface CountRecentSamplesOptions {
  hours?: number;
  now?: Date;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function summaryAvg(row: DailySummaryRow, prefix: string): number | null {
  const count = Number(row.sample_count ?? 0);
  const total = row[`${prefix}_sum`];
  if (!count || total === null || total === undefined) {
    return null;
  }
  return Number(total) / count;
}

function summaryExtreme(row: DailySummaryRow, prefix: string, kind: 'max' | 'min'): number | null {
  const value = row[`${prefix}_${kind}`];
  return value === null || value === undefined ? null : Number(value);
}

function isMissingTable(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message);
}

/** Port of `base.py::_summary_rows_for_week` (returns [] when the table is absent). */
function summaryRowsForWeek(
  db: SqliteDatabase,
  weekStart: string,
  weekEnd: string,
  timeZone: string,
): DailySummaryRow[] {
  try {
    return db
      .prepare(
        'SELECT * FROM host_daily_summary WHERE day >= ? AND day <= ? AND tz = ?' +
          ' ORDER BY host_name, day',
      )
      .all(weekStart, weekEnd, tzKey(timeZone)) as unknown as DailySummaryRow[];
  } catch (err) {
    if (isMissingTable(err)) {
      return [];
    }
    throw err;
  }
}

function byHostName(a: { host_name: string }, b: { host_name: string }): number {
  if (a.host_name < b.host_name) {
    return -1;
  }
  if (a.host_name > b.host_name) {
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// fetchHostHistory
// ---------------------------------------------------------------------------

/**
 * Chart points for one host. `24h` reads raw samples (ordered oldest→newest);
 * `7d`/`30d`/`90d` read the compact daily summary (sums divided by sample count).
 * Mirrors `metrics.py::fetch_host_history` (526).
 */
export function fetchHostHistory(
  db: SqliteDatabase,
  hostName: string,
  opts: FetchHostHistoryOptions = {},
): HostHistoryPoint[] {
  const rangeKey = opts.rangeKey ?? '24h';
  const timeZone = opts.tz ?? 'UTC';
  if (rangeKey !== '24h' && rangeKey !== '7d' && rangeKey !== '30d' && rangeKey !== '90d') {
    throw new Error('range_key must be 24h, 7d, 30d or 90d');
  }
  const current = opts.now ?? new Date();

  if (rangeKey === '24h') {
    const cutoff = toIsoUtc(new Date(current.getTime() - 24 * 3600 * 1000));
    const rows = db
      .prepare(
        `SELECT collected_at, cpu_usage_percent, memory_used_mb,
                memory_total_mb, disk_used_percent, gpu_utilization_percent,
                gpu_memory_used_mb, gpu_memory_total_mb, load_1, temperature_c,
                net_rx_bytes, net_tx_bytes
           FROM host_metrics_history
          WHERE host_name = ? AND success = 1 AND collected_at >= ?
          ORDER BY collected_at ASC`,
      )
      .all(hostName, cutoff) as unknown as RawMetricRow[];

    const points: HostHistoryPoint[] = [];
    let previousAtMs: number | null = null;
    let previousRx: number | null = null;
    let previousTx: number | null = null;
    for (const row of rows) {
      const moment = parseTimestamp(row.collected_at);
      const rxRaw = row.net_rx_bytes;
      const txRaw = row.net_tx_bytes;
      let rxRate: number | null = null;
      let txRate: number | null = null;
      if (
        previousAtMs !== null &&
        previousRx !== null &&
        previousTx !== null &&
        rxRaw !== null &&
        txRaw !== null
      ) {
        const seconds = (moment.epochMs - previousAtMs) / 1000;
        const deltaRx = Number(rxRaw) - previousRx;
        const deltaTx = Number(txRaw) - previousTx;
        if (seconds > 0 && deltaRx >= 0 && deltaTx >= 0) {
          rxRate = roundTo(deltaRx / seconds, 1);
          txRate = roundTo(deltaTx / seconds, 1);
        }
      }
      points.push({
        t: formatIso(moment.epochMs, moment.micro, timeZone),
        cpu: row.cpu_usage_percent,
        memory: memoryPercent(row),
        disk: row.disk_used_percent,
        gpu_util: row.gpu_utilization_percent,
        gpu_memory: gpuMemoryPercent(row),
        temperature: row.temperature_c,
        load_1: row.load_1,
        net_rx: rxRate,
        net_tx: txRate,
      });
      previousAtMs = moment.epochMs;
      previousRx = rxRaw === null ? null : Number(rxRaw);
      previousTx = txRaw === null ? null : Number(txRaw);
    }
    return points;
  }

  const days = rangeKey === '7d' ? 7 : rangeKey === '30d' ? 30 : 90;
  const startDay = addDays(localDateString(current.getTime(), timeZone), -(days - 1));
  const rows = db
    .prepare(
      `SELECT day, sample_count, cpu_sum, memory_pct_sum, disk_pct_sum,
              gpu_util_sum, gpu_memory_pct_sum, load_sum
         FROM host_daily_summary
        WHERE host_name = ? AND tz = ? AND day >= ?
        ORDER BY day ASC`,
    )
    .all(hostName, tzKey(timeZone), startDay) as unknown as DailySummaryRow[];

  const points: HostHistoryPoint[] = [];
  for (const row of rows) {
    const count = Number(row.sample_count ?? 0);
    if (count <= 0) {
      continue;
    }
    points.push({
      t: String(row.day),
      cpu: row.cpu_sum !== null ? Number(row.cpu_sum) / count : null,
      memory: row.memory_pct_sum !== null ? Number(row.memory_pct_sum) / count : null,
      disk: row.disk_pct_sum !== null ? Number(row.disk_pct_sum) / count : null,
      gpu_util: row.gpu_util_sum !== null ? Number(row.gpu_util_sum) / count : null,
      gpu_memory: row.gpu_memory_pct_sum !== null ? Number(row.gpu_memory_pct_sum) / count : null,
      load_1: row.load_sum !== null ? Number(row.load_sum) / count : null,
      // Daily summaries do not store temperature or network throughput.
      temperature: null,
      net_rx: null,
      net_tx: null,
    });
  }
  return points;
}

// ---------------------------------------------------------------------------
// fetchHostSparklines
// ---------------------------------------------------------------------------

/**
 * Recent CPU/memory series per host for the overview table, values rounded to
 * one decimal. Mirrors `metrics.py::fetch_host_sparklines` (644).
 */
export function fetchHostSparklines(
  db: SqliteDatabase,
  opts: FetchHostSparklinesOptions = {},
): HostSparklines {
  const points = Math.max(2, Math.trunc(opts.points ?? 24));
  const current = opts.now ?? new Date();
  const hours = Math.max(1, Math.trunc(opts.hours ?? 24));
  const since = toIsoUtc(new Date(current.getTime() - hours * 3600 * 1000));

  const rows = db
    .prepare(
      `SELECT host_name, cpu_usage_percent, memory_used_mb, memory_total_mb
         FROM host_metrics_history
        WHERE success = 1 AND collected_at >= ?
        ORDER BY collected_at`,
    )
    .all(since) as unknown as RawMetricRow[];

  const grouped: HostSparklines = {};
  for (const row of rows) {
    let entry = grouped[row.host_name];
    if (!entry) {
      entry = { cpu: [], memory: [] };
      grouped[row.host_name] = entry;
    }
    const cpu = row.cpu_usage_percent;
    if (cpu !== null) {
      entry.cpu.push(roundTo(Number(cpu), 1));
    }
    const memory = percentValue(row.memory_used_mb, row.memory_total_mb);
    if (memory !== null) {
      entry.memory.push(roundTo(memory, 1));
    }
  }

  const result: HostSparklines = {};
  for (const name of Object.keys(grouped)) {
    result[name] = {
      cpu: grouped[name].cpu.slice(-points),
      memory: grouped[name].memory.slice(-points),
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Uptime strips
// ---------------------------------------------------------------------------

/** Port of `metrics.py::_empty_uptime_strip` (64). */
function emptyUptimeStrip(hours: number, bucketMinutes: number, sinceMs: number): UptimeStrip {
  const count = Math.max(1, Math.trunc((hours * 60) / bucketMinutes));
  const bucketMs = bucketMinutes * 60000;
  const micro = new Date(sinceMs).getUTCMilliseconds() * 1000;
  const buckets: UptimeBucket[] = [];
  for (let index = 0; index < count; index += 1) {
    buckets.push({
      index,
      start: formatIso(sinceMs + bucketMs * index, micro, 'UTC'),
      total: 0,
      ok: 0,
    });
  }
  return { hours, bucket_minutes: bucketMinutes, buckets, samples: 0, ok: 0 };
}

/**
 * Per-bucket collection success for the last `hours` hours. Mirrors
 * `metrics.py::fetch_host_uptime_strip` (693).
 */
export function fetchHostUptimeStrip(
  db: SqliteDatabase,
  hostName: string,
  opts: FetchUptimeOptions = {},
): UptimeStrip {
  const bucketMinutes = Math.max(1, Math.trunc(opts.bucketMinutes ?? 15));
  const hours = Math.max(1, Math.trunc(opts.hours ?? 24));
  const current = opts.now ?? new Date();
  const sinceMs = current.getTime() - hours * 3600 * 1000;
  const bucketMs = bucketMinutes * 60000;
  const count = Math.max(1, Math.trunc((hours * 60) / bucketMinutes));

  const strip = emptyUptimeStrip(hours, bucketMinutes, sinceMs);
  const rows = db
    .prepare(
      'SELECT collected_at, success FROM host_metrics_history' +
        ' WHERE host_name = ? AND collected_at >= ?' +
        ' ORDER BY collected_at',
    )
    .all(hostName, toIsoUtc(new Date(sinceMs))) as unknown as Array<{
    collected_at: string;
    success: number;
  }>;

  for (const row of rows) {
    let moment: ParsedInstant;
    try {
      moment = parseTimestamp(row.collected_at);
    } catch {
      continue;
    }
    const index = Math.floor((moment.epochMs - sinceMs) / bucketMs);
    if (index < 0 || index >= count) {
      continue;
    }
    strip.buckets[index].total += 1;
    if (row.success) {
      strip.buckets[index].ok += 1;
    }
  }
  strip.samples = strip.buckets.reduce((sum, bucket) => sum + bucket.total, 0);
  strip.ok = strip.buckets.reduce((sum, bucket) => sum + bucket.ok, 0);
  return strip;
}

/**
 * {@link fetchHostUptimeStrip} for every host in one query. Mirrors
 * `metrics.py::fetch_all_host_uptime_strips` (398).
 */
export function fetchAllHostUptimeStrips(
  db: SqliteDatabase,
  opts: FetchUptimeOptions = {},
): Record<string, UptimeStrip> {
  const bucketMinutes = Math.max(1, Math.trunc(opts.bucketMinutes ?? 15));
  const hours = Math.max(1, Math.trunc(opts.hours ?? 24));
  const current = opts.now ?? new Date();
  const sinceMs = current.getTime() - hours * 3600 * 1000;
  const bucketMs = bucketMinutes * 60000;
  const count = Math.max(1, Math.trunc((hours * 60) / bucketMinutes));

  const strips: Record<string, UptimeStrip> = {};
  const rows = db
    .prepare(
      'SELECT host_name, collected_at, success FROM host_metrics_history' +
        ' WHERE collected_at >= ? ORDER BY host_name, collected_at',
    )
    .all(toIsoUtc(new Date(sinceMs))) as unknown as Array<{
    host_name: string;
    collected_at: string;
    success: number;
  }>;

  for (const row of rows) {
    let strip = strips[row.host_name];
    if (!strip) {
      strip = emptyUptimeStrip(hours, bucketMinutes, sinceMs);
      strips[row.host_name] = strip;
    }
    let moment: ParsedInstant;
    try {
      moment = parseTimestamp(row.collected_at);
    } catch {
      continue;
    }
    const index = Math.floor((moment.epochMs - sinceMs) / bucketMs);
    if (index < 0 || index >= count) {
      continue;
    }
    strip.buckets[index].total += 1;
    if (row.success) {
      strip.buckets[index].ok += 1;
    }
  }
  for (const strip of Object.values(strips)) {
    strip.samples = strip.buckets.reduce((sum, bucket) => sum + bucket.total, 0);
    strip.ok = strip.buckets.reduce((sum, bucket) => sum + bucket.ok, 0);
  }
  return strips;
}

// ---------------------------------------------------------------------------
// fetchOverviewHistory
// ---------------------------------------------------------------------------

/**
 * Fleet-wide (or single-host) average chart points. `24h` aggregates raw
 * samples per `collected_at`; `7d`/`30d`/`90d` aggregate the daily summary per
 * day. Mirrors `metrics.py::fetch_overview_history` (756).
 */
export function fetchOverviewHistory(
  db: SqliteDatabase,
  opts: FetchOverviewHistoryOptions = {},
): OverviewPoint[] {
  const offsetDays = opts.offsetDays ?? 0;
  if (offsetDays < 0) {
    throw new Error('offset_days must be zero or positive');
  }
  const rangeKey = opts.rangeKey ?? '24h';
  const timeZone = opts.tz ?? 'UTC';
  if (rangeKey !== '24h' && rangeKey !== '7d' && rangeKey !== '30d' && rangeKey !== '90d') {
    throw new Error('range_key must be 24h, 7d, 30d or 90d');
  }
  let current = opts.now ?? new Date();
  if (offsetDays) {
    current = new Date(current.getTime() - offsetDays * 86400000);
  }
  const host = opts.host ?? null;
  const hostClause = host ? 'AND host_name = ?' : '';

  if (rangeKey === '24h') {
    const cutoff = toIsoUtc(new Date(current.getTime() - 24 * 3600 * 1000));
    const ceiling = toIsoUtc(current);
    const sql = `
      SELECT collected_at,
             AVG(cpu_usage_percent) AS cpu,
             AVG(CASE WHEN memory_total_mb > 0
                      THEN memory_used_mb * 100.0 / memory_total_mb END) AS memory,
             AVG(disk_used_percent) AS disk,
             AVG(gpu_utilization_percent) AS gpu_util,
             AVG(CASE WHEN gpu_memory_total_mb > 0
                      THEN gpu_memory_used_mb * 100.0 / gpu_memory_total_mb END) AS gpu_memory,
             AVG(load_1) AS load_1
        FROM host_metrics_history
       WHERE success = 1 AND collected_at >= ? AND collected_at <= ?
         ${hostClause}
       GROUP BY collected_at
       ORDER BY collected_at ASC`;
    const params: Array<string> = host ? [cutoff, ceiling, host] : [cutoff, ceiling];
    const rows = db.prepare(sql).all(...params) as unknown as Array<{
      collected_at: string;
      cpu: number | null;
      memory: number | null;
      disk: number | null;
      gpu_util: number | null;
      gpu_memory: number | null;
      load_1: number | null;
    }>;
    return rows.map((row) => {
      const moment = parseTimestamp(row.collected_at);
      return {
        t: formatIso(moment.epochMs, moment.micro, timeZone),
        cpu: row.cpu,
        memory: row.memory,
        disk: row.disk,
        gpu_util: row.gpu_util,
        gpu_memory: row.gpu_memory,
        load_1: row.load_1,
      };
    });
  }

  const days = rangeKey === '7d' ? 7 : rangeKey === '30d' ? 30 : 90;
  const today = localDateString(current.getTime(), timeZone);
  const startDay = addDays(today, -(days - 1));
  const endDay = today;
  const sql = `
    SELECT day,
           SUM(cpu_sum) AS cpu_sum,
           SUM(memory_pct_sum) AS memory_sum,
           SUM(disk_pct_sum) AS disk_sum,
           SUM(gpu_util_sum) AS gpu_util_sum,
           SUM(gpu_memory_pct_sum) AS gpu_memory_sum,
           SUM(load_sum) AS load_sum,
           SUM(sample_count) AS sample_count
      FROM host_daily_summary
     WHERE tz = ? AND day >= ? AND day <= ?
       ${hostClause}
     GROUP BY day
     ORDER BY day ASC`;
  const params: Array<string> = host
    ? [tzKey(timeZone), startDay, endDay, host]
    : [tzKey(timeZone), startDay, endDay];
  const rows = db.prepare(sql).all(...params) as unknown as Array<{
    day: string;
    cpu_sum: number | null;
    memory_sum: number | null;
    disk_sum: number | null;
    gpu_util_sum: number | null;
    gpu_memory_sum: number | null;
    load_sum: number | null;
    sample_count: number | null;
  }>;
  const points: OverviewPoint[] = [];
  for (const row of rows) {
    const count = Number(row.sample_count ?? 0);
    if (count <= 0) {
      continue;
    }
    points.push({
      t: String(row.day),
      cpu: row.cpu_sum !== null ? Number(row.cpu_sum) / count : null,
      memory: row.memory_sum !== null ? Number(row.memory_sum) / count : null,
      disk: row.disk_sum !== null ? Number(row.disk_sum) / count : null,
      gpu_util: row.gpu_util_sum !== null ? Number(row.gpu_util_sum) / count : null,
      gpu_memory: row.gpu_memory_sum !== null ? Number(row.gpu_memory_sum) / count : null,
      load_1: row.load_sum !== null ? Number(row.load_sum) / count : null,
    });
  }
  return points;
}

// ---------------------------------------------------------------------------
// fetchDailyPointsForWeek
// ---------------------------------------------------------------------------

/**
 * Per-day averages per host for the week (local-day buckets). Prefers the
 * daily summary; falls back to raw-history aggregation when no summary rows
 * exist. Mirrors `metrics.py::fetch_daily_points_for_week` (444).
 */
export function fetchDailyPointsForWeek(
  db: SqliteDatabase,
  weekStart: string,
  weekEnd: string,
  timeZone = 'UTC',
): DailyPoint[] {
  const summaryRows = summaryRowsForWeek(db, weekStart, weekEnd, timeZone);
  if (summaryRows.length > 0) {
    return summaryRows.map((row) => ({
      day: row.day,
      host_name: row.host_name,
      host: row.host,
      cpu_avg: summaryAvg(row, 'cpu'),
      memory_percent: summaryAvg(row, 'memory_pct'),
      gpu_util: summaryAvg(row, 'gpu_util'),
    }));
  }

  const startMs = localMidnightToUtcMs(weekStart, timeZone);
  const endMs = localMidnightToUtcMs(addDays(weekEnd, 1), timeZone);
  const startIso = formatIso(startMs, 0, 'UTC');
  const endIso = formatIso(endMs, 0, 'UTC');

  const sql = `
    SELECT
        collected_at,
        host_name,
        host,
        cpu_usage_percent,
        memory_used_mb,
        memory_total_mb,
        gpu_utilization_percent
    FROM host_metrics_history
    WHERE collected_at >= ? AND collected_at < ? AND success = 1
    `;
  const rawRows = db.prepare(sql).all(startIso, endIso) as unknown as RawMetricRow[];

  interface Bucket {
    cpu: Array<number | null>;
    memory: Array<number | null>;
    gpu: Array<number | null>;
  }
  const buckets = new Map<
    string,
    { host_name: string; host: string; day: string; values: Bucket }
  >();
  for (const row of rawRows) {
    const localDay = localDateString(parseTimestamp(row.collected_at).epochMs, timeZone);
    if (localDay < weekStart || localDay > weekEnd) {
      // Defensive clamp mirroring the oracle: never surface a bucket outside
      // the local week even if a stored instant slipped past the UTC window.
      continue;
    }
    const key = `${row.host_name}\u0000${row.host}\u0000${localDay}`;
    let entry = buckets.get(key);
    if (!entry) {
      entry = {
        host_name: row.host_name,
        host: row.host,
        day: localDay,
        values: { cpu: [], memory: [], gpu: [] },
      };
      buckets.set(key, entry);
    }
    entry.values.cpu.push(row.cpu_usage_percent);
    entry.values.memory.push(memoryPercent(row));
    entry.values.gpu.push(row.gpu_utilization_percent);
  }

  const results: DailyPoint[] = [];
  for (const entry of buckets.values()) {
    results.push({
      day: entry.day,
      host_name: entry.host_name,
      host: entry.host,
      cpu_avg: mean(entry.values.cpu),
      memory_percent: mean(entry.values.memory),
      gpu_util: mean(entry.values.gpu),
    });
  }
  results.sort((a, b) => {
    if (a.host_name < b.host_name) {
      return -1;
    }
    if (a.host_name > b.host_name) {
      return 1;
    }
    if (a.day < b.day) {
      return -1;
    }
    if (a.day > b.day) {
      return 1;
    }
    return 0;
  });
  return results;
}

// ---------------------------------------------------------------------------
// fetchWeeklyMetrics
// ---------------------------------------------------------------------------

/**
 * Weekly per-host metrics aggregating as the mean of daily means. Prefers the
 * daily summary; falls back to raw-history aggregation. `*_max`/`*_min` stay
 * raw extremes over the week and `sample_count` stays the raw sample count.
 * Mirrors `metrics.py::fetch_weekly_metrics` (872).
 */
export function fetchWeeklyMetrics(
  db: SqliteDatabase,
  weekStart: string,
  weekEnd: string,
  timeZone = 'UTC',
): WeeklyMetric[] {
  const summaryRows = summaryRowsForWeek(db, weekStart, weekEnd, timeZone);
  if (summaryRows.length > 0) {
    const grouped = new Map<string, { host_name: string; host: string; rows: DailySummaryRow[] }>();
    for (const row of summaryRows) {
      const key = `${row.host_name}\u0000${row.host}`;
      let group = grouped.get(key);
      if (!group) {
        group = { host_name: row.host_name, host: row.host, rows: [] };
        grouped.set(key, group);
      }
      group.rows.push(row);
    }
    const results: WeeklyMetric[] = [];
    for (const group of grouped.values()) {
      const rows = group.rows;
      results.push({
        host_name: group.host_name,
        host: group.host,
        sample_count: rows.reduce((sum, row) => sum + Number(row.sample_count), 0),
        success_count: rows.reduce((sum, row) => sum + Number(row.success_count), 0),
        cpu_avg: mean(rows.map((row) => summaryAvg(row, 'cpu'))),
        cpu_max: maxOrNone(rows.map((row) => summaryExtreme(row, 'cpu', 'max'))),
        cpu_min: minOrNone(rows.map((row) => summaryExtreme(row, 'cpu', 'min'))),
        memory_avg_percent: mean(rows.map((row) => summaryAvg(row, 'memory_pct'))),
        memory_max_percent: maxOrNone(rows.map((row) => summaryExtreme(row, 'memory_pct', 'max'))),
        disk_avg_percent: mean(rows.map((row) => summaryAvg(row, 'disk_pct'))),
        disk_max_percent: maxOrNone(rows.map((row) => summaryExtreme(row, 'disk_pct', 'max'))),
        gpu_util_avg: mean(rows.map((row) => summaryAvg(row, 'gpu_util'))),
        gpu_util_max: maxOrNone(rows.map((row) => summaryExtreme(row, 'gpu_util', 'max'))),
        gpu_memory_avg_percent: mean(rows.map((row) => summaryAvg(row, 'gpu_memory_pct'))),
        gpu_memory_max_percent: maxOrNone(rows.map((row) => summaryExtreme(row, 'gpu_memory_pct', 'max'))),
        load_avg: mean(rows.map((row) => summaryAvg(row, 'load'))),
        users_avg: mean(rows.map((row) => summaryAvg(row, 'users'))),
        processes_avg: mean(rows.map((row) => summaryAvg(row, 'processes'))),
      });
    }
    results.sort(byHostName);
    return results;
  }

  const startMs = localMidnightToUtcMs(weekStart, timeZone);
  const endMs = localMidnightToUtcMs(addDays(weekEnd, 1), timeZone);
  const startIso = formatIso(startMs, 0, 'UTC');
  const endIso = formatIso(endMs, 0, 'UTC');

  const sql = `
    SELECT
        collected_at,
        host_name,
        host,
        success,
        cpu_usage_percent,
        memory_used_mb,
        memory_total_mb,
        disk_used_percent,
        gpu_utilization_percent,
        gpu_memory_used_mb,
        gpu_memory_total_mb,
        load_1,
        logged_in_user_count,
        total_processes
    FROM host_metrics_history
    WHERE collected_at >= ? AND collected_at < ? AND success = 1
    `;
  const rawRows = db.prepare(sql).all(startIso, endIso) as unknown as RawMetricRow[];

  const groups = new Map<string, { host_name: string; host: string; rows: RawMetricRow[] }>();
  for (const row of rawRows) {
    const key = `${row.host_name}\u0000${row.host}`;
    let group = groups.get(key);
    if (!group) {
      group = { host_name: row.host_name, host: row.host, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }

  const results: WeeklyMetric[] = [];
  for (const group of groups.values()) {
    const hostRows = group.rows;
    const dayBuckets = new Map<string, RawMetricRow[]>();
    for (const row of hostRows) {
      const localDay = localDateString(parseTimestamp(row.collected_at).epochMs, timeZone);
      if (localDay < weekStart || localDay > weekEnd) {
        // Defensive clamp, mirroring fetch_daily_points_for_week.
        continue;
      }
      let bucket = dayBuckets.get(localDay);
      if (!bucket) {
        bucket = [];
        dayBuckets.set(localDay, bucket);
      }
      bucket.push(row);
    }

    const dailyCpu: Array<number | null> = [];
    const dailyMemory: Array<number | null> = [];
    const dailyDisk: Array<number | null> = [];
    const dailyGpu: Array<number | null> = [];
    const dailyGpuMemory: Array<number | null> = [];
    const dailyLoad: Array<number | null> = [];
    const dailyUsers: Array<number | null> = [];
    const dailyProcesses: Array<number | null> = [];
    for (const rowsInDay of dayBuckets.values()) {
      dailyCpu.push(mean(rowsInDay.map((r) => r.cpu_usage_percent)));
      dailyMemory.push(mean(rowsInDay.map((r) => memoryPercent(r))));
      dailyDisk.push(mean(rowsInDay.map((r) => r.disk_used_percent)));
      dailyGpu.push(mean(rowsInDay.map((r) => r.gpu_utilization_percent)));
      dailyGpuMemory.push(mean(rowsInDay.map((r) => gpuMemoryPercent(r))));
      dailyLoad.push(mean(rowsInDay.map((r) => r.load_1)));
      dailyUsers.push(mean(rowsInDay.map((r) => r.logged_in_user_count)));
      dailyProcesses.push(mean(rowsInDay.map((r) => r.total_processes)));
    }

    const allCpu = hostRows.map((r) => r.cpu_usage_percent);
    const allMemory = hostRows.map((r) => memoryPercent(r));
    const allDisk = hostRows.map((r) => r.disk_used_percent);
    const allGpu = hostRows.map((r) => r.gpu_utilization_percent);
    const allGpuMemory = hostRows.map((r) => gpuMemoryPercent(r));

    results.push({
      host_name: group.host_name,
      host: group.host,
      sample_count: hostRows.length,
      success_count: hostRows.reduce((sum, r) => sum + Number(r.success), 0),
      cpu_avg: mean(dailyCpu),
      cpu_max: maxOrNone(allCpu),
      cpu_min: minOrNone(allCpu),
      memory_avg_percent: mean(dailyMemory),
      memory_max_percent: maxOrNone(allMemory),
      disk_avg_percent: mean(dailyDisk),
      disk_max_percent: maxOrNone(allDisk),
      gpu_util_avg: mean(dailyGpu),
      gpu_util_max: maxOrNone(allGpu),
      gpu_memory_avg_percent: mean(dailyGpuMemory),
      gpu_memory_max_percent: maxOrNone(allGpuMemory),
      load_avg: mean(dailyLoad),
      users_avg: mean(dailyUsers),
      processes_avg: mean(dailyProcesses),
    });
  }
  results.sort(byHostName);
  return results;
}

// ---------------------------------------------------------------------------
// Sample counts
// ---------------------------------------------------------------------------

/** Snapshot count for one host in the last `hours` hours. Mirrors `count_recent_samples` (344). */
export function countRecentSamples(
  db: SqliteDatabase,
  hostName: string,
  opts: CountRecentSamplesOptions = {},
): number {
  const hours = Math.max(1, Math.trunc(opts.hours ?? 24));
  const current = opts.now ?? new Date();
  const since = toIsoUtc(new Date(current.getTime() - hours * 3600 * 1000));
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM host_metrics_history WHERE host_name = ? AND collected_at >= ?')
    .get(hostName, since) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

/** Snapshot count for every host in one grouped query. Mirrors `count_recent_samples_by_host` (371). */
export function countRecentSamplesByHost(
  db: SqliteDatabase,
  opts: CountRecentSamplesOptions = {},
): Record<string, number> {
  const hours = Math.max(1, Math.trunc(opts.hours ?? 24));
  const current = opts.now ?? new Date();
  const since = toIsoUtc(new Date(current.getTime() - hours * 3600 * 1000));
  const rows = db
    .prepare(
      'SELECT host_name, COUNT(*) AS count FROM host_metrics_history' +
        ' WHERE collected_at >= ? GROUP BY host_name',
    )
    .all(since) as unknown as Array<{ host_name: string; count: number }>;
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.host_name] = Number(row.count);
  }
  return result;
}
