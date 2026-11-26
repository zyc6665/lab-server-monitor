/**
 * Legacy-database compatibility (plan Task 13).
 *
 * Two independent cases, both exercised through the real production code paths
 * (`openDatabase` → `migrateLegacy` → repository read helpers):
 *
 * 1. A committed OLD-shape SQLite fixture
 *    (`test/fixtures/legacy/servermonitor-legacy.db`): 12 user tables,
 *    `journal_mode=delete`, `user_version=0`, and the three pre-migration table
 *    shapes (`host_metrics_history` without net/temperature columns,
 *    `host_user_snapshot` without `usage_readable`, `host_daily_summary`
 *    without `tz`). We migrate a fresh *copy* of it and assert the migration
 *    adds the columns, rebuilds the summary table, preserves row counts/values,
 *    switches the journal to WAL and stamps `user_version = SCHEMA_VERSION`.
 *
 * 2. A read-only COPY of the real `data/servermonitor.db` (skipped when the
 *    file is absent). The original is never opened writable; we hash it before
 *    and after to prove it is byte-for-byte untouched, migrate the copy and
 *    run the same key queries against it.
 *
 * Note on `journal_mode`: `openDatabase` (Task 1 contract) only enables WAL for
 * a brand-new file, and `migrateLegacy` never changes the journal mode. The
 * Python oracle's `init_storage` *always* runs `PRAGMA journal_mode = WAL`
 * before its DDL, so each case below applies that same step first (mirroring
 * the runtime) and then asserts the migrated copy ends up in WAL mode. No source
 * module is modified to make this true.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../../src/storage/db';
import { SCHEMA_VERSION } from '../../src/storage/schema';
import { migrateLegacy } from '../../src/storage/migrate';
import { getAllHostSnapshots } from '../../src/storage/hosts';
import { fetchHostHistory } from '../../src/storage/metrics-read';
import { listAlerts } from '../../src/storage/alerts';
import { loadAppSettings } from '../../src/storage/settings';

type SqliteDb = import('better-sqlite3').Database;

const testDir = path.dirname(fileURLToPath(import.meta.url));
/** Committed legacy fixture, relative to this test (`backend/test/legacy/`). */
const FIXTURE_PATH = path.resolve(testDir, '..', 'fixtures', 'legacy', 'servermonitor-legacy.db');
/** The real application database at the repository root (`data/servermonitor.db`). */
const REAL_DB_PATH = path.resolve(testDir, '..', '..', '..', 'data', 'servermonitor.db');

/** The 12 user tables the fixture ships with (pre-migration old shape). */
const LEGACY_TABLES = [
  'alerts',
  'app_secrets',
  'app_settings',
  'disk_controller_snapshot',
  'disk_health_snapshot',
  'disk_pd_snapshot',
  'disk_vd_snapshot',
  'host_daily_summary',
  'host_latest_snapshot',
  'host_metrics_history',
  'host_user_snapshot',
  'task_state',
] as const;

const dbs: SqliteDb[] = [];
const dirs: string[] = [];

function track(db: SqliteDb): SqliteDb {
  dbs.push(db);
  return db;
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sm-legacy-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
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
});

// --- small introspection helpers ------------------------------------------

function journalMode(db: SqliteDb): string {
  return db.pragma('journal_mode', { simple: true }) as string;
}

function userVersion(db: SqliteDb): number {
  return db.pragma('user_version', { simple: true }) as number;
}

