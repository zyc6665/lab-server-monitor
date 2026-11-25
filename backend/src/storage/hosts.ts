/**
 * Host snapshot, availability-check and network-rate storage, mirroring the
 * Python oracle `servermanage/storage/hosts.py` (plus the small helpers it
 * imports from `servermanage/storage/base.py` and `servermanage/disk_capacity.py`).
 *
 * Functions (Python -> Node):
 *
 * - `save_host_snapshot`      (`hosts.py:454`) -> {@link saveHostSnapshot}
 * - `persist_host_reports`    (`hosts.py:282`) -> {@link persistHostReports}
 * - `get_host_snapshot`       (`hosts.py:255`) -> {@link getHostSnapshot}
 * - `get_all_host_snapshots`  (`hosts.py:200`) -> {@link getAllHostSnapshots}
 * - `save_host_check_results` (`hosts.py:403`) -> {@link saveHostCheckResults}
 * - `get_host_check_results`  (`hosts.py:233`) -> {@link getHostCheckResults}
 * - `get_all_host_check_results` (`hosts.py:173`) -> {@link getAllHostCheckResults}
 * - `delete_host_check_results`  (`hosts.py:93`)  -> {@link deleteHostCheckResults}
 * - `fetch_host_network_rates`    (`hosts.py:139`) -> {@link fetchHostNetworkRates}
 * - `fetch_all_host_network_rates`(`hosts.py:109`) -> {@link fetchAllHostNetworkRates}
 *
 * All functions take an already-open `better-sqlite3` handle instead of a path
 * (the whole backend runs in one process against one file; see `./db`). The
 * write paths that Python wraps in `BEGIN IMMEDIATE` are wrapped in
 * `db.transaction(fn).immediate()` here.
 *
 * JSON columns are serialised through `./json` (`dumpJson`, byte-compatible
 * with `json.dumps(..., ensure_ascii=False)`) and timestamps through
 * `./time` (`nowIsoUtc`, `YYYY-MM-DDTHH:MM:SS.ffffff+00:00`). Booleans in
 * INTEGER columns are stored as `0`/`1`.
 */
import { dumpJson, loadJson } from './json';
import { nowIsoUtc } from './time';

type SqliteDatabase = import('better-sqlite3').Database;

// --- Input model types (mirror the Python dataclasses in models.py) ---------

/** `DiskUsageRow` (`models.py:305`), projected to the fields storage reads. */
export interface DiskUsageRowInput {
  filesystem?: string | null;
  mountpoint?: string | null;
  size?: string | null;
  used?: string | null;
  available?: string | null;
  percent?: string | number | null;
}

/** `LoadAverage` (`models.py:285`). */
export interface LoadAverageInput {
  load_1?: number | null;
  load_5?: number | null;
  load_15?: number | null;
}

/** `MemorySummary` (`models.py:292`), projected to the fields storage reads. */
export interface MemorySummaryInput {
  used_mb?: number | null;
  total_mb?: number | null;
}

/** `GPUSummaryRow` (`models.py:343`), projected to the fields storage reads. */
export interface GpuSummaryRowInput {
  utilization_percent?: number | null;
  temperature_c?: number | null;
  memory_used_mb?: number | null;
  memory_total_mb?: number | null;
}

/** `ThermalZone` (`models.py:362`), projected to `celsius`. */
export interface ThermalZoneInput {
  celsius?: number | null;
}

/**
 * `HostMetrics` (`models.py:380`), projected to the fields the storage layer
 * reads. Datetimes may be ISO strings (already `isoformat()`-style) or `Date`
 * objects; a `Date` is rendered with {@link nowIsoUtc}.
 */
export interface HostMetricsInput {
  collected_at?: string | Date | null;
  cpu_usage_percent?: number | null;
  memory?: MemorySummaryInput | null;
  load_average?: LoadAverageInput | null;
  disk_usage?: DiskUsageRowInput[] | null;
  gpu_summary?: GpuSummaryRowInput[] | null;
  total_processes?: number | null;
  logged_in_users?: unknown[] | null;
  net_rx_bytes?: number | null;
  net_tx_bytes?: number | null;
  thermal_zones?: ThermalZoneInput[] | null;
  /**
   * Pre-computed `HostMetrics.hottest_temperature_c` property. When omitted it
   * is computed from `thermal_zones` and `gpu_summary` exactly like the Python
   * property.
   */
  hottest_temperature_c?: number | null;
}

