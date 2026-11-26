/**
 * `storage_samples` accessors — one row per day recording the database and data
 * directory sizes, used to draw a storage-growth trend on the settings page.
 *
 * Rows are keyed by calendar day (`YYYY-MM-DD`); a repeated sample on the same
 * day upserts. Retained for 180 days.
 */
import { nowIsoUtc } from './time';

type SqliteDatabase = import('better-sqlite3').Database;

export interface StorageSampleRow {
  day: string;
  db_bytes: number;
  data_dir_bytes: number;
  created_at: string;
}

const RETENTION_DAYS = 180;

function isMissingTable(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message);
}

function dayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Upsert today's sample (idempotent per day). */
export function recordStorageSample(
  db: SqliteDatabase,
  input: { dbBytes: number; dataDirBytes: number; now?: Date },
): void {
  const now = input.now ?? new Date();
  const day = dayOf(now);
  try {
    db.prepare(
      `INSERT INTO storage_samples (day, db_bytes, data_dir_bytes, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         db_bytes = excluded.db_bytes,
         data_dir_bytes = excluded.data_dir_bytes,
         created_at = excluded.created_at`,
    ).run(day, Math.max(0, Math.floor(input.dbBytes)), Math.max(0, Math.floor(input.dataDirBytes)), nowIsoUtc(now));
  } catch (err) {
    if (isMissingTable(err)) return;
    throw err;
  }
}

/** Oldest-first samples within the last `days` days (for a trend chart). */
export function listStorageSamples(db: SqliteDatabase, days = 90): StorageSampleRow[] {
  const bound = Number.isFinite(days) ? Math.max(1, Math.min(RETENTION_DAYS, Math.floor(days))) : 90;
  try {
    return db
      .prepare(
        `SELECT day, db_bytes, data_dir_bytes, created_at
           FROM storage_samples
          ORDER BY day DESC
          LIMIT ?`,
      )
      .all(bound)
      .reverse() as StorageSampleRow[];
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

/** Delete samples older than the retention window; returns rows deleted. */
export function pruneStorageSamples(db: SqliteDatabase, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  try {
    const info = db.prepare('DELETE FROM storage_samples WHERE day < ?').run(cutoff);
    return info.changes;
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }
}
