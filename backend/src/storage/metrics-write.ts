/**
 * Metric write / summary / prune side, mirroring the Python oracle
 * `servermanage/storage/metrics.py`:
 *
 * - `append_host_check_history` (`metrics.py:192`) -> {@link appendHostCheckHistory}
 * - `_merge_daily_summary` (`metrics.py:79`)       -> {@link mergeDailySummary}
 * - `backfill_daily_summary` (`metrics.py:255`)    -> {@link backfillDailySummary}
 * - `get_host_check_history` (`metrics.py:1051`)   -> {@link getHostCheckHistory}
 * - `get_all_host_check_history` (`metrics.py:1016`) -> {@link getAllHostCheckHistory}
 * - `prune_daily_summary` (`metrics.py:1080`)      -> {@link pruneDailySummary}
 * - `prune_host_metrics` (`metrics.py:1100`)       -> {@link pruneHostMetrics}
 *
 * The Python oracle opens a short-lived connection per call (`_connect` +
 * `init_storage`). The Node backend runs one long-lived `better-sqlite3` handle
 * for the whole process, so every function here takes that handle (`db`) as its
 * first argument instead of a `db_path` — the same convention used by
 * `./settings` and `./tasks`. Row shapes keep the Python column names
 * (`host_name`, `check_name`, `sample_count`, ...) so results match
 * `dict(sqlite3.Row)` byte-for-byte for the differential harness.
 */
import { nowIsoUtc } from './time';

type SqliteDatabase = import('better-sqlite3').Database;

/**
 * A check result accepted by {@link appendHostCheckHistory}.
 *
 * Field names mirror the Python `HostCheckResult` dataclass (`models.py:52`):
 * `name`, `status`, `latency_ms`, `checked_at`. The camelCase aliases
 * (`latencyMs`, `checkedAt`) are also accepted so callers holding TypeScript
 * shaped results do not need to re-map them; `latency_ms` wins when both are
 * present, matching a direct attribute read from the Python object.
 */
export interface HostCheckResultLike {
  name: string;
  status: string;
  type?: string;
  target?: string;
  message?: string;
  /** Latency in milliseconds (`HostCheckResult.latency_ms`). */
  latencyMs?: number | null;
  latency_ms?: number | null;
  /** Check timestamp; `Date` or ISO string. Defaults to "now" when omitted. */
  checkedAt?: Date | string | null;
  checked_at?: Date | string | null;
}

/** One successful sample's metric values accumulated into a daily summary. */
export interface DailySummaryValues {
  cpu?: number | null;
  memory_pct?: number | null;
  disk_pct?: number | null;
  gpu_util?: number | null;
  gpu_memory_pct?: number | null;
  load?: number | null;
  users?: number | null;
  processes?: number | null;
}

/** Arguments to {@link mergeDailySummary} (mirrors `_merge_daily_summary`). */
export interface MergeDailySummaryInput {
  /** Local calendar day key, `YYYY-MM-DD`. */
  day: string;
  hostName: string;
  host: string;
  /** Timezone partition key (`_tz_key`); defaults to `'UTC'`. */
  tzKey?: string;
  values: DailySummaryValues;
  /** ISO-8601 UTC `updated_at`; defaults to {@link nowIsoUtc}. */
  updatedAt?: string;
}

/** Options accepted by {@link backfillDailySummary}. */
export interface BackfillDailySummaryOptions {
  /**
   * IANA timezone name used to bucket raw samples into local days. Matches the
   * Python `tz: tzinfo` parameter; its `tz_key` partition value is this string.
   * Defaults to `'UTC'`.
   */
  tz?: string;
}

/** Options accepted by {@link pruneDailySummary}. */
export interface PruneDailySummaryOptions {
  /** Reference instant for the cutoff (Python `now`). Defaults to "now" (UTC). */
  now?: Date;
}

/**
 * Day-bucket mutation counters used by {@link backfillDailySummary}. Keys mirror
 * the Python `bucket` dict (`<prefix>_sum`, `<prefix>_max`, and `cpu_min`); the
 * index signature keeps the dynamic prefix loop type-safe.
 */
