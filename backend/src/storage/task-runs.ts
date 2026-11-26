/**
 * `task_runs` accessors: one row per scheduler invocation.
 *
 * The table lives in `schema.ts` (created with the settings tables) and keeps
 * the column names of the Python oracle:
 *
 *   id, task, trigger, started_at, finished_at, status, error, duration_ms
 *
 * A run is inserted with `status = 'running'` *before* the task body executes,
 * and is completed with `recordTaskRunFinish` once it settles. That makes a
 * crashed process visible (a stale `running` row) and lets the task center show
 * duration / failure history without touching `task_state` semantics.
 *
 * `started_at` / `finished_at` are stored as UTC ISO strings via
 * {@link nowIsoUtc} (`YYYY-MM-DDTHH:MM:SS.ffffff+00:00`). `duration_ms` is
 * computed here from those two timestamps when the run finishes.
 */
import { nowIsoUtc } from './time';

type SqliteDatabase = import('better-sqlite3').Database;

/** What caused a run: the background tick or a manual trigger. */
export type TaskRunTrigger = 'schedule' | 'manual';

/** Terminal statuses accepted by {@link recordTaskRunFinish}. */
export type TaskRunFinishStatus = 'ok' | 'error';

/** A stored `task_runs` row. */
export interface TaskRunRow {
  id: number;
  task: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  error: string | null;
  duration_ms: number | null;
}

/** Fields accepted by {@link recordTaskRunStart}. */
export interface TaskRunStartInput {
  /** Task name (the scheduler's `ScheduledTask.name`). */
  task: string;
  /** `schedule` for the background loop, `manual` for a user trigger. */
  trigger: TaskRunTrigger;
  /** Start instant; defaults to "now" (`nowIsoUtc`). */
  startedAt?: string;
}

/** Fields accepted by {@link recordTaskRunFinish}. */
export interface TaskRunFinishInput {
  status: TaskRunFinishStatus;
  /** Failure text, persisted verbatim for `status === 'error'`. */
  error?: string | null;
  /** Finish instant; defaults to "now" (`nowIsoUtc`). */
  finishedAt?: string;
}

/** Options for {@link listTaskRuns}. */
export interface ListTaskRunsOptions {
  /** Maximum rows to return (default 200, clamped to 1…1000). */
  limit?: number;
}

/** Default page size for run listings. */
export const DEFAULT_TASK_RUN_LIMIT = 200;

/** Hard cap so a caller-supplied limit can never load an unbounded history. */
export const MAX_TASK_RUN_LIMIT = 1_000;

const TASK_RUN_COLUMNS =
  'id, task, trigger, started_at, finished_at, status, error, duration_ms';

/** ISO strings carrying an explicit offset (`Z` or `±HH:MM`). */
const AWARE_SUFFIX_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** True for SQLite "no such table" errors (an uninitialised/old database). */
function isMissingTable(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message);
}

/** Parse a stored ISO timestamp into epoch ms, treating a naive value as UTC. */
function parseInstantMs(value: string): number | null {
  const text = value.trim();
  if (text === '') {
    return null;
  }
  const withZone = AWARE_SUFFIX_RE.test(text) ? text : `${text}Z`;
  const ms = Date.parse(withZone);
  return Number.isNaN(ms) ? null : ms;
}

/** Normalize a listing limit: non-positive/non-finite values fall back to 200. */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_TASK_RUN_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored <= 0) {
    return DEFAULT_TASK_RUN_LIMIT;
  }
  return Math.min(floored, MAX_TASK_RUN_LIMIT);
}

/** Normalize a prune retention: non-finite/non-positive values fall back to 200. */
function normalizeKeep(keep: number | undefined): number {
  if (keep === undefined || !Number.isFinite(keep)) {
    return DEFAULT_TASK_RUN_LIMIT;
  }
  return Math.max(0, Math.floor(keep));
}

/**
 * Inserts a `running` row for a task invocation and returns its id.
 *
 * Call this immediately *before* the task body runs, then pass the id to
 * {@link recordTaskRunFinish} when it settles.
 */
export function recordTaskRunStart(
  db: SqliteDatabase,
  input: TaskRunStartInput,
): number {
  const task = String(input.task ?? '').trim();
  if (task === '') {
    throw new Error('task_runs: task name is required');
  }
  if (input.trigger !== 'schedule' && input.trigger !== 'manual') {
    throw new Error(`task_runs: unknown trigger "${String(input.trigger)}"`);
  }
  const startedAt = input.startedAt ?? nowIsoUtc();
  const info = db
    .prepare(
      `INSERT INTO task_runs (task, trigger, started_at, status)
       VALUES (?, ?, ?, 'running')`,
    )
    .run(task, input.trigger, startedAt);
  return Number(info.lastInsertRowid);
}

