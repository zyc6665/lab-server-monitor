import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/storage/db';
import { SCHEMA_VERSION, initSchema } from '../src/storage/schema';
import { backupBeforeMigration, migrateLegacy } from '../src/storage/migrate';

type SqliteDb = ReturnType<typeof openDatabase>;

let dbs: SqliteDb[] = [];
let dirs: string[] = [];

function track(db: SqliteDb): SqliteDb {
  dbs.push(db);
  return db;
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sm-migrate-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const db of dbs) {
    if (db.open) {
      db.close();
    }
  }
  dbs = [];
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function tableInfo(db: SqliteDb, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

function columnNames(db: SqliteDb, table: string): string[] {
  return tableInfo(db, table).map((row) => row.name);
}

function indexNames(db: SqliteDb): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function userVersion(db: SqliteDb): number {
  return db.pragma('user_version', { simple: true }) as number;
}

// --- Pre-migration ("legacy") DDL: the current table shapes minus the columns
// each migration is responsible for adding. ---------------------------------

const LEGACY_HOST_METRICS_HISTORY = `
CREATE TABLE host_metrics_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collected_at TEXT NOT NULL,
    host_name TEXT NOT NULL,
    host TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 0,
    cpu_usage_percent REAL,
    memory_used_mb INTEGER,
    memory_total_mb INTEGER,
    disk_used_percent REAL,
    gpu_utilization_percent REAL,
    gpu_memory_used_mb INTEGER,
    gpu_memory_total_mb INTEGER,
    total_processes INTEGER,
    logged_in_user_count INTEGER,
    load_1 REAL,
    load_5 REAL,
    load_15 REAL
);`;

const LEGACY_HOST_USER_SNAPSHOT = `
CREATE TABLE host_user_snapshot (
    host_name TEXT NOT NULL,
    username TEXT NOT NULL,
    uid INTEGER NOT NULL,
    gid INTEGER NOT NULL,
    primary_group TEXT,
    gecos TEXT,
    home TEXT,
    shell TEXT,
    groups_json TEXT NOT NULL DEFAULT '[]',
    in_docker INTEGER NOT NULL DEFAULT 0,
    in_sudo INTEGER NOT NULL DEFAULT 0,
    home_exists INTEGER NOT NULL DEFAULT 0,
    home_owner TEXT,
    home_group TEXT,
    home_mode TEXT,
    home_size_bytes INTEGER,
    data_exists INTEGER NOT NULL DEFAULT 0,
    data_owner TEXT,
    data_group TEXT,
    data_mode TEXT,
    data_size_bytes INTEGER,
    data_supported INTEGER NOT NULL DEFAULT 1,
    usage_stale INTEGER NOT NULL DEFAULT 0,
    usage_collected_at TEXT,
    collected_at TEXT NOT NULL,
    PRIMARY KEY (host_name, username)
);`;

/** Pre-0.1.1 shape: no `tz`, primary key is only (day, host_name). */
const LEGACY_HOST_DAILY_SUMMARY = `
CREATE TABLE host_daily_summary (
    day TEXT NOT NULL,
    host_name TEXT NOT NULL,
    host TEXT NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    cpu_sum REAL,
    cpu_max REAL,
    cpu_min REAL,
    memory_pct_sum REAL,
    memory_pct_max REAL,
    disk_pct_sum REAL,
    disk_pct_max REAL,
    gpu_util_sum REAL,
    gpu_util_max REAL,
    gpu_memory_pct_sum REAL,
    gpu_memory_pct_max REAL,
    load_sum REAL,
    users_sum REAL,
    processes_sum REAL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (day, host_name)
);`;

interface LegacySeedOptions {
  /** Omit `processes_sum` from the daily summary to force a mid-migration error. */
  breakDailySummary?: boolean;
}

/**
 * Build an in-memory database with the OLD table shapes and a couple of rows so
 * the migration has data to preserve.
 */
function legacyDb(opts: LegacySeedOptions = {}): SqliteDb {
  const db = track(new Database(':memory:'));
  db.exec(LEGACY_HOST_METRICS_HISTORY);
  db.exec(LEGACY_HOST_USER_SNAPSHOT);
  db.exec(
    opts.breakDailySummary
      ? LEGACY_HOST_DAILY_SUMMARY.replace(/\n\s*processes_sum REAL,/, '')
      : LEGACY_HOST_DAILY_SUMMARY,
  );

  db.prepare(
    `INSERT INTO host_metrics_history
       (collected_at, host_name, host, success, cpu_usage_percent, memory_used_mb,
        memory_total_mb, load_1, load_5, load_15)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('2026-01-02T03:04:05.000000+00:00', 'alpha', '10.0.0.5', 1, 42.5, 512, 2048, 0.5, 0.4, 0.3);
  db.prepare(
    `INSERT INTO host_metrics_history
       (collected_at, host_name, host, success, cpu_usage_percent, memory_used_mb,
        memory_total_mb, load_1, load_5, load_15)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('2026-01-02T03:05:05.000000+00:00', 'beta', '10.0.0.6', 0, 7.25, 256, 1024, 0.1, 0.2, 0.3);

  db.prepare(
    `INSERT INTO host_user_snapshot
       (host_name, username, uid, gid, home, shell, groups_json, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('alpha', 'alice', 1000, 1000, '/home/alice', '/bin/bash', '["sudo"]', '2026-01-02T03:04:05.000000+00:00');

  if (!opts.breakDailySummary) {
    db.prepare(
      `INSERT INTO host_daily_summary
         (day, host_name, host, sample_count, success_count, cpu_sum, cpu_max, cpu_min,
          memory_pct_sum, memory_pct_max, disk_pct_sum, disk_pct_max, gpu_util_sum,
          gpu_util_max, gpu_memory_pct_sum, gpu_memory_pct_max, load_sum, users_sum,
          processes_sum, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      '2026-01-02', 'alpha', '10.0.0.5', 3, 3, 120.5, 45.0, 38.0,
      60.0, 30.0, 50.0, 40.0, 70.0, 65.0, 55.0, 50.0, 1.5, 4.0,
      300.0, '2026-01-02T23:59:59.000000+00:00',
    );
  }

  return db;
}

describe('migrateLegacy', () => {
  it('adds the host_metrics_history net/temperature columns and preserves rows', () => {
    const db = legacyDb();
    const before = db
      .prepare('SELECT collected_at, host_name, cpu_usage_percent, load_15 FROM host_metrics_history ORDER BY id')
      .all();
    expect(columnNames(db, 'host_metrics_history')).not.toContain('net_rx_bytes');

    const result = migrateLegacy(db);

    const cols = columnNames(db, 'host_metrics_history');
    expect(cols).toContain('net_rx_bytes');
    expect(cols).toContain('net_tx_bytes');
    expect(cols).toContain('temperature_c');
    expect(
      result.addedColumns.filter((name) => name.startsWith('host_metrics_history.')),
    ).toEqual([
      'host_metrics_history.net_rx_bytes',
      'host_metrics_history.net_tx_bytes',
      'host_metrics_history.temperature_c',
    ]);
    expect(result.changed).toBe(true);

    // Existing values untouched; new columns are NULL for historical rows.
    const after = db
      .prepare('SELECT collected_at, host_name, cpu_usage_percent, load_15, net_rx_bytes, temperature_c FROM host_metrics_history ORDER BY id')
      .all();
    expect(
      after.map((row) => {
        const rec = { ...(row as Record<string, unknown>) };
        expect(rec.net_rx_bytes).toBeNull();
        expect(rec.temperature_c).toBeNull();
        delete rec.net_rx_bytes;
        delete rec.temperature_c;
        return rec;
      }),
    ).toEqual(before);
    expect(after).toHaveLength(2);
  });

  it('adds usage_readable DEFAULT 1 to host_user_snapshot and preserves rows', () => {
    const db = legacyDb();
    migrateLegacy(db);

    const info = tableInfo(db, 'host_user_snapshot');
    const usageReadable = info.find((row) => row.name === 'usage_readable');
    expect(usageReadable).toBeDefined();
    expect(usageReadable?.notnull).toBe(1);
    expect(usageReadable?.dflt_value).toBe('1');

    const row = db
      .prepare('SELECT username, uid, home, groups_json, usage_readable FROM host_user_snapshot')
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      username: 'alice',
      uid: 1000,
      home: '/home/alice',
      groups_json: '["sudo"]',
      usage_readable: 1,
    });
  });

  it('rebuilds host_daily_summary with the tz column and 3-column primary key', () => {
    const db = legacyDb();
    const result = migrateLegacy(db);

    expect(result.rebuiltDailySummary).toBe(true);

    const info = tableInfo(db, 'host_daily_summary');
    const names = info.map((row) => row.name);
    expect(names).toContain('tz');

    // tz is the 3rd primary-key column: (day, host_name, tz) => pk ranks 1,2,3.
    const pkColumns = info
      .filter((row) => row.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((row) => row.name);
    expect(pkColumns).toEqual(['day', 'host_name', 'tz']);

    // Existing row preserved and tagged with the default timezone.
    const row = db
      .prepare('SELECT day, host_name, tz, host, sample_count, cpu_sum, processes_sum FROM host_daily_summary')
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      day: '2026-01-02',
      host_name: 'alpha',
      tz: 'UTC',
      host: '10.0.0.5',
      sample_count: 3,
      cpu_sum: 120.5,
      processes_sum: 300,
    });
    // The legacy scratch table is gone.
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='host_daily_summary_legacy'").get(),
    ).toBeUndefined();
  });

  it('honours a custom dailySummaryTz for pre-tz rows', () => {
    const db = legacyDb();
    migrateLegacy(db, { dailySummaryTz: 'Asia/Shanghai' });
    const tz = db.prepare('SELECT tz FROM host_daily_summary').pluck().get();
    expect(tz).toBe('Asia/Shanghai');
  });

  it('produces table_info matching a freshly initialised schema', () => {
    const migrated = legacyDb();
    migrateLegacy(migrated);

    const fresh = track(new Database(':memory:'));
    initSchema(fresh);

    // host_metrics_history: ALTER ... ADD COLUMN appends at the tail, which
    // matches the fresh DDL order because those columns are last there too.
    expect(tableInfo(migrated, 'host_metrics_history')).toEqual(
      tableInfo(fresh, 'host_metrics_history'),
    );
    // host_daily_summary is re-created from the current DDL, so it matches exactly.
    expect(tableInfo(migrated, 'host_daily_summary')).toEqual(
      tableInfo(fresh, 'host_daily_summary'),
    );
    // host_user_snapshot.usage_readable is appended at the end by ALTER (Python
    // does the same), so compare the column *set* rather than order.
    expect(new Set(columnNames(migrated, 'host_user_snapshot'))).toEqual(
      new Set(columnNames(fresh, 'host_user_snapshot')),
    );

    // Indexes created by the DDL exist on the migrated database.
    const indexes = indexNames(migrated);
    expect(indexes).toContain('idx_host_metrics_history_collected_at');
    expect(indexes).toContain('idx_host_metrics_history_host');
    expect(indexes).toContain('idx_host_metrics_history_host_collected');
    expect(indexes).toContain('idx_host_daily_summary_day');
    expect(indexes).toContain('idx_host_user_snapshot_host');
  });

  it('sets user_version to SCHEMA_VERSION', () => {
    const db = legacyDb();
    expect(userVersion(db)).toBe(0);
    migrateLegacy(db);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('is idempotent: a second call changes nothing', () => {
    const db = legacyDb();
    migrateLegacy(db);

    const metricsBefore = db.prepare('SELECT * FROM host_metrics_history ORDER BY id').all();
    const summaryBefore = db.prepare('SELECT * FROM host_daily_summary ORDER BY day, host_name').all();

    const second = migrateLegacy(db);

    expect(second.changed).toBe(false);
    expect(second.addedColumns).toEqual([]);
    expect(second.rebuiltDailySummary).toBe(false);
    expect(second.userVersion).toBe(SCHEMA_VERSION);
    expect(db.prepare('SELECT * FROM host_metrics_history ORDER BY id').all()).toEqual(metricsBefore);
    expect(db.prepare('SELECT * FROM host_daily_summary ORDER BY day, host_name').all()).toEqual(summaryBefore);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('migrates a fully empty (fresh) database to the current schema', () => {
    const db = track(new Database(':memory:'));
    const result = migrateLegacy(db);
    expect(result.changed).toBe(false); // DDL created everything; no legacy fixes needed
    expect(columnNames(db, 'host_metrics_history')).toContain('temperature_c');
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('rolls back completely when a migration step fails mid-way', () => {
    const db = legacyDb({ breakDailySummary: true });
    const summaryInfoBefore = tableInfo(db, 'host_daily_summary');
    const summaryRowsBefore = db.prepare('SELECT * FROM host_daily_summary ORDER BY day, host_name').all();
    const tablesBefore = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>
    ).map((row) => row.name);

    expect(() => migrateLegacy(db)).toThrow();

    // Nothing from the partial migration survives: no new columns, no renamed
    // scratch table, no other tables created by the base DDL inside the txn.
    expect(tableInfo(db, 'host_daily_summary')).toEqual(summaryInfoBefore);
    expect(columnNames(db, 'host_daily_summary')).not.toContain('tz');
    expect(db.prepare('SELECT * FROM host_daily_summary ORDER BY day, host_name').all()).toEqual(summaryRowsBefore);
    expect(columnNames(db, 'host_metrics_history')).not.toContain('net_rx_bytes');
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='host_daily_summary_legacy'").get(),
    ).toBeUndefined();
    const tablesAfter = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tablesAfter).toEqual(tablesBefore);
    expect(userVersion(db)).toBe(0);
  });
});

describe('backupBeforeMigration', () => {
  it('writes a readable copy next to the source with identical row counts', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'servermonitor.db');

    const source = openDatabase(dbPath);
    source.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    const insert = source.prepare('INSERT INTO marker (label) VALUES (?)');
    insert.run('one');
    insert.run('two');
    insert.run('three');
    source.close();

    const backupPath = await backupBeforeMigration(dbPath);

    expect(backupPath).toBe(path.join(path.dirname(backupPath), path.basename(backupPath)));
    expect(existsSync(backupPath)).toBe(true);
    // Filename is "<db>.<stamp>.bak" in the source directory.
    expect(path.dirname(backupPath)).toBe(dir);
    expect(path.basename(backupPath)).toMatch(/^servermonitor\.db\.\d{8}T\d{9}Z\.bak$/);
    expect(readdirSync(dir).filter((name) => name.endsWith('.bak'))).toHaveLength(1);

    const copy = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(copy.prepare('SELECT COUNT(*) FROM marker').pluck().get()).toBe(3);
      expect(
        copy.prepare('SELECT label FROM marker ORDER BY id').pluck().all(),
      ).toEqual(['one', 'two', 'three']);
    } finally {
      copy.close();
    }
  });

  it('supports an explicit target directory and fixed timestamp', async () => {
    const dir = tempDir();
    const backupDir = path.join(dir, 'backups');
    const dbPath = path.join(dir, 'servermonitor.db');
    const source = openDatabase(dbPath);
    source.exec('CREATE TABLE t (x INTEGER)');
    source.prepare('INSERT INTO t (x) VALUES (1)').run();
    source.close();

    const backupPath = await backupBeforeMigration(dbPath, {
      directory: backupDir,
      timestamp: new Date('2026-11-25T19:47:12.345Z'),
    });

    expect(backupPath).toBe(path.join(backupDir, 'servermonitor.db.20261125T194712345Z.bak'));
    expect(existsSync(backupPath)).toBe(true);
  });

  it('rejects a missing source database', async () => {
    const dir = tempDir();
    await expect(backupBeforeMigration(path.join(dir, 'nope.db'))).rejects.toThrow(/missing database/);
  });
});
