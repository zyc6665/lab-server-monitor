/**
 * `app_secrets` accessors mirroring the Python oracle
 * `servermanage/storage/base.py`:
 *
 * - `get_secret` (`base.py:768`) -> {@link getSecret}
 * - `set_secret` (`base.py:1131`) -> {@link setSecret}
 * - `list_secret_names` (`base.py:867`) -> {@link listSecretNames}
 * - `delete_secret` (`base.py:754`) -> {@link deleteSecret}
 *
 * `app_secrets` stores the DPAPI ciphertext BLOB verbatim (see `./dpapi` for
 * protect/unprotect). The ciphertext bytes are never inspected or re-encoded
 * here — they round-trip byte-for-byte, so blobs written by the Python process
 * remain readable and vice versa.
 */
import { nowIsoUtc } from './time';

type SqliteDatabase = import('better-sqlite3').Database;

/** True for SQLite "no such table" errors (an uninitialised/old database). */
function isMissingTable(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message);
}

/** Returns the stored ciphertext for `name`, or `null` when absent. */
export function getSecret(db: SqliteDatabase, name: string): Buffer | null {
  let row: { ciphertext: Buffer | null } | undefined;
  try {
    row = db.prepare('SELECT ciphertext FROM app_secrets WHERE name = ?').get(name) as
      | { ciphertext: Buffer | null }
      | undefined;
  } catch (err) {
    if (isMissingTable(err)) {
      return null;
    }
    throw err;
  }

  if (!row || row.ciphertext === null) {
    return null;
  }
  // better-sqlite3 returns BLOBs as Buffer; copy so callers cannot mutate the
  // driver's internal buffer.
  return Buffer.from(row.ciphertext);
}

/** Inserts or replaces the encrypted `ciphertext` stored under `name`. */
export function setSecret(db: SqliteDatabase, name: string, ciphertext: Buffer): void {
  db.prepare(
    `INSERT INTO app_secrets (name, ciphertext, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       ciphertext = excluded.ciphertext,
       updated_at = excluded.updated_at`,
  ).run(name, ciphertext, nowIsoUtc());
}

/** Returns every stored secret name, ordered alphabetically (`ORDER BY name`). */
export function listSecretNames(db: SqliteDatabase): string[] {
  let rows: Array<{ name: string }>;
  try {
    rows = db.prepare('SELECT name FROM app_secrets ORDER BY name').all() as Array<{
      name: string;
    }>;
  } catch (err) {
    if (isMissingTable(err)) {
      return [];
    }
    throw err;
  }
  return rows.map((row) => row.name);
}

/** Removes the secret stored under `name` if present. */
export function deleteSecret(db: SqliteDatabase, name: string): void {
  db.prepare('DELETE FROM app_secrets WHERE name = ?').run(name);
}