/** `HostCheckResult` (`models.py:53`). */
export interface HostCheckResultInput {
  name: string;
  type: string;
  target: string;
  status: string;
  message?: string | null;
  latency_ms?: number | null;
  checked_at?: string | Date | null;
}

/** `HostReport` (`models.py:458`). */
export interface HostReportInput {
  host_name: string;
  host: string;
  success: boolean;
  metrics?: HostMetricsInput | null;
  errors?: unknown[] | null;
  checks?: HostCheckResultInput[] | null;
  users?: unknown[] | null;
}

/** `DailyReport` (`models.py:468`). */
export interface DailyReportInput {
  generated_at?: string | Date | null;
  reports: HostReportInput[];
  subject_prefix?: string;
}

// --- Output shapes (match Python's dict(row) results) -----------------------

/** One decoded `host_latest_snapshot` row (`get_host_snapshot` return). */
export interface HostSnapshot {
  host_name: string;
  collected_at: string;
  success: boolean;
  metrics: Record<string, unknown>;
  errors: unknown[];
}

/** One `host_check_snapshot` row, keyed exactly like the Python dict. */
export interface HostCheckResultRow {
  host_name: string;
  check_name: string;
  check_type: string;
  target: string;
  status: string;
  message: string;
  latency_ms: number | null;
  checked_at: string;
}

/** rx/tx bytes-per-second pair (`_network_rate_pair` return). */
export interface NetworkRate {
  rx_bytes_per_second: number | null;
  tx_bytes_per_second: number | null;
}

/** Options for {@link persistHostReports}. */
export interface PersistHostReportsOptions {
  /** Per-host configured mount points (`disk_mounts`), keyed by host name. */
  diskMounts?: Record<string, readonly string[]> | null;
  /**
   * Timezone used for the `host_daily_summary.day` local date. An IANA zone
   * name (e.g. `'Asia/Shanghai'`) or `'UTC'`; corresponds to Python's `tz`
   * argument and `_tz_key()`. Defaults to `'UTC'`.
   */
  tz?: string;
}

// --- Small numeric / string helpers (mirror base.py) ------------------------

/** Virtual filesystems excluded from disk-usage calculations (`base.py:24`). */
const VIRTUAL_FILESYSTEMS = new Set([
  'tmpfs',
  'devtmpfs',
  'overlay',
  'squashfs',
  'nsfs',
  'proc',
  'sysfs',
  'cgroup',
  'cgroup2',
  'mqueue',
  'shm',
]);

/** Python `round(value, 1)`. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Python truthiness for the `_flag` helper (`None` -> `default`). */
function flag(value: unknown, defaultValue = false): number {
  if (value === null || value === undefined) {
    return defaultValue ? 1 : 0;
  }
  return value ? 1 : 0;
}

/**
 * `_to_iso_utc` (`base.py:719`): a `Date` is rendered as an ISO-8601 UTC
 * string via {@link nowIsoUtc}; a string is returned unchanged (the caller
 * contract is already ISO-8601 UTC).
 */
function toIsoUtc(value: string | Date): string {
  if (value instanceof Date) {
    return nowIsoUtc(value);
  }
  return String(value);
}

/** Does `text` carry an explicit UTC offset (`Z`, `+hh:mm` or `-hh:mm`)? */
function hasTimezoneOffset(text: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text.trim());
}

/**
 * `_parse_collected_at` (`base.py:647`): parse a stored ISO-8601 string into a
 * `Date`. A value without an offset is interpreted as UTC (Python replaces
 * `tzinfo` with UTC for naive datetimes), so we must not let `Date` fall back
 * to the host's local timezone.
 */
function parseCollectedAt(value: string): Date {
  const text = String(value);
  const normalized = hasTimezoneOffset(text) ? text : `${text}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ISO-8601 timestamp: ${value}`);
  }
  return parsed;
}