/**
 * Completes a run row started with {@link recordTaskRunStart}.
 *
 * `finished_at` defaults to now and `duration_ms` is derived from the stored
 * `started_at`; a row that already vanished returns `false` instead of
 * throwing so a prune racing a long-running task cannot crash the scheduler.
 */
export function recordTaskRunFinish(
  db: SqliteDatabase,
  id: number,
  input: TaskRunFinishInput,
): boolean {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`task_runs: invalid run id "${String(id)}"`);
  }
  if (input.status !== 'ok' && input.status !== 'error') {
    throw new Error(`task_runs: unknown finish status "${String(input.status)}"`);
  }
  const existing = db
    .prepare('SELECT started_at FROM task_runs WHERE id = ?')
    .get(id) as { started_at: string } | undefined;
  if (existing === undefined) {
    return false;
  }
  const finishedAt = input.finishedAt ?? nowIsoUtc();
  const startedMs = parseInstantMs(existing.started_at);
  const finishedMs = parseInstantMs(finishedAt);
  const durationMs =
    startedMs === null || finishedMs === null
      ? null
      : Math.max(0, finishedMs - startedMs);
  const error = input.status === 'error' ? input.error ?? null : null;
  const info = db
    .prepare(
      `UPDATE task_runs
          SET finished_at = ?, status = ?, error = ?, duration_ms = ?
        WHERE id = ?`,
    )
    .run(finishedAt, input.status, error, durationMs, id);
  return info.changes > 0;
}

/** Newest-first run history across all tasks (tolerates a missing table). */
export function listTaskRuns(
  db: SqliteDatabase,
  options: ListTaskRunsOptions = {},
): TaskRunRow[] {
  const limit = normalizeLimit(options.limit);
  try {
    return db
      .prepare(
        `SELECT ${TASK_RUN_COLUMNS} FROM task_runs
          ORDER BY started_at DESC, id DESC
          LIMIT ?`,
      )
      .all(limit) as TaskRunRow[];
  } catch (err) {
    if (isMissingTable(err)) {
      return [];
    }
    throw err;
  }
}

/** Newest-first run history for one task. */
export function listTaskRunsForTask(
  db: SqliteDatabase,
  task: string,
  limit?: number,
): TaskRunRow[] {
  const name = String(task ?? '').trim();
  if (name === '') {
    return [];
  }
  try {
    return db
      .prepare(
        `SELECT ${TASK_RUN_COLUMNS} FROM task_runs
          WHERE task = ?
          ORDER BY started_at DESC, id DESC
          LIMIT ?`,
      )
      .all(name, normalizeLimit(limit)) as TaskRunRow[];
  } catch (err) {
    if (isMissingTable(err)) {
      return [];
    }
    throw err;
  }
}

/**
 * Latest run per registered task, keyed by task name.
 *
 * Used by the task-center API to surface the last duration / failure without a
 * second round-trip. A run still in progress is included (its `duration_ms` is
 * `null`).
 */
export function latestRunByTask(
  db: SqliteDatabase,
): Record<string, TaskRunRow> {
  const rows = listLatestRuns(db);
  const out = Object.create(null) as Record<string, TaskRunRow>;
  for (const row of rows) {
    out[row.task] = row;
  }
  return out;
}

function listLatestRuns(db: SqliteDatabase): TaskRunRow[] {
  try {
    return db
      .prepare(
        `SELECT ${TASK_RUN_COLUMNS} FROM task_runs
          WHERE id IN (SELECT MAX(id) FROM task_runs GROUP BY task)
          ORDER BY id`,
      )
      .all() as TaskRunRow[];
  } catch (err) {
    if (isMissingTable(err)) {
      return [];
    }
    throw err;
  }
}

/**
 * Deletes old run rows, keeping the newest `keep` (default 200) by start time
 * and returns the number of deleted rows.
 *
 * The design keeps the task_runs table bounded at ~200 rows (§6 P1-2), so the
 * hourly prune task calls this with the configured retention.
 */
export function pruneTaskRuns(db: SqliteDatabase, keep?: number): number {
  const keepCount = normalizeKeep(keep);
  try {
    if (keepCount === 0) {
      return db.prepare('DELETE FROM task_runs').run().changes;
    }
    const info = db
      .prepare(
        `DELETE FROM task_runs
          WHERE id NOT IN (
            SELECT id FROM task_runs
             ORDER BY started_at DESC, id DESC
             LIMIT ?
          )`,
      )
      .run(keepCount);
    return info.changes;
  } catch (err) {
    if (isMissingTable(err)) {
      return 0;
    }
    throw err;
  }
}