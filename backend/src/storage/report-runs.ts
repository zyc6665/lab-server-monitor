/**
 * `report_runs` accessors: one row per report preview/send attempt.
 *
 * Table (Node-only addition, module optimization P2 / M5):
 *
 *   id, kind, variant, status, error, recipients, sent_at, created_at
 *
 * `kind` is the report family (`daily` | `weekly`), `variant` is the rendering
 * variant (`technical` | `executive` | `weekly`), and `status` is `sent` or
 * `error`. Timestamps use {@link nowIsoUtc}. Rows are returned snake_case for
 * consistency with {@link TaskRunRow}.
 */
import { nowIsoUtc } from './time';

type SqliteDatabase = import('better-sqlite3').Database;

export type ReportRunStatus = 'sent' | 'error';

export interface ReportRunRow {
  id: number;
  kind: string;
  variant: string;
  status: string;
  error: string | null;
  recipients: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface RecordReportRunInput {
  kind: string;
  variant: string;
  status: ReportRunStatus;
  error?: string | null;
  recipients?: string | string[] | null;
  sentAt?: string | null;
  createdAt?: string;
}

export const DEFAULT_REPORT_RUN_LIMIT = 50;
export const MAX_REPORT_RUN_LIMIT = 500;
export const DEFAULT_REPORT_RUN_KEEP = 200;

const REPORT_RUN_COLUMNS =
  'id, kind, variant, status, error, recipients, sent_at, created_at';

function isMissingTable(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_REPORT_RUN_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored <= 0) {
    return DEFAULT_REPORT_RUN_LIMIT;
  }
  return Math.min(floored, MAX_REPORT_RUN_LIMIT);
}

function normalizeRecipients(recipients: string | string[] | null | undefined): string | null {
  if (recipients === undefined || recipients === null) {
    return null;
  }
  if (Array.isArray(recipients)) {
    const cleaned = recipients.map((r) => String(r).trim()).filter((r) => r !== '');
    return cleaned.length > 0 ? cleaned.join(', ') : null;
  }
  const text = String(recipients).trim();
  return text === '' ? null : text;
}

/** Insert a report run row and return its id. */
export function recordReportRun(db: SqliteDatabase, input: RecordReportRunInput): number {
  const kind = String(input.kind ?? '').trim();
  const variant = String(input.variant ?? '').trim();
  if (kind === '' || variant === '') {
    throw new Error('report_runs: kind and variant are required');
  }
  if (input.status !== 'sent' && input.status !== 'error') {
    throw new Error(`report_runs: unknown status "${String(input.status)}"`);
  }
  const createdAt = input.createdAt ?? nowIsoUtc();
  const sentAt = input.status === 'sent' ? input.sentAt ?? createdAt : input.sentAt ?? null;
  const info = db
    .prepare(
      `INSERT INTO report_runs (kind, variant, status, error, recipients, sent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      kind,
      variant,
      input.status,
      input.status === 'error' ? input.error ?? null : null,
      normalizeRecipients(input.recipients),
      sentAt,
      createdAt,
    );
  return Number(info.lastInsertRowid);
}

/** Newest-first report run history (tolerates a missing table). */
export function listReportRuns(db: SqliteDatabase, limit = DEFAULT_REPORT_RUN_LIMIT): ReportRunRow[] {
  try {
    return db
      .prepare(
        `SELECT ${REPORT_RUN_COLUMNS} FROM report_runs
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(normalizeLimit(limit)) as ReportRunRow[];
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

/** Most recent run for a report kind, or `null`. */
export function latestReportRunByKind(db: SqliteDatabase, kind: string): ReportRunRow | null {
  try {
    const row = db
      .prepare(
        `SELECT ${REPORT_RUN_COLUMNS} FROM report_runs
          WHERE kind = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
      .get(kind) as ReportRunRow | undefined;
    return row ?? null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

/** Keep only the newest `keep` rows; returns the number deleted. */
export function pruneReportRuns(db: SqliteDatabase, keep = DEFAULT_REPORT_RUN_KEEP): number {
  const bound = Number.isFinite(keep) ? Math.max(0, Math.floor(keep)) : DEFAULT_REPORT_RUN_KEEP;
  try {
    const info = db
      .prepare(
        `DELETE FROM report_runs
          WHERE id NOT IN (
            SELECT id FROM report_runs ORDER BY created_at DESC, id DESC LIMIT ?
          )`,
      )
      .run(bound);
    return info.changes;
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }
}
