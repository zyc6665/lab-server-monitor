/**
 * Alert rows and silence windows, mirroring the Python oracle
 * `servermanage/storage/alerts.py` (the *storage* layer, not the business
 * alerting logic in `servermanage/alerts.py`).
 *
 * Functions (Python -> Node):
 *
 * - `insert_alert`                 (`alerts.py:244`)  -> {@link insertAlert}
 * - `update_alert`                 (`alerts.py:549`)  -> {@link updateAlert}
 * - `find_latest_alert`            (`alerts.py:227`)  -> {@link findLatestAlert}
 * - `close_alerts_for_host`        (`alerts.py:29`)   -> {@link closeAlertsForHost}
 * - `list_alerts`                  (`alerts.py:325`)  -> {@link listAlerts}
 * - `list_alerts_for_host`         (`alerts.py:368`)  -> {@link listAlertsForHost}
 * - `list_open_alerts_for_host`    (`alerts.py:390`)  -> {@link listOpenAlertsForHost}
 * - `list_recent_alerts_grouped`   (`alerts.py:426`)  -> {@link listRecentAlertsGrouped}
 * - `fetch_alert_history`          (`alerts.py:153`)  -> {@link fetchAlertHistory}
 * - `count_active_alerts_by_host`  (`alerts.py:61`)   -> {@link countActiveAlertsByHost}
 * - `count_active_critical_alerts` (`alerts.py:81`)   -> {@link countActiveCriticalAlerts}
 * - `count_alerts_by_status`       (`alerts.py:97`)   -> {@link countAlertsByStatus}
 * - `insert_silence`               (`alerts.py:286`)  -> {@link insertSilence}
 * - `list_silences`                (`alerts.py:464`)  -> {@link listSilences}
 * - `delete_silence`               (`alerts.py:136`)  -> {@link deleteSilence}
 * - `prune_alert_silences`         (`alerts.py:534`)  -> {@link pruneAlertSilences}
 * - `prune_alert_history`          (`alerts.py:515`)  -> {@link pruneAlertHistory}
 *
 * All functions take an already-open `better-sqlite3` handle instead of a path
 * (the whole backend runs in one process against one file; see `./db`). The
 * paths Python wraps in `BEGIN IMMEDIATE` are wrapped in
 * `db.transaction(fn).immediate()` here. Timestamps go through `./time`
 * (`nowIsoUtc`, `YYYY-MM-DDTHH:MM:SS.ffffff+00:00`); rows keep the Python
 * column names so the returned shapes are identical to `dict(sqlite3.Row)`.
 *
 * Timezone handling for {@link fetchAlertHistory}: Python threads a `tzinfo`;
 * here a timezone is a plain IANA identifier (`'UTC'`, `'Asia/Shanghai'`, …),
 * converted with `Intl.DateTimeFormat` so DST boundaries are honoured — the
 * same approach as `./metrics-read`.
 */
import { nowIsoUtc } from './time';

type SqliteDatabase = import('better-sqlite3').Database;

// --- Input / row types ------------------------------------------------------

/** `AlertEvent` (`disk_health.py:102`), projected to the stored fields. */
export interface AlertEventInput {
  host_name: string;
  category: string;
  severity: string;
  title: string;
  message: string;
  fingerprint: string;
  /** Rule reasons that produced the event (not stored; kept for parity). */
  reasons?: readonly string[];
}

/** A stored `alerts` row, keyed exactly like the Python dict. */
export interface AlertRow {
  id: number;
  created_at: string;
  host_name: string | null;
  category: string | null;
  severity: string | null;
  title: string | null;
  message: string | null;
  fingerprint: string | null;
  status: string | null;
  notified_channels: string | null;
  ack_at: string | null;
}

/** A stored `alert_silences` row, keyed exactly like the Python dict. */
export interface SilenceRow {
  id: number;
  scope_type: string;
  scope: string | null;
  reason: string;
  starts_at: string;
  ends_at: string;
  created_at: string;
  created_by: string | null;
}

