/**
 * `app_settings` accessors mirroring the Python oracle
 * `servermanage/storage/base.py`:
 *
 * - `load_app_settings` (`base.py:920`) -> {@link loadAppSettings}
 * - `save_app_settings` (`base.py:1115`) -> {@link saveAppSettings}
 * - `delete_app_settings` (`base.py:740`) -> {@link deleteAppSettings}
 *
 * The table stores one row per section: a JSON `payload` (encoded exactly like
 * Python's `dump_json`, see `./json`) and an `updated_at` ISO-8601 UTC string.
 * Writes use an `INSERT ... ON CONFLICT(section) DO UPDATE` upsert, matching
 * `save_app_settings`'s insert-or-replace semantics.
 */
import { dumpJson, loadJson } from './json';
import { nowIsoUtc } from './time';

type SqliteDatabase = import('better-sqlite3').Database;

/** One section's decoded JSON payload. */
export type AppSettingsPayload = Record<string, unknown>;

/** The full `{section: payload}` map returned by {@link loadAppSettings}. */
export type AppSettings = Record<string, AppSettingsPayload>;

interface SettingsRow {
  section: string;
  payload: string;
}

/** True for SQLite "no such table" errors (an uninitialised/old database). */
function isMissingTable(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message);
}

/**
 * Returns `{section: payload}` for every stored settings section.
 *
 * Mirrors `load_app_settings`, which returns `{}` when the database is missing
 * or the `app_settings` table has not been created yet (`OperationalError`).
 */
export function loadAppSettings(db: SqliteDatabase): AppSettings {
  let rows: SettingsRow[];
  try {
    rows = db.prepare('SELECT section, payload FROM app_settings').all() as SettingsRow[];
  } catch (err) {
    if (isMissingTable(err)) {
      return {};
    }
    throw err;
  }

  const settings: AppSettings = {};
  for (const row of rows) {
    settings[row.section] = loadJson<AppSettingsPayload>(row.payload);
  }
  return settings;
}

/**
 * Inserts or replaces the JSON `payload` stored for `section`, stamping
 * `updated_at` with {@link nowIsoUtc}. Mirrors `save_app_settings`.
 */
export function saveAppSettings(
  db: SqliteDatabase,
  section: string,
  payload: AppSettingsPayload,
): void {
  db.prepare(
    `INSERT INTO app_settings (section, payload, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(section) DO UPDATE SET
       payload = excluded.payload,
       updated_at = excluded.updated_at`,
  ).run(section, dumpJson(payload), nowIsoUtc());
}

/** Removes the settings row for `section` if present. Mirrors `delete_app_settings`. */
export function deleteAppSettings(db: SqliteDatabase, section: string): void {
  db.prepare('DELETE FROM app_settings WHERE section = ?').run(section);
}