type SummaryBucket = Record<string, number | null>;

/** Metric prefixes and the matching daily-summary column families. */
const SUMMARY_PREFIXES: ReadonlyArray<keyof DailySummaryValues> = [
  'cpu',
  'memory_pct',
  'disk_pct',
  'gpu_util',
  'gpu_memory_pct',
  'load',
  'users',
  'processes',
];

/** True for SQLite "no such table" errors (an uninitialised/old database). */
function isMissingTable(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message);
}

/** Left-pad a non-negative integer to `width` digits. */
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** `YYYY-MM-DD` for the UTC calendar day of `d`. */
function utcDateIso(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(
    d.getUTCDate(),
    2,
  )}`;
}

/**
 * Normalises a `datetime`/ISO string to an ISO-8601 UTC string, mirroring
 * `base._to_iso_utc` (`base.py:719`): `Date` is rendered via
 * {@link nowIsoUtc}, strings are returned unchanged.
 */
function toIsoUtc(value: Date | string): string {
  return value instanceof Date ? nowIsoUtc(value) : String(value);
}

/**
 * Parses a stored `collected_at` string, mirroring `_parse_collected_at`
 * (`base.py:647`): naive timestamps are interpreted as UTC and a space date/time
 * separator (legacy `sqlite3` style) is accepted.
 */
function parseCollectedAt(value: string): Date {
  let text = String(value).trim();
  // Python's fromisoformat accepts a space between date and time; normalise it
  // to `T` so every JS engine parses it the same way.
  text = text.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T');
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text);
  const parsed = new Date(hasZone ? text : `${text}Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`invalid collected_at value: ${value}`);
  }
  return parsed;
}

/** `_percent_value` (`base.py:674`): `used / total * 100`, or `null` when unusable. */
function percentValue(used: unknown, total: unknown): number | null {
  if (used === null || used === undefined || total === null || total === undefined) {
    return null;
  }
  const usedNum = Number(used);
  const totalNum = Number(total);
  if (!(totalNum > 0)) {
    return null;
  }
  return (usedNum / totalNum) * 100.0;
}

