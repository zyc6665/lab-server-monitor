/**
 * Alert delivery-failure records (P1 Track C, design §6 P1-3).
 *
 * The `alert_delivery_failures` table records one row each time a notification
 * channel throws while dispatching an alert. It backs the alerts page's
 * "delivery failure" indicator and the manual "resend failed channels" action;
 * the engine's own retry/cooldown semantics are unchanged (a channel that did
 * not accept keeps `notified_channels` empty and is retried next cycle).
 *
 * Rows keep the snake_case column names in SQLite but are exposed to callers in
 * camelCase (`alertId`) so route JSON stays idiomatic. Timestamps go through
 * {@link nowIsoUtc} (`YYYY-MM-DDTHH:MM:SS.ffffff+00:00`), which sorts
 * lexicographically in the same order as time.
 */
import { nowIsoUtc } from './time';

type SqliteDatabase = import('better-sqlite3').Database;

/** One delivery failure to persist. */
export interface DeliveryFailureInput {
  /** Persisted `alerts.id` the failure belongs to. */
  alertId: number;
  /** Channel name (`desktop` / `email` / `webhook`). */
  channel: string;
  /** Destination (address / URL) when the notifier knows it. */
  target?: string | null;
  /** Human-readable error message. */
  error: string;
}

/** Options for {@link recordDeliveryFailure}. */
export interface RecordDeliveryFailureOptions {
  /** Explicit `at` instant (tests / backfill); defaults to now. */
  at?: Date | string | null;
}

/** A stored failure row, camelCased for callers. */
export interface DeliveryFailureRow {
  id: number;
  alertId: number;
  channel: string;
  target: string | null;
  error: string;
  at: string;
}

/** Options for {@link listDeliveryFailures}. */
export interface ListDeliveryFailuresOptions {
  alertId?: number | null;
  limit?: number;
}

/** Raw SQLite row shape (`alert_delivery_failures`). */
interface RawDeliveryFailureRow {
  id: number;
  alert_id: number;
  channel: string;
  target: string | null;
  error: string;
  at: string;
}

/** Default page size for {@link listDeliveryFailures}. */
const DEFAULT_LIMIT = 200;

/** Maps a raw row to the camelCase shape callers consume. */
function toRow(raw: RawDeliveryFailureRow): DeliveryFailureRow {
  return {
    id: raw.id,
    alertId: raw.alert_id,
    channel: raw.channel,
    target: raw.target,
    error: raw.error,
    at: raw.at,
  };
}

/** Renders an explicit `at` value as ISO-8601 UTC text. */
function toIsoUtc(value: Date | string): string {
  return value instanceof Date ? nowIsoUtc(value) : String(value);
}

/**
 * Records one channel delivery failure.
 *
 * Returns the inserted row id. Throws only on a genuine DB failure (missing
 * table / constraint violation); callers that must never break a polling cycle
 * wrap this in a try/catch (the engine does).
 */
export function recordDeliveryFailure(
  db: SqliteDatabase,
  failure: DeliveryFailureInput,
  options: RecordDeliveryFailureOptions = {},
): number {
  const alertId = Number(failure.alertId);
  if (!Number.isInteger(alertId) || alertId <= 0) {
    throw new Error('recordDeliveryFailure: alertId must be a positive integer');
  }
  const channel = String(failure.channel ?? '').trim();
  if (channel === '') {
    throw new Error('recordDeliveryFailure: channel is required');
  }
  const at =
    options.at === null || options.at === undefined ? nowIsoUtc() : toIsoUtc(options.at);
  const target =
    failure.target === null || failure.target === undefined ? null : String(failure.target);

  const info = db
    .prepare(
      `INSERT INTO alert_delivery_failures (alert_id, channel, target, error, at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(alertId, channel, target, String(failure.error ?? ''), at);
  return Number(info.lastInsertRowid);
}

/**
 * Lists delivery failures, newest first, optionally for one alert.
 *
 * `limit` defaults to 200 and is clamped to `[1, 2000]` so a hostile query
 * cannot ask for an unbounded scan.
 */
export function listDeliveryFailures(
  db: SqliteDatabase,
  options: ListDeliveryFailuresOptions = {},
): DeliveryFailureRow[] {
  const requested = Number(options.limit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), 2000)
    : DEFAULT_LIMIT;

  const alertId = options.alertId ?? null;
  const rows =
    alertId === null
      ? (db
          .prepare(
            `SELECT id, alert_id, channel, target, error, at
               FROM alert_delivery_failures
              ORDER BY at DESC, id DESC
              LIMIT ?`,
          )
          .all(limit) as RawDeliveryFailureRow[])
      : (db
          .prepare(
            `SELECT id, alert_id, channel, target, error, at
               FROM alert_delivery_failures
              WHERE alert_id = ?
              ORDER BY at DESC, id DESC
              LIMIT ?`,
          )
          .all(Number(alertId), limit) as RawDeliveryFailureRow[]);

  return rows.map(toRow);
}

/**
 * Deletes failures older than `days` (default 30) and returns the row count.
 *
 * `days <= 0` prunes everything (used by "clear all" tooling); callers that
 * pass a window always get the default `now`-relative cutoff.
 */
export function pruneDeliveryFailures(db: SqliteDatabase, days = 30): number {
  const span = Number(days);
  const effective = Number.isFinite(span) ? Math.max(0, Math.trunc(span)) : 30;
  const cutoff = nowIsoUtc(new Date(Date.now() - effective * 24 * 60 * 60 * 1000));
  const info = db
    .prepare('DELETE FROM alert_delivery_failures WHERE at < ?')
    .run(cutoff);
  return Number(info.changes);
}

/**
 * The latest failure per alert, keyed by `alertId`.
 *
 * The alerts page fetches all failures once and decorates every row; collapsing
 * to the newest row per alert keeps that payload small. Ordering matches
 * {@link listDeliveryFailures}, so the first row seen per alert wins.
 */
export function latestFailuresByAlert(db: SqliteDatabase): Map<number, DeliveryFailureRow> {
  const rows = db
    .prepare(
      `SELECT id, alert_id, channel, target, error, at
         FROM alert_delivery_failures
        ORDER BY at DESC, id DESC`,
    )
    .all() as RawDeliveryFailureRow[];

  const latest = new Map<number, DeliveryFailureRow>();
  for (const raw of rows) {
    const key = raw.alert_id;
    if (!latest.has(key)) {
      latest.set(key, toRow(raw));
    }
  }
  return latest;
}
