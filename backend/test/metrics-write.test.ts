/**
 * Tests for the metrics write / summary / prune side
 * (`backend/src/storage/metrics-write.ts`), against a fresh full-schema DB.
 *
 * These cover the acceptance criteria for P1 Task 7: check-history trimming to
 * `keep=60`, daily-summary upsert/merge, backfill idempotency, retention prune,
 * and the newest-100 host-metrics prune with chunked deletion.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupStorageTests, freshDb } from './storage-helpers';
import {
  appendHostCheckHistory,
  backfillDailySummary,
  getAllHostCheckHistory,
  getHostCheckHistory,
  mergeDailySummary,
  pruneDailySummary,
  pruneHostMetrics,
} from '../src/storage/metrics-write';

afterEach(cleanupStorageTests);

function countCheckRows(db: ReturnType<typeof freshDb>['db'], hostName: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM host_check_history WHERE host_name = ?')
    .get(hostName) as { n: number };
  return row.n;
}

function countPerCheck(db: ReturnType<typeof freshDb>['db'], hostName: string): Record<string, number> {
  const rows = db
    .prepare(
      'SELECT check_name, COUNT(*) AS n FROM host_check_history WHERE host_name = ? GROUP BY check_name',
    )
    .all(hostName) as Array<{ check_name: string; n: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) {
    out[row.check_name] = row.n;
  }
  return out;
}

/** Inserts a raw `host_metrics_history` row with the given timestamp/id ordering. */
function insertRawMetric(
  db: ReturnType<typeof freshDb>['db'],
  opts: {
    hostName?: string;
    collectedAt?: string;
    success?: number;
    cpu?: number | null;
    memUsed?: number | null;
    memTotal?: number | null;
    disk?: number | null;
    gpuUtil?: number | null;
    gpuMemUsed?: number | null;
    gpuMemTotal?: number | null;
    load?: number | null;
    users?: number | null;
    processes?: number | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO host_metrics_history
       (collected_at, host_name, host, success, cpu_usage_percent,
        memory_used_mb, memory_total_mb, disk_used_percent,
        gpu_utilization_percent, gpu_memory_used_mb, gpu_memory_total_mb,
        total_processes, logged_in_user_count, load_1)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.collectedAt ?? '2026-01-02T00:00:00.000000+00:00',
    opts.hostName ?? 'h1',
    '10.0.0.1',
    opts.success ?? 1,
    opts.cpu ?? null,
    opts.memUsed ?? null,
    opts.memTotal ?? null,
    opts.disk ?? null,
    opts.gpuUtil ?? null,
    opts.gpuMemUsed ?? null,
    opts.gpuMemTotal ?? null,
    opts.processes ?? null,
    opts.users ?? null,
    opts.load ?? null,
  );
}

describe('appendHostCheckHistory', () => {
  it('trims a single check to the newest 60 rows after more than 60 heartbeats', () => {
    const { db } = freshDb();
    for (let i = 0; i < 61; i += 1) {
      appendHostCheckHistory(db, 'h1', [
        { name: 'ping', status: i === 60 ? 'fail' : 'ok', latencyMs: i },
      ]);
    }
    expect(countCheckRows(db, 'h1')).toBe(60);
    const newest = db
      .prepare('SELECT status FROM host_check_history WHERE host_name = ? ORDER BY id DESC LIMIT 1')
      .get('h1') as { status: string };
    expect(newest.status).toBe('fail');
  });

  it('keeps 60 rows per check for multi-check heartbeats', () => {
    const { db } = freshDb();
    for (let i = 0; i < 61; i += 1) {
      appendHostCheckHistory(db, 'h1', [
        { name: 'ping', status: 'ok' },
        { name: 'http', status: 'ok' },
      ]);
    }
    expect(countCheckRows(db, 'h1')).toBe(120);
    expect(countPerCheck(db, 'h1')).toEqual({ ping: 60, http: 60 });
  });

  it('does nothing for an empty result list', () => {
    const { db } = freshDb();
    appendHostCheckHistory(db, 'h1', []);
    expect(countCheckRows(db, 'h1')).toBe(0);
  });

  it('accepts snake_case latency/checked_at fields', () => {
    const { db } = freshDb();
    appendHostCheckHistory(db, 'h1', [
      { name: 'ping', status: 'ok', latency_ms: 12.5, checked_at: '2026-01-02T03:04:05.000000+00:00' },
    ]);
    const row = db
      .prepare('SELECT latency_ms, checked_at FROM host_check_history WHERE host_name = ?')
      .get('h1') as { latency_ms: number; checked_at: string };
    expect(row.latency_ms).toBe(12.5);
    expect(row.checked_at).toBe('2026-01-02T03:04:05.000000+00:00');
  });
});

