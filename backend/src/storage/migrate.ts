/**
 * Legacy-database migrations plus a pre-migration safety copy.
 *
 * Mirrors the three upgrade paths in the Python oracle
 * `servermanage/storage/base.py`:
 *
 * - `_ensure_host_metrics_columns` (`base.py:440`) — adds `net_rx_bytes`,
 *   `net_tx_bytes` (INTEGER) and `temperature_c` (REAL) to
 *   `host_metrics_history` for databases created before v0.1.75.
 * - `_ensure_user_snapshot_columns` (`base.py:455`) — adds
 *   `usage_readable INTEGER NOT NULL DEFAULT 1` to `host_user_snapshot`.
 * - `_migrate_host_daily_summary` (`base.py:568`) — rebuilds the pre-0.1.1
 *   `host_daily_summary` table (which lacked `tz` and had a `(day, host_name)`
 *   primary key) as a rename-copy-drop migration to the current
 *   `(day, host_name, tz)` primary key.
 *
 * `init_storage` (`base.py:805`) first runs the idempotent `CREATE ... IF NOT
 * EXISTS` DDL and only then applies those three fixes; {@link migrateLegacy}
 * reproduces that same ordering. It runs entirely inside one transaction so a
 * failure leaves the database untouched, and writes `PRAGMA user_version` on
 * success.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { CREATE_STATEMENTS, SCHEMA_VERSION } from './schema';

type SqliteDatabase = import('better-sqlite3').Database;

export interface MigrateLegacyOptions {
  /**
   * Timezone key written into the rebuilt `host_daily_summary.tz` column for
   * pre-`tz` rows. Matches `init_storage(daily_summary_tz=...)`; existing rows
   * were produced with the configured local zone, so they are tagged with it
   * rather than blindly labelled UTC. Defaults to `'UTC'`.
   */
  dailySummaryTz?: string;
  /** Schema version to write to `PRAGMA user_version`. Defaults to {@link SCHEMA_VERSION}. */
  schemaVersion?: number;
}

export interface MigrationResult {
  /** True when any schema change was applied (false on an already-current DB). */
  changed: boolean;
  /** Column names actually added during this run, in application order. */
  addedColumns: string[];
  /** True when `host_daily_summary` was rebuilt to add the `tz` primary-key column. */
  rebuiltDailySummary: boolean;
  /** The `PRAGMA user_version` value after the migration. */
  userVersion: number;
}

interface ColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** Column names currently present on `table` (empty when the table is missing). */
function tableColumns(db: SqliteDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[];
  return new Set(rows.map((row) => row.name));
}

/** Locate a statement in the shared DDL by a unique fragment. */
function createStatement(fragment: string): string {
  const statement = CREATE_STATEMENTS.find((sql) => sql.includes(fragment));
  if (!statement) {
    throw new Error(`schema DDL is missing the statement containing ${fragment}`);
  }
  return statement;
}

const HOST_DAILY_SUMMARY_DDL = createStatement(
  'CREATE TABLE IF NOT EXISTS host_daily_summary',
);
const HOST_DAILY_SUMMARY_INDEX_DDL = createStatement('idx_host_daily_summary_day');

/**
 * Bring a legacy database up to the current schema, idempotently.
 *
 * 1. Executes the full `CREATE ... IF NOT EXISTS` DDL (no-op for tables that
 *    already exist — exactly like `init_storage`).
 * 2. Adds the missing `host_metrics_history` columns.
 * 3. Adds the missing `host_user_snapshot.usage_readable` column.
 * 4. Rebuilds `host_daily_summary` when it predates the `tz` column.
 * 5. Sets `PRAGMA user_version = SCHEMA_VERSION`.
 *
 * The whole sequence runs in one transaction; any error rolls everything back
 * and rethrows. Calling it on an already-current database performs no schema
 * change (only re-writing the same `user_version`, which is a no-op).
 */
