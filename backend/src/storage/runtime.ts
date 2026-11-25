/**
 * Retention, maintenance, backup/restore and integrity helpers.
 *
 * Ports the Python oracle `servermanage/storage/runtime.py` (backup / restore /
 * integrity / system stats / retention) plus the SSH audit session functions
 * that live in `servermanage/storage/base.py` (`record_ssh_session_start:1083`,
 * `record_ssh_session_end:1058`, `list_ssh_sessions:882`, and the
 * `ssh_audit_sessions` half of `purge_old_data:1011`).
 *
 * Python -> Node map:
 *
 * - `backup_database`        (`runtime.py:40`)  -> {@link backupDatabase}
 * - `restore_database`       (`runtime.py:149`) -> {@link restoreDatabase}
 * - `validate_backup_database` (`runtime.py:194`) -> {@link validateBackupDatabase}
 * - `database_integrity`     (`runtime.py:56`)  -> {@link databaseIntegrity}
 * - `system_stats`           (`runtime.py:162`) -> {@link systemStats}
 * - `prune_retention`        (`runtime.py:101`) -> {@link pruneRetention}
 * - `prune_ssh_audit`        (`runtime.py:129`) -> {@link pruneSshAudit}
 * - `record_ssh_session_start` / `record_ssh_session_end` / `list_ssh_sessions`
 *   (`base.py:1083/1058/882`) -> {@link recordSshSessionStart} /
 *   {@link recordSshSessionEnd} / {@link listSshSessions}
 *
 * Everything that takes a file path in Python takes an already-open
 * `better-sqlite3` handle here (the whole backend runs in one process against
 * one file; see `./db`), except the backup/restore/validate helpers which
 * legitimately operate on a second file.
 */
import { existsSync, mkdirSync, openSync, closeSync, readSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { openDatabase } from './db';
import { initSchema } from './schema';
import { nowIsoUtc } from './time';
import { pruneDiskHealth } from './disk';
import { pruneHostMetrics, pruneDailySummary } from './metrics-write';
import { pruneAlertHistory, pruneAlertSilences } from './alerts';

type SqliteDatabase = import('better-sqlite3').Database;

/** The 16-byte magic every SQLite database file starts with. */
const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'latin1');

/** Python's `ValueError` messages, kept byte-for-byte so UI error text matches. */
const ERR_UNREADABLE = '无法读取备份文件';
const ERR_NOT_SQLITE = '不是有效的 SQLite 数据库文件';
const ERR_UNOPENABLE = '无法打开数据库文件';
const ERR_INTEGRITY = '数据库完整性检查失败';
const ERR_NOT_OURS = '备份文件不是本工具的数据库';

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** `_time.monotonic()` stand-in for the integrity cache TTL. */
function monotonicMs(): number {
  return Date.now();
}

/**
 * True when `db`'s backing file exists (or is anonymous like `:memory:`).
 * Mirrors the `Path.exists()` guards in the Python oracle.
 */
function databaseFileExists(db: SqliteDatabase): boolean {
  const name = db.name;
  if (!name || name === ':memory:') {
    return true;
  }
  return existsSync(name);
}

/** Normalise an optional `now` (Date | ISO string | null) to a `Date`. */
function resolveNowDate(now: Date | string | null | undefined): Date {
  if (now === undefined || now === null) {
    return new Date();
  }
  return now instanceof Date ? now : new Date(now);
}

/** Render the exception message the way Python's `{exc}` does. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------

/**
 * Create a transactionally consistent copy of the open database at
 * `destination`. Mirrors `backup_database` (`runtime.py:40`): the destination
 * directory is created and any stale destination file is removed first.
 *
 * Uses better-sqlite3's online backup API (`db.backup`), which yields a single
 * consolidated file even when the source is in WAL mode.
 */
export async function backupDatabase(
  db: SqliteDatabase,
  destination: string,
): Promise<void> {
  const dest = path.resolve(destination);
  mkdirSync(path.dirname(dest), { recursive: true });
  if (existsSync(dest)) {
    rmSync(dest, { force: true });
  }
  await db.backup(dest);
}

/**
 * Replace `destination` with the contents of the SQLite file at `source`.
 * Mirrors `restore_database` (`runtime.py:149`): the source is opened read-only
 * so it is never mutated, then copied over the destination via the backup API.
 */
