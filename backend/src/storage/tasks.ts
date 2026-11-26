/**
 * `task_state` accessors mirroring the Python oracle
 * `servermanage/storage/base.py`:
 *
 * - `get_task_state` (`base.py:788`) -> {@link getTaskState}
 * - `set_task_state` (`base.py:1147`) -> {@link setTaskState}
 * - `list_task_states` (`base.py:905`) -> {@link listTaskStates}
 *
 * Rows keep the Python column names (`task_name`, `last_run_at`,
 * `last_result`) so the returned shapes are identical to Python's
 * `dict(sqlite3.Row)` — important for the Python↔Node differential harness.
 */
import { nowIsoUtc } from './time';

type SqliteDatabase = import('better-sqlite3').Database;

/** A stored `task_state` row, keyed exactly like the Python dict. */
export interface TaskStateRow {
  task_name: string;
  last_run_at: string;
  last_result: string | null;
}

/** Fields accepted by {@link setTaskState}. */
export interface TaskStateUpdate {
  /**
   * ISO-8601 UTC timestamp of the run. Defaults to {@link nowIsoUtc} so a
   * caller can simply record "the task ran just now".
   */
  lastRunAt?: string;
  /** Free-form result string stored verbatim (Python `last_result`). */
  lastResult?: string | null;
}

/** True for SQLite "no such table" errors (an uninitialised/old database). */
function isMissingTable(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message);
}

/** Returns the stored state for `task_name`, or `null` when absent. */
export function getTaskState(db: SqliteDatabase, name: string): TaskStateRow | null {
  let row: TaskStateRow | undefined;
  try {
    row = db
      .prepare('SELECT task_name, last_run_at, last_result FROM task_state WHERE task_name = ?')
      .get(name) as TaskStateRow | undefined;
  } catch (err) {
    if (isMissingTable(err)) {
      return null;
    }
    throw err;
  }
  return row ?? null;
}

/**
 * Inserts or overwrites the state row for `name`.
 *
 * Mirrors `set_task_state`: `last_run_at` is required by Python; here it is
 * optional and falls back to the current UTC instant. `last_result` defaults
 * to `null` (the column is nullable).
 */
export function setTaskState(db: SqliteDatabase, name: string, update: TaskStateUpdate = {}): void {
  db.prepare(
    `INSERT INTO task_state (task_name, last_run_at, last_result)
     VALUES (?, ?, ?)
     ON CONFLICT(task_name) DO UPDATE SET
       last_run_at = excluded.last_run_at,
       last_result = excluded.last_result`,
  ).run(name, update.lastRunAt ?? nowIsoUtc(), update.lastResult ?? null);
}

/** Returns every task-state row ordered by `task_name`. */
export function listTaskStates(db: SqliteDatabase): TaskStateRow[] {
  let rows: TaskStateRow[];
  try {
    rows = db
      .prepare('SELECT task_name, last_run_at, last_result FROM task_state ORDER BY task_name')
      .all() as TaskStateRow[];
  } catch (err) {
    if (isMissingTable(err)) {
      return [];
    }
    throw err;
  }
  return rows;
}