/** Local `YYYY-MM-DD` day of an instant in `tz` (`astimezone(tz).date()`). */
function localDay(iso: string, tz: string): string {
  const date = parseCollectedAt(iso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const lookup = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${lookup('year')}-${lookup('month')}-${lookup('day')}`;
}

/** `_percent_value` (`base.py:674`). */
function percentValue(used: number | null | undefined, total: number | null | undefined): number | null {
  if (used === null || used === undefined || total === null || total === undefined) {
    return null;
  }
  if (Number(total) <= 0) {
    return null;
  }
  return (Number(used) / Number(total)) * 100;
}

/** `_disk_percent_value` (`base.py:429`): digits-only integer, `-1` when none. */
function diskPercentValue(percent: string | number | null | undefined): number {
  const text = percent === null || percent === undefined ? '' : String(percent);
  const digits = text.replace(/\D/g, '');
  if (!digits) {
    return -1;
  }
  return Number.parseInt(digits, 10);
}

/** `_parse_percent` (`disk_capacity.py:55`). */
function parsePercent(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return null;
  }
  if (typeof value === 'number') {
    return value;
  }
  const digits = String(value)
    .trim()
    .split('')
    .filter((ch) => (ch >= '0' && ch <= '9') || ch === '.')
    .join('');
  if (!digits) {
    return null;
  }
  const parsed = Number.parseFloat(digits);
  return Number.isNaN(parsed) ? null : parsed;
}

/** `normalize_mounts` (`disk_capacity.py:32`). */
function normalizeMounts(mounts: readonly string[] | null | undefined): string[] {
  const result: string[] = [];
  if (mounts) {
    for (const mount of mounts) {
      if (mount === null || mount === undefined) {
        continue;
      }
      const text = String(mount).trim();
      if (text && !result.includes(text)) {
        result.push(text);
      }
    }
  }
  return result;
}

/** `disk_capacity.max_percent` (`disk_capacity.py:126`). */
function maxMountPercent(
  rows: readonly DiskUsageRowInput[],
  mounts: readonly string[],
): number | null {
  const orderedMounts = normalizeMounts(mounts);
  const indexed = new Map<string, DiskUsageRowInput>();
  for (const row of rows) {
    if (row.mountpoint === null || row.mountpoint === undefined) {
      continue;
    }
    const filesystem = row.filesystem;
    if (filesystem !== null && filesystem !== undefined && VIRTUAL_FILESYSTEMS.has(String(filesystem))) {
      continue;
    }
    const key = String(row.mountpoint);
    if (!indexed.has(key)) {
      indexed.set(key, row);
    }
  }

  const values: number[] = [];
  for (const mountpoint of orderedMounts) {
    const row = indexed.get(mountpoint);
    if (!row) {
      continue;
    }
    const percent = parsePercent(row.percent);
    if (percent !== null) {
      values.push(percent);
    }
  }
  return values.length ? Math.max(...values) : null;
}

/**
 * `_extract_disk_used_percent` (`base.py:467`). When `mounts` is supplied the
 * configured mounts are used (`disk_capacity.max_percent`); otherwise the
 * highest usage among non-virtual filesystems is taken.
 */
function extractDiskUsedPercent(
  report: HostReportInput,
  mounts: readonly string[] | null | undefined,
): number | null {
  const diskUsage = report.metrics?.disk_usage ?? [];
  if (!diskUsage.length) {
    return null;
  }
  if (mounts && mounts.length) {
    return maxMountPercent(diskUsage, mounts);
  }
  const realDisks = diskUsage.filter(
    (row) => row.filesystem === null || row.filesystem === undefined || !VIRTUAL_FILESYSTEMS.has(String(row.filesystem)),
  );
  if (!realDisks.length) {
    return null;
  }
  let focus = realDisks[0];
  let focusPercent = diskPercentValue(focus.percent);
  for (const row of realDisks.slice(1)) {
    const value = diskPercentValue(row.percent);
    if (value > focusPercent) {
      focus = row;
      focusPercent = value;
    }
  }
  return focusPercent >= 0 ? focusPercent : null;
}

/** `_extract_gpu_utilization_percent` (`base.py:487`). */
function extractGpuUtilizationPercent(report: HostReportInput): number | null {
  const gpus = report.metrics?.gpu_summary ?? [];
  if (!gpus.length) {
    return null;
  }
  const values = gpus
    .map((gpu) => gpu.utilization_percent)
    .filter((value): value is number => value !== null && value !== undefined)
    .map((value) => Number(value));
  if (!values.length) {
    return null;
  }
  return Math.max(...values);
}

/** `HostMetrics.hottest_temperature_c` property (`models.py:403`). */
function hottestTemperature(metrics: HostMetricsInput | null | undefined): number | null {
  if (!metrics) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(metrics, 'hottest_temperature_c')) {
    const explicit = metrics.hottest_temperature_c;
    return explicit === null || explicit === undefined ? null : Number(explicit);
  }
  const values: number[] = [];
  for (const zone of metrics.thermal_zones ?? []) {
    if (zone && zone.celsius) {
      values.push(Number(zone.celsius));
    }
  }
  for (const gpu of metrics.gpu_summary ?? []) {
    if (gpu && gpu.temperature_c !== null && gpu.temperature_c !== undefined) {
      values.push(Number(gpu.temperature_c));
    }
  }
  if (!values.length) {
    return null;
  }
  return round1(Math.max(...values));
}

/**
 * Recursively convert `Date` values to `isoformat()`-style strings so
 * {@link dumpJson} produces the same payload as Python's `to_jsonable()` +
 * `json.dumps`. Plain objects keep their key order; `undefined` values are
 * dropped (JSON's omission rule).
 */
function toJsonable(value: unknown): unknown {
  if (value instanceof Date) {
    return nowIsoUtc(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonable(item));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      const item = record[key];
      if (item === undefined) {
        continue;
      }
      out[key] = toJsonable(item);
    }
    return out;
  }
  return value;
}

// --- host_latest_snapshot ---------------------------------------------------

/**
 * Persists the latest full `HostReport` for a host (upsert by host). Mirrors
 * `save_host_snapshot` (`hosts.py:454`): a single row per host is replaced on
 * write, `collected_at` comes from `metrics.collected_at` (falling back to
 * "now"), and `raw_json` is the Python-compatible serialisation of the report.
 */
export function saveHostSnapshot(db: SqliteDatabase, report: HostReportInput): void {
  const metrics = report.metrics ?? null;
  const collectedAt =
    metrics && metrics.collected_at !== null && metrics.collected_at !== undefined
      ? toIsoUtc(metrics.collected_at)
      : nowIsoUtc();
  const rawJson = dumpJson(toJsonable(report));

  db.prepare(
    `INSERT INTO host_latest_snapshot (host_name, collected_at, success, raw_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(host_name) DO UPDATE SET
       collected_at = excluded.collected_at,
       success = excluded.success,
       raw_json = excluded.raw_json`,
  ).run(report.host_name, collectedAt, flag(report.success), rawJson);
}

/** Decodes a `host_latest_snapshot` row into the Python dict shape. */
function decodeSnapshot(row: {
  host_name: string;
  collected_at: string;
  success: number;
  raw_json: string;
}): HostSnapshot {
  const raw = row.raw_json
    ? loadJson<Record<string, unknown>>(row.raw_json)
    : {};
  return {
    host_name: row.host_name,
    collected_at: row.collected_at,
    success: Boolean(row.success),
    metrics: Object.prototype.hasOwnProperty.call(raw, 'metrics')
      ? (raw.metrics as Record<string, unknown>)
      : {},
    errors: Object.prototype.hasOwnProperty.call(raw, 'errors')
      ? (raw.errors as unknown[])
      : [],
  };
}

/** Returns the latest snapshot dict for `hostName`, or `null`. Mirrors `get_host_snapshot`. */
export function getHostSnapshot(db: SqliteDatabase, hostName: string): HostSnapshot | null {
  const row = db
    .prepare(
      'SELECT host_name, collected_at, success, raw_json'
        + ' FROM host_latest_snapshot WHERE host_name = ?',
    )
    .get(hostName) as
    | { host_name: string; collected_at: string; success: number; raw_json: string }
    | undefined;
  if (!row) {
    return null;
  }
  return decodeSnapshot(row);
}

/** Returns one snapshot per host, ordered by host name. Mirrors `get_all_host_snapshots`. */
export function getAllHostSnapshots(db: SqliteDatabase): HostSnapshot[] {
  const rows = db
    .prepare(
      'SELECT host_name, collected_at, success, raw_json'
        + ' FROM host_latest_snapshot ORDER BY host_name',
    )
    .all() as Array<{
    host_name: string;
    collected_at: string;
    success: number;
    raw_json: string;
  }>;
  return rows.map(decodeSnapshot);
}

// --- host_check_snapshot ----------------------------------------------------

/**
 * Replaces the latest check snapshot for `hostName` in one `BEGIN IMMEDIATE`
 * transaction. Mirrors `save_host_check_results` (`hosts.py:403`): existing
 * rows are deleted first so removing a configured check also removes its stale
 * result; any error rolls the whole thing back.
 */
export function saveHostCheckResults(
  db: SqliteDatabase,
  hostName: string,
  results: readonly HostCheckResultInput[],
): void {
  const now = nowIsoUtc();
  const rows = results.map((item) => [
    hostName,
    item.name,
    item.type,
    item.target,
    item.status,
    item.message ?? '',
    item.latency_ms ?? null,
    item.checked_at !== null && item.checked_at !== undefined
      ? toIsoUtc(item.checked_at)
      : now,
  ]);

  const deleteStmt = db.prepare('DELETE FROM host_check_snapshot WHERE host_name = ?');
  const insertStmt = db.prepare(
    `INSERT INTO host_check_snapshot
       (host_name, check_name, check_type, target, status,
        message, latency_ms, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const run = db.transaction(() => {
    deleteStmt.run(hostName);
    for (const row of rows) {
      insertStmt.run(...row);
    }
  });
  run.immediate();
}

/** Returns the latest check snapshot for `hostName`, ordered by check name. */
export function getHostCheckResults(
  db: SqliteDatabase,
  hostName: string,
): HostCheckResultRow[] {
  return db
    .prepare(
      `SELECT host_name, check_name, check_type, target, status,
              message, latency_ms, checked_at
       FROM host_check_snapshot
       WHERE host_name = ?
       ORDER BY check_name`,
    )
    .all(hostName) as HostCheckResultRow[];
}

/** Returns the latest check snapshot for every host, grouped by host name. */
export function getAllHostCheckResults(
  db: SqliteDatabase,
): Record<string, HostCheckResultRow[]> {
  const rows = db
    .prepare(
      `SELECT host_name, check_name, check_type, target, status,
              message, latency_ms, checked_at
       FROM host_check_snapshot
       ORDER BY host_name, check_name`,
    )
    .all() as HostCheckResultRow[];

  const grouped: Record<string, HostCheckResultRow[]> = {};
  for (const row of rows) {
    const key = String(row.host_name);
    (grouped[key] ??= []).push(row);
  }
  return grouped;
}

/**
 * Deletes every stored check result for `hostName` (snapshot + history).
 * Mirrors `delete_host_check_results` (`hosts.py:93`); both deletes are wrapped
 * in one transaction so they commit together.
 */
export function deleteHostCheckResults(db: SqliteDatabase, hostName: string): void {
  const deleteSnapshot = db.prepare('DELETE FROM host_check_snapshot WHERE host_name = ?');
  const deleteHistory = db.prepare('DELETE FROM host_check_history WHERE host_name = ?');
  db.transaction(() => {
    deleteSnapshot.run(hostName);
    deleteHistory.run(hostName);
  })();
}

// --- network rates ----------------------------------------------------------

interface HistorySample {
  collected_at: string;
  net_rx_bytes: number | null;
  net_tx_bytes: number | null;
}

/**
 * `_network_rate_pair` (`base.py:611`): compute rx/tx bytes-per-second from a
 * host's two most recent `(collected_at, rx, tx)` samples (newest first). A
 * non-positive interval or a negative delta (counter reset) yields `null`.
 */
function networkRatePair(rows: readonly HistorySample[]): NetworkRate {
  const empty: NetworkRate = { rx_bytes_per_second: null, tx_bytes_per_second: null };
  if (rows.length < 2) {
    return empty;
  }
  const [latest, previous] = rows;
  let latestAt: Date;
  let previousAt: Date;
  try {
    latestAt = parseCollectedAt(latest.collected_at);
    previousAt = parseCollectedAt(previous.collected_at);
  } catch {
    return empty;
  }
  const seconds = (latestAt.getTime() - previousAt.getTime()) / 1000;
  if (!(seconds > 0)) {
    return empty;
  }

  const rate = (current: number | null, before: number | null): number | null => {
    if (current === null || before === null) {
      return null;
    }
    const delta = Math.trunc(Number(current)) - Math.trunc(Number(before));
    if (delta < 0) {
      return null;
    }
    return round1(delta / seconds);
  };

  return {
    rx_bytes_per_second: rate(latest.net_rx_bytes, previous.net_rx_bytes),
    tx_bytes_per_second: rate(latest.net_tx_bytes, previous.net_tx_bytes),
  };
}

/** Returns instantaneous rx/tx bytes-per-second for one host. Mirrors `fetch_host_network_rates`. */
export function fetchHostNetworkRates(db: SqliteDatabase, hostName: string): NetworkRate {
  const rows = db
    .prepare(
      `SELECT collected_at, net_rx_bytes, net_tx_bytes
         FROM host_metrics_history
        WHERE host_name = ? AND success = 1
          AND net_rx_bytes IS NOT NULL AND net_tx_bytes IS NOT NULL
        ORDER BY collected_at DESC
        LIMIT 2`,
    )
    .all(hostName) as HistorySample[];
  return networkRatePair(rows);
}

/** Returns {@link fetchHostNetworkRates} for every host, in one query. */
export function fetchAllHostNetworkRates(db: SqliteDatabase): Record<string, NetworkRate> {
  const rows = db
    .prepare(
      `SELECT host_name, collected_at, net_rx_bytes, net_tx_bytes FROM (
         SELECT host_name, collected_at, net_rx_bytes, net_tx_bytes,
                ROW_NUMBER() OVER (
                    PARTITION BY host_name ORDER BY collected_at DESC
                ) AS rn
         FROM host_metrics_history
         WHERE success = 1 AND net_rx_bytes IS NOT NULL
           AND net_tx_bytes IS NOT NULL
       ) WHERE rn <= 2
       ORDER BY host_name, collected_at DESC`,
    )
    .all() as Array<HistorySample & { host_name: string }>;

  const grouped = new Map<string, HistorySample[]>();
  for (const row of rows) {
    const key = String(row.host_name);
    const list = grouped.get(key);
    if (list) {
      list.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }

  const result: Record<string, NetworkRate> = {};
  for (const [host, samples] of grouped) {
    result[host] = samples.length >= 2
      ? networkRatePair(samples)
      : { rx_bytes_per_second: null, tx_bytes_per_second: null };
  }
  return result;
}

// --- host_metrics_history + host_daily_summary (persist_host_reports) ------

/** One `_merge_daily_summary` value bag. */
interface DailySummaryValues {
  cpu: number | null;
  memory_pct: number | null;
  disk_pct: number | null;
  gpu_util: number | null;
  gpu_memory_pct: number | null;
  load: number | null;
  users: number | null;
  processes: number | null;
}

/**
 * Accumulate one successful sample into `host_daily_summary`. Mirrors
 * `_merge_daily_summary` (`metrics.py:79`): insert on first sample, otherwise
 * add to the `*_sum` columns and widen `*_max`/`*_min` (only `cpu` has a
 * `_min` column). Missing values are ignored rather than written as zero.
 */
function mergeDailySummary(
  db: SqliteDatabase,
  params: {
    day: string;
    hostName: string;
    host: string;
    tzKey: string;
    values: DailySummaryValues;
    updatedAt: string;
  },
): void {
  const { day, hostName, host, tzKey, values, updatedAt } = params;
  const existing = db
    .prepare('SELECT * FROM host_daily_summary WHERE day = ? AND host_name = ? AND tz = ?')
    .get(day, hostName, tzKey) as Record<string, unknown> | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO host_daily_summary
         (day, host_name, tz, host, sample_count, success_count,
          cpu_sum, cpu_max, cpu_min, memory_pct_sum, memory_pct_max,
          disk_pct_sum, disk_pct_max, gpu_util_sum, gpu_util_max,
          gpu_memory_pct_sum, gpu_memory_pct_max, load_sum, users_sum,
          processes_sum, updated_at)
       VALUES
         (:day, :host_name, :tz, :host, :sample_count, :success_count,
          :cpu_sum, :cpu_max, :cpu_min, :memory_pct_sum, :memory_pct_max,
          :disk_pct_sum, :disk_pct_max, :gpu_util_sum, :gpu_util_max,
          :gpu_memory_pct_sum, :gpu_memory_pct_max, :load_sum, :users_sum,
          :processes_sum, :updated_at)`,
    ).run({
      day,
      host_name: hostName,
      tz: tzKey,
      host,
      sample_count: 1,
      success_count: 1,
      cpu_sum: values.cpu,
      cpu_max: values.cpu,
      cpu_min: values.cpu,
      memory_pct_sum: values.memory_pct,
      memory_pct_max: values.memory_pct,
      disk_pct_sum: values.disk_pct,
      disk_pct_max: values.disk_pct,
      gpu_util_sum: values.gpu_util,
      gpu_util_max: values.gpu_util,
      gpu_memory_pct_sum: values.gpu_memory_pct,
      gpu_memory_pct_max: values.gpu_memory_pct,
      load_sum: values.load,
      users_sum: values.users,
      processes_sum: values.processes,
      updated_at: updatedAt,
    });
    return;
  }

  // Start from a copy of the existing row (like Python's `dict(existing)`) so
  // every column keeps its current value when an incoming value is missing.
  const updated: Record<string, unknown> = { ...existing };
  updated.host = host;
  updated.sample_count = Number(existing.sample_count) + 1;
  updated.success_count = Number(existing.success_count) + 1;
  updated.updated_at = updatedAt;

  const prefixes: Array<[string, number | null]> = [
    ['cpu', values.cpu],
    ['memory_pct', values.memory_pct],
    ['disk_pct', values.disk_pct],
    ['gpu_util', values.gpu_util],
    ['gpu_memory_pct', values.gpu_memory_pct],
    ['load', values.load],
    ['users', values.users],
    ['processes', values.processes],
  ];
  for (const [prefix, value] of prefixes) {
    if (value === null) {
      // Missing values are ignored rather than written as zero.
      continue;
    }
    const sumKey = `${prefix}_sum`;
    const maxKey = `${prefix}_max`;
    const minKey = `${prefix}_min`;
    updated[sumKey] = Number(existing[sumKey] ?? 0) + Number(value);
    if (Object.prototype.hasOwnProperty.call(existing, maxKey)) {
      const oldMax = existing[maxKey];
      updated[maxKey] = oldMax === null || oldMax === undefined
        ? Number(value)
        : Math.max(Number(oldMax), Number(value));
    }
    if (Object.prototype.hasOwnProperty.call(existing, minKey)) {
      const oldMin = existing[minKey];
      updated[minKey] = oldMin === null || oldMin === undefined
        ? Number(value)
        : Math.min(Number(oldMin), Number(value));
    }
  }

  db.prepare(
    `UPDATE host_daily_summary SET
       host = :host, sample_count = :sample_count,
       success_count = :success_count, cpu_sum = :cpu_sum,
       cpu_max = :cpu_max, cpu_min = :cpu_min,
       memory_pct_sum = :memory_pct_sum, memory_pct_max = :memory_pct_max,
       disk_pct_sum = :disk_pct_sum, disk_pct_max = :disk_pct_max,
       gpu_util_sum = :gpu_util_sum, gpu_util_max = :gpu_util_max,
       gpu_memory_pct_sum = :gpu_memory_pct_sum,
       gpu_memory_pct_max = :gpu_memory_pct_max,
       load_sum = :load_sum, users_sum = :users_sum,
       processes_sum = :processes_sum, updated_at = :updated_at
     WHERE day = :day AND host_name = :host_name AND tz = :tz`,
  ).run({
    day,
    host_name: hostName,
    tz: tzKey,
    host,
    sample_count: updated.sample_count,
    success_count: updated.success_count,
    cpu_sum: updated.cpu_sum,
    cpu_max: updated.cpu_max,
    cpu_min: updated.cpu_min,
    memory_pct_sum: updated.memory_pct_sum,
    memory_pct_max: updated.memory_pct_max,
    disk_pct_sum: updated.disk_pct_sum,
    disk_pct_max: updated.disk_pct_max,
    gpu_util_sum: updated.gpu_util_sum,
    gpu_util_max: updated.gpu_util_max,
    gpu_memory_pct_sum: updated.gpu_memory_pct_sum,
    gpu_memory_pct_max: updated.gpu_memory_pct_max,
    load_sum: updated.load_sum,
    users_sum: updated.users_sum,
    processes_sum: updated.processes_sum,
    updated_at: updated.updated_at,
  });
}

/** One prepared `host_metrics_history` insert row (19 columns). */
type MetricsRow = [
  string, // collected_at
  string, // host_name
  string, // host
  number, // success
  number | null, // cpu_usage_percent
  number | null, // memory_used_mb
  number | null, // memory_total_mb
  number | null, // disk_used_percent
  number | null, // gpu_utilization_percent
  number | null, // gpu_memory_used_mb
  number | null, // gpu_memory_total_mb
  number | null, // total_processes
  number, // logged_in_user_count
  number | null, // load_1
  number | null, // load_5
  number | null, // load_15
  number | null, // net_rx_bytes
  number | null, // net_tx_bytes
  number | null, // temperature_c
];

/**
 * Persists a `DailyReport`'s successful host reports into `host_metrics_history`
 * and accumulates them into `host_daily_summary`. Mirrors `persist_host_reports`
 * (`hosts.py:282`): the metrics insert and the summary read-modify-write share
 * one `BEGIN IMMEDIATE` transaction so a concurrent writer cannot cause a lost
 * update. Failed reports are skipped. Accepts either a `DailyReport` or a bare
 * array of `HostReport`s.
 */
export function persistHostReports(
  db: SqliteDatabase,
  report: DailyReportInput | readonly HostReportInput[],
  options: PersistHostReportsOptions = {},
): void {
  const reports: readonly HostReportInput[] = Array.isArray(report)
    ? (report as readonly HostReportInput[])
    : ((report as DailyReportInput).reports ?? []);
  const diskMounts = options.diskMounts ?? null;
  const tz = options.tz ?? 'UTC';
  const collectedAt = nowIsoUtc();

  const rows: MetricsRow[] = [];
  const summaryRows: Array<{
    day: string;
    hostName: string;
    host: string;
    values: DailySummaryValues;
  }> = [];

  for (const hostReport of reports) {
    if (!hostReport.success) {
      continue;
    }
    const metrics = hostReport.metrics ?? {};
    const rowCollectedAt =
      metrics.collected_at !== null && metrics.collected_at !== undefined
        ? toIsoUtc(metrics.collected_at)
        : collectedAt;
    const memory = metrics.memory ?? null;
    const load = metrics.load_average ?? null;
    const hostMounts = diskMounts ? diskMounts[hostReport.host_name] : undefined;

    const diskPct = extractDiskUsedPercent(hostReport, hostMounts);
    const gpuUtil = extractGpuUtilizationPercent(hostReport);
    const gpuSummaries = metrics.gpu_summary ?? [];
    const gpuUsed = gpuSummaries.length
      ? gpuSummaries.reduce((total, gpu) => total + Number(gpu.memory_used_mb ?? 0), 0)
      : null;
    const gpuTotal = gpuSummaries.length
      ? gpuSummaries.reduce((total, gpu) => total + Number(gpu.memory_total_mb ?? 0), 0)
      : null;
    const loggedInUserCount = (metrics.logged_in_users ?? []).length;

    rows.push([
      rowCollectedAt,
      hostReport.host_name,
      hostReport.host,
      1,
      metrics.cpu_usage_percent ?? null,
      memory?.used_mb ?? null,
      memory?.total_mb ?? null,
      diskPct,
      gpuUtil,
      gpuUsed,
      gpuTotal,
      metrics.total_processes ?? null,
      loggedInUserCount,
      load?.load_1 ?? null,
      load?.load_5 ?? null,
      load?.load_15 ?? null,
      metrics.net_rx_bytes ?? null,
      metrics.net_tx_bytes ?? null,
      hottestTemperature(metrics),
    ]);

    summaryRows.push({
      day: localDay(rowCollectedAt, tz),
      hostName: hostReport.host_name,
      host: hostReport.host,
      values: {
        cpu: metrics.cpu_usage_percent ?? null,
        memory_pct: percentValue(memory?.used_mb, memory?.total_mb),
        disk_pct: diskPct,
        gpu_util: gpuUtil,
        gpu_memory_pct: percentValue(gpuUsed, gpuTotal),
        load: load?.load_1 ?? null,
        users: loggedInUserCount,
        processes: metrics.total_processes ?? null,
      },
    });
  }

  if (!rows.length) {
    return;
  }

  const insertStmt = db.prepare(
    `INSERT INTO host_metrics_history (
       collected_at, host_name, host, success, cpu_usage_percent,
       memory_used_mb, memory_total_mb, disk_used_percent,
       gpu_utilization_percent, gpu_memory_used_mb, gpu_memory_total_mb,
       total_processes, logged_in_user_count, load_1, load_5, load_15,
       net_rx_bytes, net_tx_bytes, temperature_c
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tzKey = tz;
  const run = db.transaction(() => {
    for (const row of rows) {
      insertStmt.run(...row);
    }
    for (const summaryRow of summaryRows) {
      mergeDailySummary(db, {
        day: summaryRow.day,
        hostName: summaryRow.hostName,
        host: summaryRow.host,
        tzKey,
        values: summaryRow.values,
        updatedAt: collectedAt,
      });
    }
  });
  run.immediate();
}