export async function restoreDatabase(
  source: string,
  destination: string,
): Promise<void> {
  const dest = path.resolve(destination);
  mkdirSync(path.dirname(dest), { recursive: true });
  const sourceDb = openDatabase(source, { readonly: true });
  try {
    await sourceDb.backup(dest);
  } finally {
    sourceDb.close();
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that `filePath` is a healthy server-monitor SQLite database.
 *
 * Mirrors `validate_backup_database` (`runtime.py:194`):
 * 1. the first 16 bytes must equal `SQLite format 3\0`;
 * 2. `PRAGMA integrity_check` must return `ok`;
 * 3. the schema must contain both `app_settings` and `app_secrets`.
 *
 * Throws an `Error` with the same (Chinese) message as Python's `ValueError`.
 */
export function validateBackupDatabase(filePath: string): void {
  let header: Buffer;
  try {
    const fd = openSync(filePath, 'r');
    try {
      const raw = Buffer.alloc(16);
      const bytesRead = readSync(fd, raw, 0, raw.length, 0);
      header = raw.subarray(0, bytesRead);
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new Error(ERR_UNREADABLE);
  }
  if (!header.equals(SQLITE_HEADER)) {
    throw new Error(ERR_NOT_SQLITE);
  }

  let connection: SqliteDatabase;
  try {
    connection = openDatabase(filePath, { readonly: true });
  } catch {
    throw new Error(ERR_UNOPENABLE);
  }

  let check: unknown;
  let tables: Set<string>;
  try {
    check = connection.pragma('integrity_check', { simple: true });
    const rows = connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    tables = new Set(rows.map((row) => row.name));
  } catch {
    throw new Error(ERR_UNOPENABLE);
  } finally {
    connection.close();
  }

  if (check !== 'ok') {
    throw new Error(ERR_INTEGRITY);
  }
  if (!(tables.has('app_settings') && tables.has('app_secrets'))) {
    throw new Error(ERR_NOT_OURS);
  }
}

// ---------------------------------------------------------------------------
// Integrity check with TTL cache
// ---------------------------------------------------------------------------

interface IntegrityCacheEntry {
  at: number;
  result: IntegrityResult;
}

/** `(ok, message)` tuple, directly comparable to the Python return value. */
export type IntegrityResult = [ok: boolean, message: string];

/** Process-wide cache keyed by resolved database path (`_INTEGRITY_CACHE`). */
const INTEGRITY_CACHE = new Map<string, IntegrityCacheEntry>();
const INTEGRITY_CACHE_LIMIT = 8;

/**
 * Run SQLite's cheap `PRAGMA quick_check` and return `(ok, message)`.
 *
 * Mirrors `database_integrity` (`runtime.py:56`). `quick_check` still scans the
 * whole file, so dashboard polling passes `ttlMs > 0` to reuse the previous
 * result for that long. The cache key is the file path only (mtime changes on
 * almost every collector write, so it was useless as a key). At most eight
 * paths are kept, oldest evicted first.
 */
export function databaseIntegrity(db: SqliteDatabase, ttlMs = 0): IntegrityResult {
  if (!databaseFileExists(db)) {
    return [false, '数据库文件不存在'];
  }

  let cacheKey: string | null = null;
  try {
    cacheKey = path.resolve(db.name);
  } catch {
    cacheKey = null;
  }

  if (cacheKey !== null && ttlMs > 0) {
    const cached = INTEGRITY_CACHE.get(cacheKey);
    if (cached !== undefined && monotonicMs() - cached.at < ttlMs) {
      return cached.result;
    }
  }

  let problems: string[];
  try {
    const rows = db.pragma('quick_check') as Array<Record<string, unknown>>;
    problems = rows
      .map((row) => String(Object.values(row)[0]))
      .filter((value) => value.toLowerCase() !== 'ok');
  } catch (err) {
    return [false, `数据库无法读取：${errorMessage(err)}`];
  }

  const result: IntegrityResult =
    problems.length > 0
      ? [false, '完整性检查发现问题：' + problems.slice(0, 3).join('；')]
      : [true, '完整性检查通过'];

  if (cacheKey !== null) {
    INTEGRITY_CACHE.set(cacheKey, { at: monotonicMs(), result });
    if (INTEGRITY_CACHE.size > INTEGRITY_CACHE_LIMIT) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [key, entry] of INTEGRITY_CACHE) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = key;
        }
      }
      if (oldestKey !== null) {
        INTEGRITY_CACHE.delete(oldestKey);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// System stats
// ---------------------------------------------------------------------------

/** Row counts shown in the system-health panel (Python `system_stats`). */
export interface SystemStats {
  db_path: string;
  db_size_bytes: number;
  host_snapshots: number;
  history_rows: number;
  disk_batches: number;
  alerts_active: number;
}

/** Counts rows of `table`, treating a missing table as 0. */
function countRows(db: SqliteDatabase, sql: string): number {
  return Number(db.prepare(sql).pluck().get());
}

/**
 * Small read-only aggregate used by the system-health panel.
 * Mirrors `system_stats` (`runtime.py:162`). Missing tables (fresh/legacy DB)
 * leave the corresponding counters at `0`, exactly like the Python `try/except`.
 *
 * `dbPath` defaults to the handle's file name (`db.name`).
 */
export function systemStats(db: SqliteDatabase, dbPath?: string): SystemStats {
  const resolvedPath = dbPath ?? db.name;
  const stats: SystemStats = {
    db_path: resolvedPath,
    db_size_bytes: existsSync(resolvedPath) ? statSync(resolvedPath).size : 0,
    host_snapshots: 0,
    history_rows: 0,
    disk_batches: 0,
    alerts_active: 0,
  };
  if (!existsSync(resolvedPath)) {
    return stats;
  }
  try {
    stats.host_snapshots = countRows(db, 'SELECT COUNT(*) FROM host_latest_snapshot');
    stats.history_rows = countRows(db, 'SELECT COUNT(*) FROM host_metrics_history');
    stats.disk_batches = countRows(db, 'SELECT COUNT(*) FROM disk_health_snapshot');
    stats.alerts_active = countRows(db, "SELECT COUNT(*) FROM alerts WHERE status = 'active'");
  } catch {
    // Legacy/fresh database without one of the tables: keep the zeros. Python
    // wraps all four reads in a single `except OperationalError`, so a failure
    // on an earlier table also skips the later ones — same behaviour here.
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Options carrying a pinned reference instant (Python's keyword `now`). */
export interface PruneNowOptions {
  now?: Date | string | null;
}

/**
 * Delete only ended SSH audit rows older than `retentionDays`.
 * Mirrors `prune_ssh_audit` (`runtime.py:129`): active sessions
 * (`ended_at IS NULL`) are never pruned. Returns the deleted row count.
 */
export function pruneSshAudit(
  db: SqliteDatabase,
  retentionDays = 30,
  opts: PruneNowOptions = {},
): number {
  if (!databaseFileExists(db)) {
    return 0;
  }
  const days = Math.max(1, Math.trunc(retentionDays));
  const reference = resolveNowDate(opts.now);
  const cutoff = nowIsoUtc(new Date(reference.getTime() - days * 86_400_000));
  const info = db
    .prepare(
      'DELETE FROM ssh_audit_sessions'
        + ' WHERE ended_at IS NOT NULL AND started_at < ?',
    )
    .run(cutoff);
  return info.changes;
}

/**
 * Retention settings consumed by {@link pruneRetention}. Field names are the
 * camelCased Python config attributes; the defaults below are the values from
 * the plan's global constraints.
 */
export interface RetentionConfig {
  hostMetricsMaxPoints?: number;
  diskHealthRetentionDays?: number;
  diskHealthMaxBatches?: number;
  hostDailySummaryRetentionDays?: number;
  alertHistoryRetentionDays?: number;
  sshAuditRetentionDays?: number;
}

/** Per-key delete counts returned by {@link pruneRetention}. */
export type RetentionCounts = Record<string, number>;

/**
 * Apply the full v1.6 retention matrix and return per-key counts.
 * Mirrors `prune_retention` (`runtime.py:101`).
 *
 * `config` may be the app settings object directly or wrapped as `{ app }`
 * (Python's `config.app if hasattr(config, "app") else config`). Missing fields
 * fall back to the plan defaults: 100 / 7 / 100 / 90 / 30 / 30.
 */
export function pruneRetention(
  db: SqliteDatabase,
  config: RetentionConfig | { app?: RetentionConfig },
  opts: PruneNowOptions = {},
): RetentionCounts {
  const app =
    (config as { app?: RetentionConfig }).app ?? (config as RetentionConfig);
  const now = resolveNowDate(opts.now);

  const counts: RetentionCounts = {};
  counts.host_metrics_history = pruneHostMetrics(db, app.hostMetricsMaxPoints ?? 100);
  // `prune_disk_health` contributes its four per-table counts via `update()`.
  Object.assign(
    counts,
    pruneDiskHealth(
      db,
      app.diskHealthRetentionDays ?? 7,
      app.diskHealthMaxBatches ?? 100,
      now,
    ),
  );
  counts.host_daily_summary = pruneDailySummary(
    db,
    app.hostDailySummaryRetentionDays ?? 90,
    { now },
  );
  counts.alerts = pruneAlertHistory(db, app.alertHistoryRetentionDays ?? 30, {
    now,
  });
  counts.ssh_audit_sessions = pruneSshAudit(db, app.sshAuditRetentionDays ?? 30, {
    now,
  });
  counts.alert_silences = pruneAlertSilences(db, { now });
  return counts;
}

// ---------------------------------------------------------------------------
// SSH audit sessions
// ---------------------------------------------------------------------------

/** One `ssh_audit_sessions` row (column names preserved, like Python Rows). */
export interface SshAuditSession {
  id: number;
  host_name: string;
  username: string;
  server_username: string | null;
  remote_addr: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  error: string | null;
}

/** Arguments for {@link recordSshSessionStart}. */
export interface RecordSshSessionStartInput {
  /** Dashboard host label. */
  hostName: string;
  /** Dashboard admin account. */
  username: string;
  /** SSH login account on the server. */
  serverUsername?: string | null;
  /** Caller address (always `127.0.0.1` in loopback-only desktop mode). */
  remoteAddr?: string;
  /** Override the start timestamp (tests / imports). Defaults to now (UTC). */
  startedAt?: string;
}

/**
 * Insert an `active` audit row and return its row id.
 * Mirrors `record_ssh_session_start` (`base.py:1083`). Only session metadata is
 * stored; terminal input/output is never recorded.
 */
export function recordSshSessionStart(
  db: SqliteDatabase,
  input: RecordSshSessionStartInput,
): number {
  initSchema(db);
  const started = input.startedAt ?? nowIsoUtc();
  const info = db
    .prepare(
      'INSERT INTO ssh_audit_sessions'
        + ' (host_name, username, server_username, remote_addr, started_at,'
        + " status) VALUES (?, ?, ?, ?, ?, 'active')",
    )
    .run(
      input.hostName,
      input.username,
      input.serverUsername ?? null,
      input.remoteAddr ?? '127.0.0.1',
      started,
    );
  return Number(info.lastInsertRowid);
}

/** Arguments for {@link recordSshSessionEnd}. */
export interface RecordSshSessionEndOptions {
  /** Final status; Python default is `closed`. */
  status?: string;
  /** Error text for failed sessions. */
  error?: string | null;
  /** Override the end timestamp. Defaults to now (UTC). */
  endedAt?: string;
}

/**
 * Finalise an audit row, returning `true` when the row was updated.
 * Mirrors `record_ssh_session_end` (`base.py:1058`).
 */
export function recordSshSessionEnd(
  db: SqliteDatabase,
  sessionId: number,
  opts: RecordSshSessionEndOptions = {},
): boolean {
  if (!databaseFileExists(db)) {
    return false;
  }
  const ended = opts.endedAt ?? nowIsoUtc();
  const info = db
    .prepare(
      'UPDATE ssh_audit_sessions'
        + ' SET status = ?, error = ?, ended_at = ?'
        + ' WHERE id = ?',
    )
    .run(opts.status ?? 'closed', opts.error ?? null, ended, sessionId);
  return info.changes > 0;
}

/**
 * Return audit rows ordered by `started_at` (newest first).
 * Mirrors `list_ssh_sessions` (`base.py:882`). A missing table yields `[]`.
 */
export function listSshSessions(
  db: SqliteDatabase,
  limit = 100,
): SshAuditSession[] {
  if (!databaseFileExists(db)) {
    return [];
  }
  try {
    return db
      .prepare(
        'SELECT id, host_name, username, server_username, remote_addr,'
          + ' started_at, ended_at, status, error'
          + ' FROM ssh_audit_sessions'
          + ' ORDER BY started_at DESC, id DESC'
          + ' LIMIT ?',
      )
      .all(limit) as SshAuditSession[];
  } catch {
    return [];
  }
}