/** One bucket of {@link fetchAlertHistory}. */
export interface AlertHistoryBucket {
  key: string;
  label: string;
  critical: number;
  warning: number;
  info: number;
  total: number;
}

/** Result of {@link countAlertsByStatus} (always has the three status keys). */
export interface AlertStatusCounts {
  active: number;
  acknowledged: number;
  resolved: number;
  total: number;
}

export type AlertRangeKey = '24h' | '7d' | '30d';

/** Options for {@link insertAlert}. */
export interface InsertAlertOptions {
  /**
   * Explicit created-at instant. Python takes a `datetime`; a `Date` is
   * rendered with {@link nowIsoUtc} and a string is stored verbatim (already
   * ISO-8601 UTC). Defaults to the current UTC instant.
   */
  createdAt?: Date | string | null;
}

/** Options for {@link null} — kept separate for descriptive naming. */
export interface ListAlertsOptions {
  status?: string | null;
  since?: Date | string | null;
  limit?: number;
}

export interface ListAlertsForHostOptions {
  limit?: number;
}

export interface ListOpenAlertsForHostOptions {
  category?: string | null;
  limit?: number;
}

export interface ListRecentAlertsGroupedOptions {
  perHost?: number;
}

export interface FetchAlertHistoryOptions {
  rangeKey?: AlertRangeKey;
  tz?: string;
  now?: Date | string | null;
}

export interface ListSilencesOptions {
  activeOnly?: boolean;
  now?: Date | string | null;
}

export interface PruneOptions {
  now?: Date | string | null;
}

export interface UpdateAlertOptions {
  status?: string | null;
  notifiedChannels?: string | null;
  ackAt?: string | null;
}

export interface CloseAlertsForHostOptions {
  category: string;
  status?: string;
  /** Accepted for signature parity; the Python implementation ignores it. */
  now?: Date | string | null;
}

// --- Small helpers (mirror base.py) -----------------------------------------

/** True for SQLite "no such table" errors (an uninitialised/old database). */
function isMissingTable(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message);
}

/**
 * `_to_iso_utc` (`base.py:719`): a `Date` is rendered as a strict UTC ISO-8601
 * string via {@link nowIsoUtc}; a string is returned unchanged (the caller
 * contract is already ISO-8601 UTC).
 */
function toIsoUtc(value: string | Date): string {
  if (value instanceof Date) {
    return nowIsoUtc(value);
  }
  return String(value);
}

/**
 * Normalises an optional `since` value the way Python's `list_alerts` /
 * `count_alerts_by_status` do: a `datetime` becomes UTC ISO text, a string is
 * used as-is.
 */
function normaliseSince(since: Date | string | null | undefined): string | null {
  if (since === null || since === undefined) {
    return null;
  }
  return typeof since === 'string' ? since : toIsoUtc(since);
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parses a stored ISO-8601 timestamp to a whole-millisecond UTC instant.
 * Naive strings are interpreted as UTC, matching `base.py::_parse_collected_at`.
 * Returns `null` for anything unparseable (callers skip such rows).
 */
function parseIsoEpoch(raw: string): number | null {
  const text = raw.trim();
  const match = ISO_RE.exec(text);
  if (!match) {
    return null;
  }
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  const h = Number(match[4]);
  const mi = Number(match[5]);
  const s = Number(match[6]);
  const offset = match[8];
  let epochMs = Date.UTC(y, mo - 1, d, h, mi, s);
  if (offset !== undefined && offset !== 'Z') {
    const digits = offset.slice(1).replace(':', '');
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2, 4));
    const sign = offset[0] === '-' ? -1 : 1;
    epochMs -= sign * (hours * 60 + minutes) * 60000;
  }
  return epochMs;
}