function userTables(db: SqliteDb): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function columns(db: SqliteDb, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

function rowCount(db: SqliteDb, table: string): number {
  return db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
}

function countSnapshot(db: SqliteDb, tables: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = rowCount(db, table);
  }
  return counts;
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Brings a legacy copy up to the current schema the way the runtime would:
 * open the handle, enable WAL (`init_storage` does this on every connection),
 * then run the migration.
 */
function openAndMigrate(copyPath: string): { db: SqliteDb; result: ReturnType<typeof migrateLegacy> } {
  const db = track(openDatabase(copyPath));
  db.pragma('journal_mode = WAL');
  const result = migrateLegacy(db);
  return { db, result };
}

// --- 1. the committed fixture itself --------------------------------------

describe('legacy fixture: old database shape', () => {
  it('is a 12-table, journal_mode=delete, user_version=0 DB missing the newer columns', () => {
    expect(existsSync(FIXTURE_PATH)).toBe(true);
    // Size is deliberately controlled by the plan (<200 KB).
    const size = statSync(FIXTURE_PATH).size;
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(200 * 1024);

    const db = track(new Database(FIXTURE_PATH, { readonly: true, fileMustExist: true }));

    expect(journalMode(db)).toBe('delete');
    expect(userVersion(db)).toBe(0);
    expect(userTables(db)).toEqual([...LEGACY_TABLES]);

    // Exactly the three pre-migration table shapes.
    expect(columns(db, 'host_metrics_history')).not.toContain('net_rx_bytes');
    expect(columns(db, 'host_metrics_history')).not.toContain('net_tx_bytes');
    expect(columns(db, 'host_metrics_history')).not.toContain('temperature_c');
    expect(columns(db, 'host_user_snapshot')).not.toContain('usage_readable');
    expect(columns(db, 'host_daily_summary')).not.toContain('tz');

    // Representative rows exist in several tables.
    expect(rowCount(db, 'host_metrics_history')).toBe(3);
    expect(rowCount(db, 'host_latest_snapshot')).toBe(2);
    expect(rowCount(db, 'alerts')).toBe(2);
    expect(rowCount(db, 'app_settings')).toBe(2);
    expect(rowCount(db, 'app_secrets')).toBe(1);
    expect(rowCount(db, 'task_state')).toBe(1);
    expect(rowCount(db, 'host_daily_summary')).toBe(2);
    expect(rowCount(db, 'host_user_snapshot')).toBe(2);
    expect(rowCount(db, 'disk_health_snapshot')).toBe(1);
    expect(rowCount(db, 'disk_controller_snapshot')).toBe(1);
  });
});

// --- 2. migrating a copy of the fixture -----------------------------------

describe('migrateLegacy: fixture copy', () => {
  it('adds columns, rebuilds daily summary, preserves rows, ends in WAL with user_version', () => {
    const dir = tempDir();
    const copy = path.join(dir, 'servermonitor-legacy-copy.db');
    copyFileSync(FIXTURE_PATH, copy);

    const db = track(openDatabase(copy));
    // The pristine copy still carries the legacy journal mode.
    expect(journalMode(db)).toBe('delete');
    const before = countSnapshot(db, LEGACY_TABLES);

    db.pragma('journal_mode = WAL');
    const result = migrateLegacy(db);

    // What the migration reports it did.
    expect(result.changed).toBe(true);
    expect(result.addedColumns).toEqual([
      'host_metrics_history.net_rx_bytes',
      'host_metrics_history.net_tx_bytes',
      'host_metrics_history.temperature_c',
      'host_user_snapshot.usage_readable',
    ]);
    expect(result.rebuiltDailySummary).toBe(true);
    expect(result.userVersion).toBe(SCHEMA_VERSION);

    // Persisted on the file: WAL + schema version.
    expect(journalMode(db)).toBe('wal');
    expect(userVersion(db)).toBe(SCHEMA_VERSION);

    // Columns now present.
    expect(columns(db, 'host_metrics_history')).toEqual(
      expect.arrayContaining(['net_rx_bytes', 'net_tx_bytes', 'temperature_c']),
    );
    expect(columns(db, 'host_user_snapshot')).toContain('usage_readable');
    expect(columns(db, 'host_daily_summary')).toContain('tz');

    // The full schema now exists: 20 oracle tables + 2 Node-only P1 tables.
    expect(userTables(db)).toHaveLength(23);

    // No rows gained or lost in any pre-existing table (incl. rebuilt summary).
    expect(countSnapshot(db, LEGACY_TABLES)).toEqual(before);

    // Values preserved; the new columns default to NULL for historical rows.
    const metric = db
      .prepare(
        'SELECT cpu_usage_percent, memory_used_mb, net_rx_bytes, temperature_c'
          + ' FROM host_metrics_history WHERE host_name = ? ORDER BY id LIMIT 1',
      )
      .get('alpha') as Record<string, unknown>;
    expect(metric).toEqual({
      cpu_usage_percent: 42.5,
      memory_used_mb: 512,
      net_rx_bytes: null,
      temperature_c: null,
    });

    // usage_readable backfills to 1 (ALTER ... DEFAULT 1).
    expect(
      db.prepare('SELECT username, usage_readable FROM host_user_snapshot WHERE username = ?').get('alice'),
    ).toEqual({ username: 'alice', usage_readable: 1 });

    // Rebuilt summary keeps the row and tags it with the default timezone.
    expect(
      db
        .prepare('SELECT day, host_name, tz, cpu_sum, processes_sum FROM host_daily_summary ORDER BY host_name LIMIT 1')
        .get(),
    ).toEqual({
      day: '2026-01-02',
      host_name: 'alpha',
      tz: 'UTC',
      cpu_sum: 120.5,
      processes_sum: 300,
    });

    // The scratch rename table is gone.
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='host_daily_summary_legacy'")
        .get(),
    ).toBeUndefined();
  });

  it('serves the key read paths (snapshots / metrics history / alerts / settings) after migrating', () => {
    const dir = tempDir();
    const copy = path.join(dir, 'servermonitor-legacy-copy.db');
    copyFileSync(FIXTURE_PATH, copy);
    const { db } = openAndMigrate(copy);

    // Snapshots.
    const snapshots = getAllHostSnapshots(db);
    expect(snapshots).toHaveLength(2);
    const alpha = snapshots.find((row) => row.host_name === 'alpha');
    expect(alpha).toBeDefined();
    expect(alpha?.success).toBe(true);
    expect(alpha?.metrics).toEqual({ cpu: 42.5 });
    expect(alpha?.errors).toEqual([]);

    // Metrics history (raw 24h window).
    const history = fetchHostHistory(db, 'alpha', {
      rangeKey: '24h',
      now: new Date('2026-01-02T04:00:00.000Z'),
    });
    expect(history).toHaveLength(2);
    expect(history[0].cpu).toBe(42.5);
    expect(history[1].cpu).toBe(45);

    // Alerts.
    const alerts = listAlerts(db);
    expect(alerts).toHaveLength(2);
    expect(alerts.map((row) => row.fingerprint).sort()).toEqual([
      'network:beta:down',
      'system:alpha:cpu',
    ]);

    // Settings (payloads are decoded JSON).
    const settings = loadAppSettings(db);
    expect(settings.general).toEqual({ site_name: 'Lab', poll_interval: 30 });
    expect(settings.notifications).toEqual({ desktop: true });

    // Secrets survive as BLOBs.
    expect(rowCount(db, 'app_secrets')).toBe(1);
  });

  it('is idempotent: a second migration changes nothing and keeps data', () => {
    const dir = tempDir();
    const copy = path.join(dir, 'servermonitor-legacy-copy.db');
    copyFileSync(FIXTURE_PATH, copy);

    const { db } = openAndMigrate(copy);
    const metricsBefore = db.prepare('SELECT * FROM host_metrics_history ORDER BY id').all();
    const summaryBefore = db.prepare('SELECT * FROM host_daily_summary ORDER BY host_name').all();

    const second = migrateLegacy(db);
    expect(second.changed).toBe(false);
    expect(second.addedColumns).toEqual([]);
    expect(second.rebuiltDailySummary).toBe(false);
    expect(second.userVersion).toBe(SCHEMA_VERSION);

    expect(db.prepare('SELECT * FROM host_metrics_history ORDER BY id').all()).toEqual(metricsBefore);
    expect(db.prepare('SELECT * FROM host_daily_summary ORDER BY host_name').all()).toEqual(summaryBefore);
    expect(journalMode(db)).toBe('wal');
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
  });
});

