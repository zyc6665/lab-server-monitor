/**
 * `config_history` accessors — one row per settings section save.
 *
 * Only the **names** of changed keys are stored (never their values), so the
 * change log is safe to display and cannot leak secrets. Rows are retained for
 * 90 days by {@link pruneConfigHistory}.
 */
import { nowIsoUtc } from './time';

type SqliteDatabase = import('better-sqlite3').Database;

export interface ConfigHistoryRow {
  id: number;
  section: string;
  changed_keys: string[];
  changed_by: string | null;
  changed_at: string;
}

export interface RecordConfigHistoryInput {
  section: string;
  changedKeys: string[];
  changedBy?: string | null;
  changedAt?: string;
}

const RETENTION_DAYS = 90;

function isMissingTable(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message);
}

/** Insert a change-history row (no-op when no keys changed). */
export function recordConfigHistory(db: SqliteDatabase, input: RecordConfigHistoryInput): number | null {
  const section = String(input.section ?? '').trim();
  const keys = Array.from(new Set(input.changedKeys.map((k) => String(k)).filter((k) => k !== ''))).sort();
  if (section === '' || keys.length === 0) {
    return null;
  }
  try {
    const info = db
      .prepare(
        `INSERT INTO config_history (section, changed_keys, changed_by, changed_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(section, JSON.stringify(keys), input.changedBy ?? null, input.changedAt ?? nowIsoUtc());
    return Number(info.lastInsertRowid);
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

/** Newest-first change history, optionally filtered by section. */
export function listConfigHistory(
  db: SqliteDatabase,
  options: { limit?: number; section?: string } = {},
): ConfigHistoryRow[] {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(200, Math.floor(options.limit!))) : 20;
  try {
    const rows = db
      .prepare(
        `SELECT id, section, changed_keys, changed_by, changed_at
           FROM config_history
          ${options.section ? 'WHERE section = ?' : ''}
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(...(options.section ? [options.section, limit] : [limit])) as Array<{
        id: number;
        section: string;
        changed_keys: string;
        changed_by: string | null;
        changed_at: string;
      }>;
    return rows.map((row) => ({
      id: row.id,
      section: row.section,
      changed_keys: safeParseKeys(row.changed_keys),
      changed_by: row.changed_by,
      changed_at: row.changed_at,
    }));
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

function safeParseKeys(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((k) => String(k)) : [];
  } catch {
    return [];
  }
}

/** Delete rows older than the retention window; returns the number deleted. */
export function pruneConfigHistory(db: SqliteDatabase, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const info = db.prepare('DELETE FROM config_history WHERE changed_at < ?').run(cutoff);
    return info.changes;
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }
}