export function migrateLegacy(
  db: SqliteDatabase,
  opts: MigrateLegacyOptions = {},
): MigrationResult {
  const dailySummaryTz = opts.dailySummaryTz ?? 'UTC';
  const targetVersion = opts.schemaVersion ?? SCHEMA_VERSION;

  const run = db.transaction((): MigrationResult => {
    // Step 1: idempotent base DDL (mirrors init_storage's executescript calls).
    for (const statement of CREATE_STATEMENTS) {
      db.exec(statement);
    }

    const addedColumns: string[] = [];
    let rebuiltDailySummary = false;

    // Step 2: host_metrics_history net/temperature columns (base.py:440).
    const metricColumns = tableColumns(db, 'host_metrics_history');
    for (const column of ['net_rx_bytes', 'net_tx_bytes']) {
      if (!metricColumns.has(column)) {
        db.exec(`ALTER TABLE host_metrics_history ADD COLUMN ${column} INTEGER`);
        addedColumns.push(`host_metrics_history.${column}`);
      }
    }
    if (!metricColumns.has('temperature_c')) {
      db.exec('ALTER TABLE host_metrics_history ADD COLUMN temperature_c REAL');
      addedColumns.push('host_metrics_history.temperature_c');
    }

    // Step 3: host_user_snapshot.usage_readable (base.py:455).
    const userColumns = tableColumns(db, 'host_user_snapshot');
    if (!userColumns.has('usage_readable')) {
      db.exec(
        'ALTER TABLE host_user_snapshot'
          + ' ADD COLUMN usage_readable INTEGER NOT NULL DEFAULT 1',
      );
      addedColumns.push('host_user_snapshot.usage_readable');
    }

    // Step 4: rebuild host_daily_summary when it lacks `tz` (base.py:568).
    const dailyColumns = tableColumns(db, 'host_daily_summary');
    if (dailyColumns.size > 0 && !dailyColumns.has('tz')) {
      db.exec('DROP INDEX IF EXISTS idx_host_daily_summary_day');
      db.exec('ALTER TABLE host_daily_summary RENAME TO host_daily_summary_legacy');
      db.exec(HOST_DAILY_SUMMARY_DDL);
      db.exec(HOST_DAILY_SUMMARY_INDEX_DDL);
      db.prepare(
        `INSERT INTO host_daily_summary (
            day, host_name, tz, host, sample_count, success_count,
            cpu_sum, cpu_max, cpu_min, memory_pct_sum, memory_pct_max,
            disk_pct_sum, disk_pct_max, gpu_util_sum, gpu_util_max,
            gpu_memory_pct_sum, gpu_memory_pct_max, load_sum, users_sum,
            processes_sum, updated_at
        )
        SELECT
            day, host_name, ?, host, sample_count, success_count,
            cpu_sum, cpu_max, cpu_min, memory_pct_sum, memory_pct_max,
            disk_pct_sum, disk_pct_max, gpu_util_sum, gpu_util_max,
            gpu_memory_pct_sum, gpu_memory_pct_max, load_sum, users_sum,
            processes_sum, updated_at
        FROM host_daily_summary_legacy`,
      ).run(dailySummaryTz);
      db.exec('DROP TABLE host_daily_summary_legacy');
      rebuiltDailySummary = true;
    }

    // Step 5: record the Node-side schema version.
    db.pragma(`user_version = ${targetVersion}`);

    return {
      changed: addedColumns.length > 0 || rebuiltDailySummary,
      addedColumns,
      rebuiltDailySummary,
      userVersion: targetVersion,
    };
  });

  return run();
}

export interface BackupBeforeMigrationOptions {
  /**
   * Directory to write the backup into. Defaults to the directory containing
   * the database file (i.e. "next to it").
   */
  directory?: string;
  /** Fixed timestamp for the filename (primarily for deterministic tests). */
  timestamp?: Date;
}

/** Compact UTC stamp, e.g. `20261125T114712123Z` (no colons, filesystem-safe). */
function utcStamp(when: Date): string {
  return when.toISOString().replace(/[-:.]/g, '');
}

/**
 * Write a consistent copy of the SQLite database at `dbPath` before migrating.
 *
 * Uses better-sqlite3's online backup API, which produces a transactionally
 * consistent snapshot even while the database is in WAL mode or being read.
 * The backup is written to `<dbPath>.<UTCstamp>.bak` (or
 * `<directory>/<basename>.<UTCstamp>.bak` when `directory` is given) and the
 * resolved backup path is returned. Safe to call before {@link migrateLegacy};
 * the source database is opened read-only so it is never mutated.
 */
export async function backupBeforeMigration(
  dbPath: string,
  opts: BackupBeforeMigrationOptions = {},
): Promise<string> {
  const resolvedSource = path.resolve(dbPath);
  if (!existsSync(resolvedSource)) {
    throw new Error(`cannot back up missing database: ${resolvedSource}`);
  }

  const stamp = utcStamp(opts.timestamp ?? new Date());
  const directory = opts.directory ? path.resolve(opts.directory) : path.dirname(resolvedSource);
  mkdirSync(directory, { recursive: true });
  const backupPath = path.join(directory, `${path.basename(resolvedSource)}.${stamp}.bak`);

  // The backup API refuses to overwrite in some builds; clear a stale target.
  if (existsSync(backupPath)) {
    rmSync(backupPath, { force: true });
  }

  const source = new Database(resolvedSource, { readonly: true, fileMustExist: true });
  try {
    await source.backup(backupPath);
  } finally {
    source.close();
  }

  return backupPath;
}
