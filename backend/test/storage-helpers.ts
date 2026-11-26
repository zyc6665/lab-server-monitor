/**
 * Shared fixtures for the settings / secrets / task_state storage tests.
 *
 * Every test gets a brand-new database file in its own temp directory with the
 * full schema created, so rows never leak between tests. Call
 * {@link cleanupStorageTests} from `afterEach`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/storage/db';
import { initSchema } from '../src/storage/schema';

export type TestDb = ReturnType<typeof openDatabase>;

const dirs: string[] = [];
const dbs: TestDb[] = [];

/** A `db` handle for a fresh, fully initialised database plus its file path. */
export interface FreshDb {
  db: TestDb;
  dbPath: string;
}

/** Creates a temp directory + initialised SQLite database for one test. */
export function freshDb(): FreshDb {
  const dir = mkdtempSync(path.join(tmpdir(), 'sm-storage-'));
  dirs.push(dir);
  const dbPath = path.join(dir, 'servermonitor.db');
  const db = openDatabase(dbPath);
  dbs.push(db);
  initSchema(db);
  return { db, dbPath };
}

/**
 * Closes every database opened by {@link freshDb} and removes its temp
 * directory. Closing first is essential on Windows: an open handle keeps the
 * `-wal`/`-shm` siblings locked and `rmSync` would fail.
 */
export function cleanupStorageTests(): void {
  for (const db of dbs) {
    if (db.open) {
      db.close();
    }
  }
  dbs.length = 0;
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
}