/** Current instant (ms) from an optional `Date` / ISO string / `null`. */
function resolveNowMs(now: Date | string | null | undefined): number {
  if (now === null || now === undefined) {
    return Date.now();
  }
  if (now instanceof Date) {
    return now.getTime();
  }
  const parsed = parseIsoEpoch(now);
  return parsed === null ? Date.now() : parsed;
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

/** UTC instant (ms) whose local wall clock in `timeZone` is `wallMs`. */
function wallToInstant(wallMs: number, timeZone: string): number {
  const firstOffset = zoneOffsetMs(wallMs, timeZone);
  let instant = wallMs - firstOffset;
  const secondOffset = zoneOffsetMs(instant, timeZone);
  if (secondOffset !== firstOffset) {
    instant = wallMs - secondOffset;
  }
  return instant;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `datetime.isoformat()` for a UTC instant with whole-second precision. */
function formatUtcIso(instantMs: number): string {
  const d = new Date(instantMs);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}+00:00`
  );
}

/**
 * `datetime.isoformat()` for the local wall time `wallMs` (as if UTC fields)
 * with the supplied offset. Whole-second precision, so the fractional part is
 * omitted exactly like Python does when microsecond == 0.
 */
function formatLocalIso(wallMs: number, offsetMs: number): string {
  const wall = new Date(wallMs);
  const sign = offsetMs < 0 ? '-' : '+';
  const absMinutes = Math.round(Math.abs(offsetMs) / 60000);
  const offHours = Math.floor(absMinutes / 60);
  const offMinutes = absMinutes % 60;
  return (
    `${wall.getUTCFullYear()}-${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())}` +
    `T${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}:${pad2(wall.getUTCSeconds())}` +
    `${sign}${pad2(offHours)}:${pad2(offMinutes)}`
  );
}

// --- Writes -----------------------------------------------------------------

/**
 * Inserts an alert event with status `active` and returns its row id.
 *
 * Mirrors `insert_alert` (`alerts.py:244`), including the `BEGIN IMMEDIATE`
 * write lock so a concurrent writer cannot interleave a competing row for the
 * same fingerprint.
 */
export function insertAlert(
  db: SqliteDatabase,
  event: AlertEventInput,
  opts: InsertAlertOptions = {},
): number {
  const createdAtText =
    opts.createdAt === null || opts.createdAt === undefined
      ? nowIsoUtc()
      : toIsoUtc(opts.createdAt);

  const insert = db.prepare(
    `INSERT INTO alerts
       (created_at, host_name, category, severity, title, message,
        fingerprint, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
  );

  const run = db.transaction(() => {
    const info = insert.run(
      createdAtText,
      event.host_name,
      event.category,
      event.severity,
      event.title,
      event.message,
      event.fingerprint,
    );
    return Number(info.lastInsertRowid);
  });
  return run.immediate();
}

/**
 * Updates selected columns of an alert; unset arguments are left unchanged.
 * Mirrors `update_alert` (`alerts.py:549`).
 */
