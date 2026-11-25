/**
 * SQLite connection setup that mirrors the Python oracle
 * (`servermanage/storage/base.py::_connect` / `init_storage`).
 *
 * The whole backend runs in a single process against one database file, so a
 * single long-lived handle plus WAL and a busy timeout is the equivalent of the
 * Python side's per-operation connections.
 */
import Database from 'better-sqlite3';
import { existsSync, statSync } from 'node:fs';

export interface OpenDatabaseOptions {
  /** Open the file in read-only mode (never creates or mutates it). */
  readonly?: boolean;
}

/**
 * Opens the SQLite database at `path` with the pragmas every reader and writer
 * here wants.
 *
 * - `busy_timeout=10000` and `synchronous=NORMAL` are applied on every
 *   connection (per-connection settings, not persisted in the file).
 * - When the file does not exist yet (or is empty) and the handle is writable,
 *   `journal_mode=WAL` and `auto_vacuum=INCREMENTAL` are set. Both must be set
 *   before any table exists for `auto_vacuum` to take effect.
 *
 * The caller owns the returned handle and is responsible for closing it.
 */
export function openDatabase(
  path: string,
  opts: OpenDatabaseOptions = {},
): import('better-sqlite3').Database {
  const readonly = opts.readonly === true;
  const isNew = !existsSync(path) || statSync(path).size === 0;

  const db = readonly
    ? new Database(path, { readonly: true, fileMustExist: true })
    : new Database(path);

  db.pragma('busy_timeout = 10000');
  db.pragma('synchronous = NORMAL');

  if (isNew && !readonly) {
    // auto_vacuum must be set on the still-empty file *before* WAL mode is
    // enabled: SQLite silently ignores an auto_vacuum change once the database
    // is in WAL journal mode (it also must precede the first table creation).
    db.pragma('auto_vacuum = INCREMENTAL');
    // WAL lets the dashboard poll read while the collector writes. It is stored
    // in the file, so re-running it also heals restored databases.
    db.pragma('journal_mode = WAL');
  }

  return db;
}
