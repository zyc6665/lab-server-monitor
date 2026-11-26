/**
 * Tests for `backend/src/storage/runtime.ts`.
 *
 * Covers the acceptance criteria from Task 11 of the P1 storage plan:
 * backup -> validate -> restore round-trip, rejecting a non-SQLite/garbage
 * file, the integrity-check TTL cache, the SSH session lifecycle and the
 * retention pruners.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { openDatabase } from '../src/storage/db';
import { nowIsoUtc } from '../src/storage/time';
import {
  backupDatabase,
  databaseIntegrity,
  listSshSessions,
  pruneRetention,
  pruneSshAudit,
  recordSshSessionEnd,
  recordSshSessionStart,
  restoreDatabase,
  systemStats,
  validateBackupDatabase,
} from '../src/storage/runtime';
import { cleanupStorageTests, freshDb } from './storage-helpers';

afterEach(() => {
  vi.useRealTimers();
  cleanupStorageTests();
});

describe('backup / restore / validate', () => {
  it('backs up, validates and restores a database round-trip', async () => {
    const { db, dbPath } = freshDb();
    db.prepare('INSERT INTO app_settings (section, payload, updated_at) VALUES (?, ?, ?)').run(
      'general',
      '{"theme":"dark"}',
      nowIsoUtc(),
    );

    const backupPath = path.join(path.dirname(dbPath), 'nested', 'backup.db');
    await backupDatabase(db, backupPath);

    expect(existsSync(backupPath)).toBe(true);
    expect(() => validateBackupDatabase(backupPath)).not.toThrow();

    // Change the live database after the backup so a successful restore is
    // observable.
    db.prepare('DELETE FROM app_settings').run();
    expect(db.prepare('SELECT COUNT(*) FROM app_settings').pluck().get()).toBe(0);
    db.close();

    await restoreDatabase(backupPath, dbPath);

    const reopened = openDatabase(dbPath);
    try {
      expect(
        reopened.prepare('SELECT payload FROM app_settings WHERE section = ?').pluck().get('general'),
      ).toBe('{"theme":"dark"}');
    } finally {
      reopened.close();
    }
  });

  it('creates the destination directory for a backup', async () => {
    const { db, dbPath } = freshDb();
    const backupPath = path.join(path.dirname(dbPath), 'a', 'b', 'c.db');
    await backupDatabase(db, backupPath);
    expect(existsSync(backupPath)).toBe(true);
  });

  it('rejects a non-SQLite (garbage) file', () => {
    const { dbPath } = freshDb();
    const garbage = path.join(path.dirname(dbPath), 'garbage.db');
    writeFileSync(garbage, Buffer.from('this is definitely not sqlite, not even close', 'utf8'));
    expect(() => validateBackupDatabase(garbage)).toThrow('不是有效的 SQLite 数据库文件');
  });

  it('rejects a missing file', () => {
    const { dbPath } = freshDb();
    expect(() => validateBackupDatabase(path.join(path.dirname(dbPath), 'missing.db'))).toThrow(
      '无法读取备份文件',
    );
  });

  it('rejects a valid SQLite file that is not this app', () => {
    const { dbPath } = freshDb();
    const otherPath = path.join(path.dirname(dbPath), 'other.db');
    const other = openDatabase(otherPath);
    try {
      other.exec('CREATE TABLE foo (x TEXT)');
    } finally {
      other.close();
    }
    expect(() => validateBackupDatabase(otherPath)).toThrow('备份文件不是本工具的数据库');
  });
});

describe('databaseIntegrity', () => {
  it('reports ok for a healthy database', () => {
    const { db } = freshDb();
    expect(databaseIntegrity(db)).toEqual([true, '完整性检查通过']);
  });

  it('reuses the result within the TTL and re-runs after it expires', () => {
    const { db } = freshDb();
    const original = db.pragma.bind(db);
    let calls = 0;
    (db as unknown as { pragma: typeof db.pragma }).pragma = ((...args: Parameters<typeof db.pragma>) => {
      calls += 1;
      return original(...args);
    }) as typeof db.pragma;

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T00:00:00.000Z'));

    expect(databaseIntegrity(db, 60_000)).toEqual([true, '完整性检查通过']);
    expect(databaseIntegrity(db, 60_000)).toEqual([true, '完整性检查通过']);
    expect(calls).toBe(1);

    vi.setSystemTime(new Date('2026-11-25T00:01:01.000Z'));
    expect(databaseIntegrity(db, 60_000)).toEqual([true, '完整性检查通过']);
    expect(calls).toBe(2);

    // ttl 0 disables the cache entirely.
    expect(databaseIntegrity(db)).toEqual([true, '完整性检查通过']);
    expect(calls).toBe(3);
  });
});

describe('systemStats', () => {
  it('reports the path, size and row counts', () => {
    const { db, dbPath } = freshDb();
    db.prepare(
      'INSERT INTO alerts (created_at, host_name, category, severity, title, message, fingerprint, status)'
        + " VALUES (?, 'h1', 'cpu', 'warning', 't', 'm', 'f1', 'active')",
    ).run(nowIsoUtc());

    const stats = systemStats(db);
    expect(stats.db_path).toBe(dbPath);
    expect(stats.db_size_bytes).toBeGreaterThan(0);
    expect(stats.host_snapshots).toBe(0);
    expect(stats.history_rows).toBe(0);
    expect(stats.disk_batches).toBe(0);
    expect(stats.alerts_active).toBe(1);
  });
});

describe('ssh audit sessions', () => {
  it('records, lists and ends a session', () => {
    const { db } = freshDb();
    const startedAt = '2026-11-01T08:30:00.000000+00:00';
    const id = recordSshSessionStart(db, {
      hostName: 'gpu-01',
      username: 'admin',
      serverUsername: 'root',
      startedAt,
    });

    expect(typeof id).toBe('number');
    let rows = listSshSessions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      host_name: 'gpu-01',
      username: 'admin',
      server_username: 'root',
      remote_addr: '127.0.0.1',
      started_at: startedAt,
      ended_at: null,
      status: 'active',
      error: null,
    });

    const endedAt = '2026-11-01T09:00:00.000000+00:00';
    expect(recordSshSessionEnd(db, id, { endedAt })).toBe(true);

    rows = listSshSessions(db);
    expect(rows[0].status).toBe('closed');
    expect(rows[0].ended_at).toBe(endedAt);
    expect(rows[0].error).toBeNull();

    expect(recordSshSessionEnd(db, 9999)).toBe(false);
  });

  it('records an error status', () => {
    const { db } = freshDb();
    const id = recordSshSessionStart(db, { hostName: 'gpu-01', username: 'admin' });
    expect(recordSshSessionEnd(db, id, { status: 'error', error: 'connection reset' })).toBe(true);
    const row = listSshSessions(db)[0];
    expect(row.status).toBe('error');
    expect(row.error).toBe('connection reset');
    expect(row.ended_at).not.toBeNull();
  });

  it('lists newest first and honours the limit', () => {
    const { db } = freshDb();
    const first = recordSshSessionStart(db, {
      hostName: 'gpu-01',
      username: 'admin',
      startedAt: '2026-11-01T00:00:00.000000+00:00',
    });
    const second = recordSshSessionStart(db, {
      hostName: 'gpu-02',
      username: 'admin',
      startedAt: '2026-11-03T00:00:00.000000+00:00',
    });
    const third = recordSshSessionStart(db, {
      hostName: 'gpu-03',
      username: 'admin',
      startedAt: '2026-11-02T00:00:00.000000+00:00',
    });

    expect(listSshSessions(db).map((row) => row.id)).toEqual([second, third, first]);
    expect(listSshSessions(db, 2).map((row) => row.id)).toEqual([second, third]);
  });

  it('defaults serverUsername to null and remoteAddr to loopback', () => {
    const { db } = freshDb();
    recordSshSessionStart(db, { hostName: 'gpu-02', username: 'admin' });
    const row = listSshSessions(db)[0];
    expect(row.server_username).toBeNull();
    expect(row.remote_addr).toBe('127.0.0.1');
  });
});

describe('pruning', () => {
  const now = new Date('2026-11-08T00:00:00.000Z');

  function insertSshRow(
    db: ReturnType<typeof freshDb>['db'],
    startedAt: string,
    endedAt: string | null,
  ): void {
    db.prepare(
      'INSERT INTO ssh_audit_sessions'
        + ' (host_name, username, server_username, remote_addr, started_at, ended_at, status)'
        + " VALUES ('a', 'admin', 'u', '127.0.0.1', ?, ?, ?)",
    ).run(startedAt, endedAt, endedAt === null ? 'active' : 'closed');
  }

  it('pruneSshAudit deletes only old ended sessions', () => {
    const { db } = freshDb();
    const old = '2026-09-29T00:00:00.000000+00:00';
    const recent = '2026-11-06T00:00:00.000000+00:00';
    insertSshRow(db, old, old); // old + ended -> pruned
    insertSshRow(db, old, null); // old + active -> kept
    insertSshRow(db, recent, recent); // recent -> kept

    expect(pruneSshAudit(db, 30, { now })).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM ssh_audit_sessions').pluck().get()).toBe(2);
    const remaining = db.prepare('SELECT status FROM ssh_audit_sessions ORDER BY status').all() as Array<{
      status: string;
    }>;
    expect(remaining.map((row) => row.status)).toEqual(['active', 'closed']);
  });

  it('pruneRetention applies the full matrix and returns all counts', () => {
    const { db } = freshDb();
    const old = '2026-09-29T00:00:00.000000+00:00';
    insertSshRow(db, old, old);
    insertSshRow(db, old, null);
    db.prepare(
      'INSERT INTO alerts (created_at, host_name, category, severity, title, message, fingerprint, status)'
        + " VALUES (?, 'h1', 'cpu', 'warning', 't', 'm', 'fa', 'resolved')",
    ).run(old);
    db.prepare(
      'INSERT INTO alerts (created_at, host_name, category, severity, title, message, fingerprint, status)'
        + " VALUES (?, 'h1', 'cpu', 'warning', 't', 'm', 'fb', 'active')",
    ).run(old);

    const counts = pruneRetention(
      db,
      {
        app: {
          hostMetricsMaxPoints: 100,
          diskHealthRetentionDays: 7,
          diskHealthMaxBatches: 100,
          hostDailySummaryRetentionDays: 90,
          alertHistoryRetentionDays: 30,
          sshAuditRetentionDays: 30,
        },
      },
      { now },
    );

    expect(counts).toMatchObject({
      host_metrics_history: 0,
      disk_health_snapshot: 0,
      disk_controller_snapshot: 0,
      disk_vd_snapshot: 0,
      disk_pd_snapshot: 0,
      host_daily_summary: 0,
      alerts: 1,
      ssh_audit_sessions: 1,
      alert_silences: 0,
    });
  });

  it('pruneRetention accepts a flat config and default fallbacks', () => {
    const { db } = freshDb();
    const counts = pruneRetention(db, {}, { now });
    expect(counts.host_metrics_history).toBe(0);
    expect(counts.ssh_audit_sessions).toBe(0);
  });
});

describe('validateBackupDatabase on a directory', () => {
  it('rejects a directory path', () => {
    const { dbPath } = freshDb();
    const dir = path.join(path.dirname(dbPath), 'subdir');
    mkdirSync(dir, { recursive: true });
    expect(() => validateBackupDatabase(dir)).toThrow('无法读取备份文件');
  });
});