export function updateAlert(
  db: SqliteDatabase,
  alertId: number,
  opts: UpdateAlertOptions = {},
): void {
  const assignments: string[] = [];
  const values: Array<string | number> = [];
  if (opts.status !== null && opts.status !== undefined) {
    assignments.push('status = ?');
    values.push(opts.status);
  }
  if (opts.notifiedChannels !== null && opts.notifiedChannels !== undefined) {
    assignments.push('notified_channels = ?');
    values.push(opts.notifiedChannels);
  }
  if (opts.ackAt !== null && opts.ackAt !== undefined) {
    assignments.push('ack_at = ?');
    values.push(opts.ackAt);
  }

  if (assignments.length === 0) {
    return;
  }

  values.push(alertId);
  db.prepare(`UPDATE alerts SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Marks every non-terminal alert (`active` + `acknowledged`) of one
 * host/category as `status` and returns the number of rows updated. Mirrors
 * `close_alerts_for_host` (`alerts.py:29`).
 */
export function closeAlertsForHost(
  db: SqliteDatabase,
  hostName: string,
  opts: CloseAlertsForHostOptions,
): number {
  const status = opts.status ?? 'resolved';
  try {
    const info = db
      .prepare(
        `UPDATE alerts SET status = ?
         WHERE host_name = ? AND category = ?
           AND status IN ('active', 'acknowledged')`,
      )
      .run(status, hostName, opts.category);
    return Number(info.changes);
  } catch (err) {
    if (isMissingTable(err)) {
      return 0;
    }
    throw err;
  }
}

/**
 * Inserts an alert-silence window and returns its row id. Mirrors
 * `insert_silence` (`alerts.py:286`).
 */
export function insertSilence(
  db: SqliteDatabase,
  scopeType: string,
  scope: string | null,
  reason: string,
  startsAt: string | Date,
  endsAt: string | Date,
  createdBy: string | null,
): number {
  const createdAt = nowIsoUtc();
  const info = db
    .prepare(
      `INSERT INTO alert_silences
         (scope_type, scope, reason, starts_at, ends_at, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scopeType,
      scope,
      reason,
      toIsoUtc(startsAt),
      toIsoUtc(endsAt),
      createdAt,
      createdBy,
    );
  return Number(info.lastInsertRowid);
}

// --- Reads ------------------------------------------------------------------

/** Returns the most recent alert with `fingerprint`, or `null`. */
export function findLatestAlert(db: SqliteDatabase, fingerprint: string): AlertRow | null {
  try {
    const row = db
      .prepare(
        `SELECT * FROM alerts WHERE fingerprint = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(fingerprint) as AlertRow | undefined;
    return row ?? null;
  } catch (err) {
    if (isMissingTable(err)) {
      return null;
    }
    throw err;
  }
}

/**
 * Returns alerts (newest first), optionally filtered by `status` and a
 * `since` lower bound on `created_at`. Mirrors `list_alerts` (`alerts.py:325`).
 */
export function listAlerts(db: SqliteDatabase, opts: ListAlertsOptions = {}): AlertRow[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (opts.status !== null && opts.status !== undefined) {
    clauses.push('status = ?');
    params.push(opts.status);
  }
  const since = normaliseSince(opts.since);
  if (since !== null) {
    clauses.push('created_at >= ?');
    params.push(since);
  }
  let sql = 'SELECT * FROM alerts';
  if (clauses.length > 0) {
    sql += ' WHERE ' + clauses.join(' AND ');
  }
  sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
  params.push(Math.trunc(opts.limit ?? 200));

  try {
    return db.prepare(sql).all(...params) as AlertRow[];
  } catch (err) {
    if (isMissingTable(err)) {
      return [];
    }
    throw err;
  }
}

/** Returns the most recent alerts for one host (newest first). */
export function listAlertsForHost(
  db: SqliteDatabase,
  hostName: string,
  opts: ListAlertsForHostOptions = {},
): AlertRow[] {
  try {
    return db
      .prepare(
        `SELECT * FROM alerts WHERE host_name = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(hostName, Math.trunc(opts.limit ?? 20)) as AlertRow[];
  } catch (err) {
    if (isMissingTable(err)) {
      return [];
    }
    throw err;
  }
}

/**
 * Returns this host's unresolved alerts (`active` + `acknowledged`), optionally
 * scoped to one `category`. Mirrors `list_open_alerts_for_host`
 * (`alerts.py:390`).
 */
export function listOpenAlertsForHost(
  db: SqliteDatabase,
  hostName: string,
  opts: ListOpenAlertsForHostOptions = {},
): AlertRow[] {
  const clauses = ["host_name = ?", "status IN ('active', 'acknowledged')"];
  const params: Array<string | number> = [hostName];
  if (opts.category !== null && opts.category !== undefined) {
    clauses.push('category = ?');
    params.push(opts.category);
  }
  const sql =
    'SELECT * FROM alerts WHERE ' +
    clauses.join(' AND ') +
    ' ORDER BY created_at DESC, id DESC LIMIT ?';
  params.push(Math.trunc(opts.limit ?? 100_000));

  try {
    return db.prepare(sql).all(...params) as AlertRow[];
  } catch (err) {
    if (isMissingTable(err)) {
      return [];
    }
    throw err;
  }
}

/**
 * Returns the most recent `perHost` alerts for every host, in one query.
 * Mirrors `list_recent_alerts_grouped` (`alerts.py:426`).
 */
export function listRecentAlertsGrouped(
  db: SqliteDatabase,
  opts: ListRecentAlertsGroupedOptions = {},
): Record<string, AlertRow[]> {
  const cap = Math.max(1, Math.trunc(opts.perHost ?? 20));
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY host_name ORDER BY created_at DESC, id DESC
           ) AS rn
           FROM alerts
           WHERE host_name IS NOT NULL
         ) WHERE rn <= ?
         ORDER BY host_name, created_at DESC, id DESC`,
      )
      .all(cap) as Array<Record<string, unknown>>;
  } catch (err) {
    if (isMissingTable(err)) {
      return {};
    }
    throw err;
  }

  const grouped: Record<string, AlertRow[]> = {};
  for (const row of rows) {
    const entry = { ...row };
    delete entry.rn; // window helper column (absent when read per host)
    const host = String(entry.host_name);
    (grouped[host] ??= []).push(entry as unknown as AlertRow);
  }
  return grouped;
}

/**
 * Returns per-bucket alert counts grouped by severity. Mirrors
 * `fetch_alert_history` (`alerts.py:153`).
 *
 * `rangeKey` must be `24h`, `7d` or `30d`; anything else throws (Python raises
 * `ValueError`).
 */
export function fetchAlertHistory(
  db: SqliteDatabase,
  opts: FetchAlertHistoryOptions = {},
): AlertHistoryBucket[] {
  const rangeKey = opts.rangeKey ?? '24h';
  if (rangeKey !== '24h' && rangeKey !== '7d' && rangeKey !== '30d') {
    throw new Error('range_key must be 24h, 7d or 30d');
  }
  const timeZone = opts.tz ?? 'UTC';
  const currentMs = resolveNowMs(opts.now);
  const currentOffset = zoneOffsetMs(currentMs, timeZone);
  const currentWall = new Date(currentMs + currentOffset);

  const selectRows = (cutoffText: string): Array<{ created_at: string; severity: string | null }> => {
    try {
      return db
        .prepare(
          'SELECT created_at, severity FROM alerts WHERE created_at >= ? ORDER BY created_at ASC',
        )
        .all(cutoffText) as Array<{ created_at: string; severity: string | null }>;
    } catch (err) {
      if (isMissingTable(err)) {
        return [];
      }
      throw err;
    }
  };

  const classify = (counts: { critical: number; warning: number; info: number }, severity: unknown): void => {
    let level = String(severity ?? 'info').toLowerCase();
    if (level !== 'critical' && level !== 'warning' && level !== 'info') {
      level = 'info';
    }
    counts[level as 'critical' | 'warning' | 'info'] += 1;
  };

  if (rangeKey === '24h') {
    const hourWallMs = Date.UTC(
      currentWall.getUTCFullYear(),
      currentWall.getUTCMonth(),
      currentWall.getUTCDate(),
      currentWall.getUTCHours(),
      0,
      0,
    );
    const firstWallMs = hourWallMs - 23 * 3_600_000;

    const keys: Array<{ wallMs: number; label: string }> = [];
    const bucketMap = new Map<string, { critical: number; warning: number; info: number }>();
    for (let i = 0; i < 24; i += 1) {
      const wallMs = firstWallMs + i * 3_600_000;
      const wall = new Date(wallMs);
      keys.push({ wallMs, label: `${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}` });
      bucketMap.set(String(Math.floor(wallMs / 3_600_000)), {
        critical: 0,
        warning: 0,
        info: 0,
      });
    }

    const cutoffText = formatUtcIso(wallToInstant(firstWallMs, timeZone));
    for (const row of selectRows(cutoffText)) {
      const epoch = parseIsoEpoch(String(row.created_at));
      if (epoch === null) {
        continue;
      }
      const localWall = epoch + zoneOffsetMs(epoch, timeZone);
      const counts = bucketMap.get(String(Math.floor(localWall / 3_600_000)));
      if (counts === undefined) {
        continue;
      }
      classify(counts, row.severity);
    }

    return keys.map((key) => {
      const counts = bucketMap.get(String(Math.floor(key.wallMs / 3_600_000)))!;
      const offset = zoneOffsetMs(wallToInstant(key.wallMs, timeZone), timeZone);
      return {
        key: formatLocalIso(key.wallMs, offset),
        label: key.label,
        critical: counts.critical,
        warning: counts.warning,
        info: counts.info,
        total: counts.critical + counts.warning + counts.info,
      };
    });
  }

  const days = rangeKey === '7d' ? 7 : 30;
  const dayWallMs = Date.UTC(
    currentWall.getUTCFullYear(),
    currentWall.getUTCMonth(),
    currentWall.getUTCDate(),
  );
  const firstDayMs = dayWallMs - (days - 1) * 86_400_000;

  const keys: Array<{ dayMs: number; label: string }> = [];
  const bucketMap = new Map<string, { critical: number; warning: number; info: number }>();
  for (let i = 0; i < days; i += 1) {
    const dayMs = firstDayMs + i * 86_400_000;
    const wall = new Date(dayMs);
    keys.push({ dayMs, label: `${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())}` });
    bucketMap.set(String(Math.floor(dayMs / 86_400_000)), {
      critical: 0,
      warning: 0,
      info: 0,
    });
  }

  const cutoffText = formatUtcIso(wallToInstant(firstDayMs, timeZone));
  for (const row of selectRows(cutoffText)) {
    const epoch = parseIsoEpoch(String(row.created_at));
    if (epoch === null) {
      continue;
    }
    const localWall = epoch + zoneOffsetMs(epoch, timeZone);
    const counts = bucketMap.get(String(Math.floor(localWall / 86_400_000)));
    if (counts === undefined) {
      continue;
    }
    classify(counts, row.severity);
  }

  return keys.map((key) => {
    const counts = bucketMap.get(String(Math.floor(key.dayMs / 86_400_000)))!;
    const wall = new Date(key.dayMs);
    const dateKey = `${wall.getUTCFullYear()}-${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())}`;
    return {
      key: dateKey,
      label: key.label,
      critical: counts.critical,
      warning: counts.warning,
      info: counts.info,
      total: counts.critical + counts.warning + counts.info,
    };
  });
}

/** Counts active alerts per host with one grouped aggregate. */
export function countActiveAlertsByHost(db: SqliteDatabase): Record<string, number> {
  let rows: Array<{ host_name: unknown; count: number }>;
  try {
    rows = db
      .prepare(
        `SELECT host_name, COUNT(*) AS count FROM alerts
         WHERE status = 'active' AND host_name IS NOT NULL
         GROUP BY host_name`,
      )
      .all() as Array<{ host_name: unknown; count: number }>;
  } catch (err) {
    if (isMissingTable(err)) {
      return {};
    }
    throw err;
  }
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[String(row.host_name)] = Number(row.count);
  }
  return result;
}

/** Counts active critical alerts (case-insensitive severity). */
export function countActiveCriticalAlerts(db: SqliteDatabase): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count FROM alerts
         WHERE status = 'active' AND lower(severity) = 'critical'`,
      )
      .get() as { count: number } | undefined;
    return row ? Number(row.count) : 0;
  } catch (err) {
    if (isMissingTable(err)) {
      return 0;
    }
    throw err;
  }
}