describe('getHostCheckHistory / getAllHostCheckHistory', () => {
  it('returns statuses oldest→newest grouped by check name', () => {
    const { db } = freshDb();
    appendHostCheckHistory(db, 'h1', [
      { name: 'ping', status: 'ok' },
      { name: 'ping', status: 'fail' },
      { name: 'ping', status: 'ok' },
      { name: 'http', status: 'fail' },
    ]);
    expect(getHostCheckHistory(db, 'h1')).toEqual({ ping: ['ok', 'fail', 'ok'], http: ['fail'] });
  });

  it('honours limit per check name', () => {
    const { db } = freshDb();
    for (let i = 0; i < 5; i += 1) {
      appendHostCheckHistory(db, 'h1', [{ name: 'ping', status: i % 2 === 0 ? 'ok' : 'fail' }]);
    }
    expect(getHostCheckHistory(db, 'h1', { limit: 2 })).toEqual({ ping: ['fail', 'ok'] });
  });

  it('groups every host in one call', () => {
    const { db } = freshDb();
    appendHostCheckHistory(db, 'h1', [{ name: 'ping', status: 'ok' }]);
    appendHostCheckHistory(db, 'h2', [{ name: 'ping', status: 'fail' }]);
    expect(getAllHostCheckHistory(db)).toEqual({
      h1: { ping: ['ok'] },
      h2: { ping: ['fail'] },
    });
  });
});

describe('mergeDailySummary', () => {
  it('inserts then merges a second sample (sums, max, cpu min)', () => {
    const { db } = freshDb();
    mergeDailySummary(db, {
      day: '2026-01-02',
      hostName: 'h1',
      host: '10.0.0.1',
      values: {
        cpu: 10,
        memory_pct: 25,
        disk_pct: 40,
        gpu_util: 5,
        gpu_memory_pct: 10,
        load: 1,
        users: 2,
        processes: 100,
      },
      updatedAt: '2026-01-02T01:00:00.000000+00:00',
    });
    mergeDailySummary(db, {
      day: '2026-01-02',
      hostName: 'h1',
      host: '10.0.0.1',
      values: {
        cpu: 30,
        memory_pct: 50,
        disk_pct: 60,
        gpu_util: 15,
        gpu_memory_pct: 20,
        load: 3,
        users: 4,
        processes: 200,
      },
      updatedAt: '2026-01-02T02:00:00.000000+00:00',
    });

    const row = db
      .prepare('SELECT * FROM host_daily_summary WHERE day = ? AND host_name = ? AND tz = ?')
      .get('2026-01-02', 'h1', 'UTC') as Record<string, number | null | string>;

    expect(row.sample_count).toBe(2);
    expect(row.success_count).toBe(2);
    expect(row.cpu_sum).toBe(40);
    expect(row.cpu_max).toBe(30);
    expect(row.cpu_min).toBe(10);
    expect(row.memory_pct_sum).toBe(75);
    expect(row.memory_pct_max).toBe(50);
    expect(row.disk_pct_sum).toBe(100);
    expect(row.disk_pct_max).toBe(60);
    expect(row.gpu_util_sum).toBe(20);
    expect(row.gpu_util_max).toBe(15);
    expect(row.load_sum).toBe(4);
    expect(row.users_sum).toBe(6);
    expect(row.processes_sum).toBe(300);
    expect(row.updated_at).toBe('2026-01-02T02:00:00.000000+00:00');
  });

  it('increments counts while ignoring missing (null) values', () => {
    const { db } = freshDb();
    mergeDailySummary(db, {
      day: '2026-01-03',
      hostName: 'h1',
      host: '10.0.0.1',
      values: { cpu: 20 },
    });
    mergeDailySummary(db, {
      day: '2026-01-03',
      hostName: 'h1',
      host: '10.0.0.1',
      values: { cpu: null, memory_pct: null, disk_pct: 55 },
    });
    const row = db
      .prepare('SELECT * FROM host_daily_summary WHERE day = ? AND host_name = ?')
      .get('2026-01-03', 'h1') as Record<string, number | null>;
    expect(row.sample_count).toBe(2);
    expect(row.success_count).toBe(2);
    expect(row.cpu_sum).toBe(20);
    expect(row.cpu_min).toBe(20);
    expect(row.cpu_max).toBe(20);
    expect(row.memory_pct_sum).toBeNull();
    expect(row.disk_pct_sum).toBe(55);
  });
});