/** Local calendar day (`YYYY-MM-DD`) of `d` in the IANA zone `tz`. */
function localDayIso(d: Date, tz: string): string {
  if (tz === 'UTC' || tz === 'Etc/UTC' || tz === 'Etc/GMT') {
    return utcDateIso(d);
  }
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(d);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Deletes matching rows in bounded batches, returning the total removed.
 * Ports `base._delete_rows_in_chunks` (`base.py:984`): `DELETE ... LIMIT` is not
 * reliably compiled in, so each batch is a `rowid IN (SELECT ... LIMIT ?)`.
 */
function deleteRowsInChunks(
  db: SqliteDatabase,
  table: string,
  whereSql: string,
  params: ReadonlyArray<unknown>,
  chunk = 500,
): number {
  const statement = db.prepare(
    `DELETE FROM ${table} WHERE rowid IN (
       SELECT rowid FROM ${table} WHERE ${whereSql} LIMIT ?
     )`,
  );
  let total = 0;
  for (;;) {
    const info = statement.run(...params, chunk);
    const deleted = info.changes;
    total += deleted;
    if (deleted < chunk) {
      break;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Check history
// ---------------------------------------------------------------------------

/**
 * Appends one heartbeat row per check and prunes each check to `keep` rows.
 * Mirrors `append_host_check_history` (`metrics.py:192`): the insert + prune run
 * in a single `BEGIN IMMEDIATE` transaction so the table stays bounded and
 * concurrent writers serialise.
 *
 * The prune keeps the newest `keep * len(results)` rows for the host, i.e.
 * `keep` rows per check name in this batch.
 */
export function appendHostCheckHistory(
  db: SqliteDatabase,
  hostName: string,
  results: ReadonlyArray<HostCheckResultLike>,
  opts: { keep?: number } = {},
): void {
  if (results.length === 0) {
    return;
  }
  const keep = Math.max(1, Math.trunc(opts.keep ?? 60));
  const now = new Date();

  const rows = results.map((item): [string, string, string, number | null, string] => {
    const latency = item.latency_ms ?? item.latencyMs ?? null;
    const checked = item.checked_at ?? item.checkedAt ?? now;
    return [hostName, item.name, item.status, latency, toIsoUtc(checked)];
  });

  const insert = db.prepare(
    `INSERT INTO host_check_history
       (host_name, check_name, status, latency_ms, checked_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const prune = db.prepare(
    `DELETE FROM host_check_history
      WHERE host_name = ?
        AND id NOT IN (
            SELECT id FROM host_check_history
            WHERE host_name = ?
            ORDER BY id DESC
            LIMIT ?
        )`,
  );

  const apply = db.transaction(() => {
    for (const row of rows) {
      insert.run(...row);
    }
    prune.run(hostName, hostName, keep * Math.max(1, rows.length));
  });
  apply.immediate();
}

/**
 * Returns `{check_name: [oldest…newest statuses]}` for `hostName`, newest checks
 * limited to `limit` per check name. Mirrors `get_host_check_history`
 * (`metrics.py:1051`).
 */
export function getHostCheckHistory(
  db: SqliteDatabase,
  hostName: string,
  opts: { limit?: number } = {},
): Record<string, string[]> {
  const limit = Math.max(1, Math.trunc(opts.limit ?? 40));
  let rows: Array<{ check_name: string; status: string; id: number }>;
  try {
    rows = db
      .prepare(
        `SELECT check_name, status, id
           FROM host_check_history
          WHERE host_name = ?
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(hostName, limit * 32) as Array<{
      check_name: string;
      status: string;
      id: number;
    }>;
  } catch (err) {
    if (isMissingTable(err)) {
      return {};
    }
    throw err;
  }

  const grouped: Record<string, string[]> = {};
  // reversed(rows): oldest -> newest, so each bucket appends oldest…newest.
  for (const row of rows.slice().reverse()) {
    (grouped[row.check_name] ??= []).push(row.status);
  }
  const result: Record<string, string[]> = {};
  for (const [name, statuses] of Object.entries(grouped)) {
    result[name] = statuses.slice(-limit);
  }
  return result;
}

/**
 * Returns `getHostCheckHistory` for every host in one query. Mirrors
 * `get_all_host_check_history` (`metrics.py:1016`).
 */
export function getAllHostCheckHistory(
  db: SqliteDatabase,
  opts: { limit?: number } = {},
): Record<string, Record<string, string[]>> {
  const limit = Math.max(1, Math.trunc(opts.limit ?? 40));
  let rows: Array<{ host_name: string; check_name: string; status: string }>;
  try {
    rows = db
      .prepare(
        `SELECT host_name, check_name, status FROM (
           SELECT host_name, check_name, status,
                  ROW_NUMBER() OVER (
                      PARTITION BY host_name ORDER BY id DESC
                  ) AS rn
             FROM host_check_history
         ) WHERE rn <= ?
         ORDER BY host_name, rn DESC`,
      )
      .all(limit * 32) as Array<{
      host_name: string;
      check_name: string;
      status: string;
    }>;
  } catch (err) {
    if (isMissingTable(err)) {
      return {};
    }
    throw err;
  }

  const grouped: Record<string, Record<string, string[]>> = {};
  for (const row of rows) {
    const hostGroup = (grouped[row.host_name] ??= {});
    (hostGroup[row.check_name] ??= []).push(row.status);
  }

  const result: Record<string, Record<string, string[]>> = {};
  for (const [host, hostGroup] of Object.entries(grouped)) {
    const trimmed: Record<string, string[]> = {};
    for (const [name, statuses] of Object.entries(hostGroup)) {
      trimmed[name] = statuses.slice(-limit);
    }
    result[host] = trimmed;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Daily summary
// ---------------------------------------------------------------------------

/**
 * Accumulates one successful sample into `host_daily_summary`, keeping
 * sums/max/min (so a day stays exact after its raw points are pruned). Mirrors
 * `_merge_daily_summary` (`metrics.py:79`): a missing row is inserted, otherwise
 * the existing row is updated in place. Missing metric values are ignored rather
 * than written as zero.
 *
 * Note: the Python oracle implements the upsert as SELECT-then-INSERT/UPDATE
 * (not `INSERT ... ON CONFLICT DO UPDATE`), because the merge needs the existing
 * sums and max/min in hand. This port reproduces that algorithm exactly so the
 * resulting numeric columns match byte-for-byte.
 *
 * Runs no transaction of its own — the caller (e.g. `persistHostReports`) owns
 * the surrounding transaction, matching the Python `conn`-taking signature.
 */
export function mergeDailySummary(db: SqliteDatabase, input: MergeDailySummaryInput): void {
  const day = input.day;
  const hostName = input.hostName;
  const host = input.host;
  const tzKey = input.tzKey ?? 'UTC';
  const values = input.values;
  const updatedAt = input.updatedAt ?? nowIsoUtc();

  const existing = db
    .prepare('SELECT * FROM host_daily_summary WHERE day = ? AND host_name = ? AND tz = ?')
    .get(day, hostName, tzKey) as Record<string, unknown> | undefined;

  if (existing === undefined) {
    const value = (key: keyof DailySummaryValues): number | null => values[key] ?? null;
    db.prepare(
      `INSERT INTO host_daily_summary
         (day, host_name, tz, host, sample_count, success_count,
          cpu_sum, cpu_max, cpu_min, memory_pct_sum, memory_pct_max,
          disk_pct_sum, disk_pct_max, gpu_util_sum, gpu_util_max,
          gpu_memory_pct_sum, gpu_memory_pct_max, load_sum, users_sum,
          processes_sum, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      day,
      hostName,
      tzKey,
      host,
      1,
      1,
      value('cpu'),
      value('cpu'),
      value('cpu'),
      value('memory_pct'),
      value('memory_pct'),
      value('disk_pct'),
      value('disk_pct'),
      value('gpu_util'),
      value('gpu_util'),
      value('gpu_memory_pct'),
      value('gpu_memory_pct'),
      value('load'),
      value('users'),
      value('processes'),
      updatedAt,
    );
    return;
  }

  const merged: Record<string, unknown> = { ...existing };
  merged.sample_count = Number(existing.sample_count) + 1;
  merged.success_count = Number(existing.success_count) + 1;
  // NOTE: the oracle never overwrites `host` on the update path — `updated =
  // dict(existing)` leaves the stored value in place and the SET clause writes
  // it back unchanged, so the `host` argument only takes effect on INSERT.
  merged.updated_at = updatedAt;

  for (const prefix of SUMMARY_PREFIXES) {
    const value = values[prefix];
    if (value === null || value === undefined) {
      continue;
    }
    merged[`${prefix}_sum`] = Number(existing[`${prefix}_sum`] ?? 0) + Number(value);
    const maxKey = `${prefix}_max`;
    if (maxKey in merged) {
      const oldMax = numberOrNull(existing[maxKey]);
      merged[maxKey] = oldMax === null ? Number(value) : Math.max(oldMax, Number(value));
    }
    const minKey = `${prefix}_min`;
    if (minKey in merged) {
      const oldMin = numberOrNull(existing[minKey]);
      merged[minKey] = oldMin === null ? Number(value) : Math.min(oldMin, Number(value));
    }
  }

  db.prepare(
    `UPDATE host_daily_summary SET
        host = ?, sample_count = ?, success_count = ?, cpu_sum = ?,
        cpu_max = ?, cpu_min = ?, memory_pct_sum = ?, memory_pct_max = ?,
        disk_pct_sum = ?, disk_pct_max = ?, gpu_util_sum = ?, gpu_util_max = ?,
        gpu_memory_pct_sum = ?, gpu_memory_pct_max = ?, load_sum = ?, users_sum = ?,
        processes_sum = ?, updated_at = ?
      WHERE day = ? AND host_name = ? AND tz = ?`,
  ).run(
    merged.host as string,
    merged.sample_count as number,
    merged.success_count as number,
    numberOrNull(merged.cpu_sum),
    numberOrNull(merged.cpu_max),
    numberOrNull(merged.cpu_min),
    numberOrNull(merged.memory_pct_sum),
    numberOrNull(merged.memory_pct_max),
    numberOrNull(merged.disk_pct_sum),
    numberOrNull(merged.disk_pct_max),
    numberOrNull(merged.gpu_util_sum),
    numberOrNull(merged.gpu_util_max),
    numberOrNull(merged.gpu_memory_pct_sum),
    numberOrNull(merged.gpu_memory_pct_max),
    numberOrNull(merged.load_sum),
    numberOrNull(merged.users_sum),
    numberOrNull(merged.processes_sum),
    merged.updated_at as string,
    day,
    hostName,
    tzKey,
  );
}

/**
 * Creates missing daily-summary rows from existing raw history. Mirrors
 * `backfill_daily_summary` (`metrics.py:255`): only days that still have raw
 * `success = 1` samples can be reconstructed, and already-present summary rows
 * are left untouched so repeated runs are idempotent. Returns the number of rows
 * inserted.
 */
export function backfillDailySummary(
  db: SqliteDatabase,
  opts: BackfillDailySummaryOptions = {},
): number {
  const tz = opts.tz ?? 'UTC';
  const tzKey = tz;

  const rawRows = db
    .prepare(
      `SELECT collected_at, host_name, host, cpu_usage_percent,
              memory_used_mb, memory_total_mb, disk_used_percent,
              gpu_utilization_percent, gpu_memory_used_mb,
              gpu_memory_total_mb, total_processes, logged_in_user_count,
              load_1
         FROM host_metrics_history
        WHERE success = 1`,
    )
    .all() as Array<Record<string, unknown>>;

  interface Aggregated {
    day: string;
    host_name: string;
    host: string;
    bucket: SummaryBucket;
  }
  const aggregated = new Map<string, Aggregated>();

  for (const row of rawRows) {
    const collectedAt = String(row.collected_at);
    const day = localDayIso(parseCollectedAt(collectedAt), tz);
    const hostName = String(row.host_name);
    const host = String(row.host);
    const key = JSON.stringify([day, hostName, host, tzKey]);
    let entry = aggregated.get(key);
    if (entry === undefined) {
      entry = {
        day,
        host_name: hostName,
        host,
        bucket: {
          sample_count: 0,
          cpu_sum: 0.0,
          cpu_max: null,
          cpu_min: null,
          memory_pct_sum: 0.0,
          memory_pct_max: null,
          disk_pct_sum: 0.0,
          disk_pct_max: null,
          gpu_util_sum: 0.0,
          gpu_util_max: null,
          gpu_memory_pct_sum: 0.0,
          gpu_memory_pct_max: null,
          load_sum: 0.0,
          users_sum: 0.0,
          processes_sum: 0.0,
        },
      };
      aggregated.set(key, entry);
    }
    const bucket = entry.bucket;
    bucket.sample_count = Number(bucket.sample_count ?? 0) + 1;

    const values: DailySummaryValues = {
      cpu: numberOrNull(row.cpu_usage_percent),
      memory_pct: percentValue(row.memory_used_mb, row.memory_total_mb),
      disk_pct: numberOrNull(row.disk_used_percent),
      gpu_util: numberOrNull(row.gpu_utilization_percent),
      gpu_memory_pct: percentValue(row.gpu_memory_used_mb, row.gpu_memory_total_mb),
      load: numberOrNull(row.load_1),
      users: numberOrNull(row.logged_in_user_count),
      processes: numberOrNull(row.total_processes),
    };

    for (const prefix of SUMMARY_PREFIXES) {
      const value = values[prefix];
      if (value === null || value === undefined) {
        continue;
      }
      const sumKey = `${prefix}_sum`;
      bucket[sumKey] = (Number(bucket[sumKey]) || 0) + Number(value);
      const maxKey = `${prefix}_max`;
      if (maxKey in bucket) {
        const oldMax = bucket[maxKey] ?? null;
        bucket[maxKey] = oldMax === null ? Number(value) : Math.max(oldMax, Number(value));
      }
      const minKey = `${prefix}_min`;
      if (minKey in bucket) {
        const oldMin = bucket[minKey] ?? null;
        bucket[minKey] = oldMin === null ? Number(value) : Math.min(oldMin, Number(value));
      }
    }
  }

  const now = nowIsoUtc();
  const existsStmt = db.prepare(
    'SELECT 1 FROM host_daily_summary WHERE day = ? AND host_name = ? AND tz = ?',
  );
  const insertStmt = db.prepare(
    `INSERT INTO host_daily_summary
       (day, host_name, tz, host, sample_count, success_count,
        cpu_sum, cpu_max, cpu_min, memory_pct_sum, memory_pct_max,
        disk_pct_sum, disk_pct_max, gpu_util_sum, gpu_util_max,
        gpu_memory_pct_sum, gpu_memory_pct_max, load_sum, users_sum,
        processes_sum, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  const apply = db.transaction(() => {
    for (const { day, host_name, host, bucket } of aggregated.values()) {
      const exists = existsStmt.get(day, host_name, tzKey);
      if (exists !== undefined) {
        continue;
      }
      insertStmt.run(
        day,
        host_name,
        tzKey,
        host,
        bucket.sample_count,
        bucket.sample_count,
        bucket.cpu_sum,
        bucket.cpu_max,
        bucket.cpu_min,
        bucket.memory_pct_sum,
        bucket.memory_pct_max,
        bucket.disk_pct_sum,
        bucket.disk_pct_max,
        bucket.gpu_util_sum,
        bucket.gpu_util_max,
        bucket.gpu_memory_pct_sum,
        bucket.gpu_memory_pct_max,
        bucket.load_sum,
        bucket.users_sum,
        bucket.processes_sum,
        now,
      );
      inserted += 1;
    }
  });
  apply();
  return inserted;
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/**
 * Deletes daily-summary rows older than `retentionDays` (local-date key).
 * Mirrors `prune_daily_summary` (`metrics.py:1080`). Returns the deleted count.
 */
export function pruneDailySummary(
  db: SqliteDatabase,
  retentionDays = 90,
  opts: PruneDailySummaryOptions = {},
): number {
  const reference = opts.now ?? new Date();
  const days = Math.max(1, Math.trunc(retentionDays));
  const cutoffDay = utcDateIso(new Date(reference.getTime() - days * 86_400_000));
  const info = db.prepare('DELETE FROM host_daily_summary WHERE day < ?').run(cutoffDay);
  return info.changes;
}

/**
 * Keeps only the newest `maxPointsPerHost` rows for every host in
 * `host_metrics_history`. Mirrors `prune_host_metrics` (`metrics.py:1100`):
 * for each host it finds the cutoff row (`max_points_per_host + 1`-th newest via
 * `LIMIT 1 OFFSET n`), then deletes everything at or below it in
 * `(collected_at, id)` order in bounded chunks of 500. Returns total deleted.
 */
export function pruneHostMetrics(db: SqliteDatabase, maxPointsPerHost = 100): number {
  const limit = Math.max(1, Math.trunc(maxPointsPerHost));
  const chunk = 500;
  let deletedTotal = 0;

  const apply = db.transaction(() => {
    const hostNames = (
      db.prepare('SELECT DISTINCT host_name FROM host_metrics_history').all() as Array<{
        host_name: string;
      }>
    ).map((row) => row.host_name);

    const cutoffStmt = db.prepare(
      `SELECT collected_at, id
         FROM host_metrics_history
        WHERE host_name = ?
        ORDER BY collected_at DESC, id DESC
        LIMIT 1 OFFSET ?`,
    );

    for (const hostName of hostNames) {
      const cutoff = cutoffStmt.get(hostName, limit) as
        | { collected_at: string; id: number }
        | undefined;
      if (cutoff === undefined) {
        continue;
      }
      deletedTotal += deleteRowsInChunks(
        db,
        'host_metrics_history',
        'host_name = ? AND (collected_at < ? OR (collected_at = ? AND id <= ?))',
        [hostName, cutoff.collected_at, cutoff.collected_at, cutoff.id],
        chunk,
      );
    }
  });
  apply();
  return deletedTotal;
}