/**
 * Counts alerts grouped by status, optionally restricted to `created_at >=
 * since`. Always returns `active`, `acknowledged` and `resolved` keys plus
 * `total`. Mirrors `count_alerts_by_status` (`alerts.py:97`).
 */
export function countAlertsByStatus(
  db: SqliteDatabase,
  opts: { since?: Date | string | null } = {},
): AlertStatusCounts {
  const counts: AlertStatusCounts = { active: 0, acknowledged: 0, resolved: 0, total: 0 };
  const since = normaliseSince(opts.since);
  const clause = since !== null ? ' WHERE created_at >= ?' : '';
  const params = since !== null ? [since] : [];

  let rows: Array<{ status: unknown; count: number }>;
  try {
    rows = db
      .prepare(`SELECT status, COUNT(*) AS count FROM alerts${clause} GROUP BY status`)
      .all(...params) as Array<{ status: unknown; count: number }>;
  } catch (err) {
    if (isMissingTable(err)) {
      return counts;
    }
    throw err;
  }

  for (const row of rows) {
    const status = String(row.status);
    const count = Number(row.count);
    if (status === 'active' || status === 'acknowledged' || status === 'resolved') {
      counts[status] = count;
    }
    counts.total += count;
  }
  return counts;
}

/**
 * Returns silence rows ordered by `id`. With `activeOnly` only windows where
 * `starts_at <= now < ends_at` survive; rows with unparseable timestamps are
 * skipped. Mirrors `list_silences` (`alerts.py:464`).
 */
