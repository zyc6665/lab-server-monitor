/**
 * `audit_log` accessors (P3-2). Records *what* happened — actor, action,
 * target, result — never values or secrets. Rows are retained 180 days.
 */
import { nowIsoUtc } from './time';

type SqliteDatabase = import('better-sqlite3').Database;

export interface AuditRow {
  id: number;
  actor: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  at: string;
  result: string | null;
}

export interface RecordAuditInput {
  actor?: string | null;
  action: string;
  target?: string | null;
  ip?: string | null;
  result?: string | null;
  at?: string;
}

const RETENTION_DAYS = 180;

function isMissingTable(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message);
}

/** Best-effort audit write; never throws. */
export function recordAudit(db: SqliteDatabase, input: RecordAuditInput): void {
  const action = String(input.action ?? '').trim();
  if (!action) return;
  try {
    db.prepare(
      `INSERT INTO audit_log (actor, action, target, ip, at, result)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.actor ?? null,
      action,
      input.target ?? null,
      input.ip ?? null,
      input.at ?? nowIsoUtc(),
      input.result ?? null,
    );
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
}

/** Newest-first audit rows, filterable by actor / action. */
export function listAudit(
  db: SqliteDatabase,
  options: { actor?: string; action?: string; limit?: number } = {},
): AuditRow[] {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(500, Math.floor(options.limit!))) : 100;
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.actor) {
    where.push('actor = ?');
    params.push(options.actor);
  }
  if (options.action) {
    where.push('action = ?');
    params.push(options.action);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  try {
    return db
      .prepare(
        `SELECT id, actor, action, target, ip, at, result
           FROM audit_log
          ${clause}
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(...params, limit) as AuditRow[];
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

/** Delete rows older than 180 days; returns rows removed. */
export function pruneAudit(db: SqliteDatabase, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    return db.prepare('DELETE FROM audit_log WHERE at < ?').run(cutoff).changes;
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }
}