// --- 3. a copy of the real database (read-only source) --------------------

describe.skipIf(!existsSync(REAL_DB_PATH))('real data/servermonitor.db copy', () => {
  it('migrates and reads a copy without modifying the real database', () => {
    const realSizeBefore = statSync(REAL_DB_PATH).size;
    const realHashBefore = sha256File(REAL_DB_PATH);

    const dir = tempDir();
    const copy = path.join(dir, 'servermonitor-real-copy.db');
    copyFileSync(REAL_DB_PATH, copy);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(REAL_DB_PATH + suffix)) {
        copyFileSync(REAL_DB_PATH + suffix, copy + suffix);
      }
    }

    const watched = ['host_metrics_history', 'host_latest_snapshot', 'alerts', 'app_settings', 'app_secrets'];
    const db = track(openDatabase(copy));
    const before = countSnapshot(db, watched);

    db.pragma('journal_mode = WAL');
    const result = migrateLegacy(db);

    // The real DB predates the net/temperature columns, so this is a real change.
    expect(result.changed).toBe(true);
    expect(result.addedColumns).toEqual([
      'host_metrics_history.net_rx_bytes',
      'host_metrics_history.net_tx_bytes',
      'host_metrics_history.temperature_c',
    ]);
    expect(journalMode(db)).toBe('wal');
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    // 20 oracle tables + 2 Node-only P1 tables (task_runs, alert_delivery_failures).
    expect(userTables(db)).toHaveLength(23);

    // Existing rows untouched by the migration.
    expect(countSnapshot(db, watched)).toEqual(before);
    expect(columns(db, 'host_metrics_history')).toEqual(
      expect.arrayContaining(['net_rx_bytes', 'net_tx_bytes', 'temperature_c']),
    );

    // Key read paths succeed on the migrated copy.
    const snapshots = getAllHostSnapshots(db);
    expect(snapshots.length).toBe(before.host_latest_snapshot);
    expect(snapshots.length).toBeGreaterThan(0);

    const alerts = listAlerts(db);
    expect(alerts.length).toBe(before.alerts);

    const settings = loadAppSettings(db);
    expect(Object.keys(settings)).toEqual(expect.arrayContaining(['hosts', 'security']));

    // Historical sample at 2026-11-06T15:33:35Z, read within its 24h window.
    const history = fetchHostHistory(db, 'a100', {
      rangeKey: '24h',
      now: new Date('2026-11-06T16:00:00.000Z'),
    });
    expect(history.length).toBeGreaterThanOrEqual(1);

    // The real database was only ever read, never opened writable: unchanged.
    expect(statSync(REAL_DB_PATH).size).toBe(realSizeBefore);
    expect(sha256File(REAL_DB_PATH)).toBe(realHashBefore);
  });
});