export function listSilences(
  db: SqliteDatabase,
  opts: ListSilencesOptions = {},
): SilenceRow[] {
  let rawRows: SilenceRow[];
  try {
    rawRows = db.prepare('SELECT * FROM alert_silences ORDER BY id').all() as SilenceRow[];
  } catch (err) {
    if (isMissingTable(err)) {
      return [];
    }
    throw err;
  }

  const activeOnly = opts.activeOnly === true;
  const reference = activeOnly ? resolveNowMs(opts.now) : 0;

  const results: SilenceRow[] = [];
  for (const raw of rawRows) {
    const starts = typeof raw.starts_at === 'string' ? parseIsoEpoch(raw.starts_at) : null;
    const ends = typeof raw.ends_at === 'string' ? parseIsoEpoch(raw.ends_at) : null;
    if (starts === null || ends === null) {
      continue;
    }
    if (activeOnly && !(starts <= reference && reference < ends)) {
      continue;
    }
    results.push(raw);
  }
  return results;
}

/** Deletes the silence row; returns `true` when a row was removed. */
export function deleteSilence(db: SqliteDatabase, silenceId: number): boolean {
  try {
    const info = db.prepare('DELETE FROM alert_silences WHERE id = ?').run(Math.trunc(silenceId));
    return Number(info.changes) > 0;
  } catch (err) {
    if (isMissingTable(err)) {
      return false;
    }
    throw err;
  }
}