describe('backfillDailySummary', () => {
  it('builds summary rows from success=1 raw history and is idempotent', () => {
    const { db } = freshDb();
    insertRawMetric(db, {
      collectedAt: '2026-01-02T01:00:00.000000+00:00',
      cpu: 10,
      memUsed: 100,
      memTotal: 400,
      disk: 40,
      gpuUtil: 5,
      gpuMemUsed: 100,
      gpuMemTotal: 1000,
      load: 1,
      users: 2,
      processes: 100,
    });
    insertRawMetric(db, {
      collectedAt: '2026-01-02T02:00:00.000000+00:00',
      cpu: 30,
      memUsed: 200,
      memTotal: 400,
      disk: 60,
      gpuUtil: 15,
      gpuMemUsed: 200,
      gpuMemTotal: 1000,
      load: 3,
      users: 4,
      processes: 200,
    });
    // A failed sample must be excluded.
    insertRawMetric(db, {
      collectedAt: '2026-01-02T03:00:00.000000+00:00',
      success: 0,
      cpu: 999,
    });

    expect(backfillDailySummary(db)).toBe(1);
    const row = db
      .prepare('SELECT * FROM host_daily_summary WHERE day = ? AND host_name = ? AND tz = ?')
      .get('2026-01-02', 'h1', 'UTC') as Record<string, number | null>;
    expect(row.sample_count).toBe(2);
    expect(row.success_count).toBe(2);
    expect(row.cpu_sum).toBe(40);
    expect(row.cpu_max).toBe(30);
    expect(row.cpu_min).toBe(10);
    expect(row.memory_pct_sum).toBe(75);
    expect(row.memory_pct_max).toBe(50);
    expect(row.disk_pct_sum).toBe(100);
    expect(row.gpu_util_sum).toBe(20);
    expect(row.gpu_memory_pct_sum).toBe(30);
    expect(row.load_sum).toBe(4);

    // Second run inserts nothing (existing rows are left untouched).
    expect(backfillDailySummary(db)).toBe(0);
    const after = db
      .prepare('SELECT sample_count FROM host_daily_summary WHERE day = ? AND host_name = ?')
      .get('2026-01-02', 'h1') as { sample_count: number };
    expect(after.sample_count).toBe(2);
  });
});

describe('pruneDailySummary', () => {
  it('removes rows older than the retention window', () => {
    const { db } = freshDb();
    const insert = db.prepare(
      `INSERT INTO host_daily_summary
         (day, host_name, tz, host, sample_count, success_count, updated_at)
       VALUES (?, ?, 'UTC', '10.0.0.1', 1, 1, ?)`,
    );
    insert.run('2026-01-01', 'h1', '2026-01-01T00:00:00.000000+00:00');
    insert.run('2026-03-20', 'h1', '2026-03-20T00:00:00.000000+00:00');
    insert.run('2026-04-10', 'h1', '2026-04-10T00:00:00.000000+00:00');

    // now = 2026-04-20, retention 90 days -> cutoff 2026-01-20.
    const deleted = pruneDailySummary(db, 90, { now: new Date('2026-04-20T00:00:00Z') });
    expect(deleted).toBe(1);
    const days = (
      db.prepare('SELECT day FROM host_daily_summary ORDER BY day').all() as Array<{ day: string }>
    ).map((row) => row.day);
    expect(days).toEqual(['2026-03-20', '2026-04-10']);
  });
});

describe('pruneHostMetrics', () => {
  it('keeps the newest 100 rows per host', () => {
    const { db } = freshDb();
    for (let i = 0; i < 150; i += 1) {
      insertRawMetric(db, { hostName: 'h1', collectedAt: '2026-01-02T00:00:00.000000+00:00', cpu: i });
    }
    for (let i = 0; i < 120; i += 1) {
      insertRawMetric(db, { hostName: 'h2', collectedAt: '2026-01-02T00:00:00.000000+00:00', cpu: i });
    }

    const deleted = pruneHostMetrics(db, 100);
    expect(deleted).toBe(70); // 50 from h1 + 20 from h2

    for (const host of ['h1', 'h2']) {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM host_metrics_history WHERE host_name = ?')
        .get(host) as { n: number };
      expect(row.n).toBe(100);
    }
    // The newest row (max id) per host must survive.
    const newest = db
      .prepare('SELECT cpu_usage_percent FROM host_metrics_history WHERE host_name = ? ORDER BY id DESC LIMIT 1')
      .get('h1') as { cpu_usage_percent: number };
    expect(newest.cpu_usage_percent).toBe(149);
  });

  it('deletes in chunks of 500 when a host has far more than maxPoints', () => {
    const { db } = freshDb();
    for (let i = 0; i < 1200; i += 1) {
      insertRawMetric(db, { hostName: 'h1', collectedAt: '2026-01-02T00:00:00.000000+00:00', cpu: i });
    }
    const deleted = pruneHostMetrics(db, 100);
    expect(deleted).toBe(1100);
    const row = db
      .prepare('SELECT COUNT(*) AS n, MIN(id) AS minId, MAX(id) AS maxId FROM host_metrics_history WHERE host_name = ?')
      .get('h1') as { n: number; minId: number; maxId: number };
    expect(row.n).toBe(100);
    expect(row.maxId).toBe(1200);
    expect(row.minId).toBe(1101);
  });

  it('is a no-op when a host has at most maxPoints rows', () => {
    const { db } = freshDb();
    for (let i = 0; i < 100; i += 1) {
      insertRawMetric(db, { hostName: 'h1', cpu: i });
    }
    expect(pruneHostMetrics(db, 100)).toBe(0);
  });
});