/** Deletes silence rows whose window already ended. */
export function pruneAlertSilences(db: SqliteDatabase, opts: PruneOptions = {}): number {
  const referenceMs = resolveNowMs(opts.now);
  try {
    const info = db
      .prepare('DELETE FROM alert_silences WHERE ends_at < ?')
      .run(nowIsoUtc(new Date(referenceMs)));
    return Number(info.changes);
  } catch (err) {
    if (isMissingTable(err)) {
      return 0;
    }
    throw err;
  }
}

/**
 * Deletes only resolved alerts older than `retentionDays`. Mirrors
 * `prune_alert_history` (`alerts.py:515`).
 */
export function pruneAlertHistory(
  db: SqliteDatabase,
  retentionDays = 30,
  opts: PruneOptions = {},
): number {
  const referenceMs = resolveNowMs(opts.now);
  const days = Math.max(1, Math.trunc(retentionDays));
  const cutoffText = nowIsoUtc(new Date(referenceMs - days * 86_400_000));
  try {
    const info = db
      .prepare("DELETE FROM alerts WHERE status = 'resolved' AND created_at < ?")
      .run(cutoffText);
    return Number(info.changes);
  } catch (err) {
    if (isMissingTable(err)) {
      return 0;
    }
    throw err;
  }
}
