/**
 * Tests for `src/storage/metrics-read.ts`.
 *
 * Every test seeds a fresh, fully-initialised database (`freshDb`) with raw
 * `host_metrics_history` rows or compact `host_daily_summary` rows and then
 * checks the ported read query against hand-computed expectations, including
 * the `AVG`/`CASE`/`SUM` aggregation results, bucket boundaries and the explicit
 * ordering keys.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  countRecentSamples,
  countRecentSamplesByHost,
  fetchAllHostUptimeStrips,
  fetchDailyPointsForWeek,
  fetchHostHistory,
  fetchHostSparklines,
  fetchHostUptimeStrip,
  fetchOverviewHistory,
  fetchWeeklyMetrics,
} from '../src/storage/metrics-read';
import { cleanupStorageTests, freshDb, type TestDb } from './storage-helpers';

afterEach(cleanupStorageTests);

interface HistoryInput {
  collected_at: string;
  host_name?: string;
  host?: string;
  success?: number;
  cpu?: number | null;
  memory_used_mb?: number | null;
  memory_total_mb?: number | null;
  disk?: number | null;
  gpu_util?: number | null;
  gpu_used?: number | null;
  gpu_total?: number | null;
  processes?: number | null;
  users?: number | null;
  load1?: number | null;
  rx?: number | null;
  tx?: number | null;
  temp?: number | null;
}

function insertHistory(db: TestDb, input: HistoryInput): void {
  db.prepare(
    `INSERT INTO host_metrics_history (
        collected_at, host_name, host, success, cpu_usage_percent,
        memory_used_mb, memory_total_mb, disk_used_percent, gpu_utilization_percent,
        gpu_memory_used_mb, gpu_memory_total_mb, total_processes, logged_in_user_count,
        load_1, net_rx_bytes, net_tx_bytes, temperature_c
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.collected_at,
    input.host_name ?? 'h1',
    input.host ?? '10.0.0.1',
    input.success ?? 1,
    input.cpu ?? null,
    input.memory_used_mb ?? null,
    input.memory_total_mb ?? null,
    input.disk ?? null,
    input.gpu_util ?? null,
    input.gpu_used ?? null,
    input.gpu_total ?? null,
    input.processes ?? null,
    input.users ?? null,
    input.load1 ?? null,
    input.rx ?? null,
    input.tx ?? null,
    input.temp ?? null,
  );
}

interface SummaryInput {
  day: string;
  host_name?: string;
  host?: string;
  tz?: string;
  sample_count?: number;
  success_count?: number;
  cpu_sum?: number | null;
  cpu_max?: number | null;
  cpu_min?: number | null;
  memory_pct_sum?: number | null;
  memory_pct_max?: number | null;
  disk_pct_sum?: number | null;
  disk_pct_max?: number | null;
  gpu_util_sum?: number | null;
  gpu_util_max?: number | null;
  gpu_memory_pct_sum?: number | null;
  gpu_memory_pct_max?: number | null;
  load_sum?: number | null;
  users_sum?: number | null;
  processes_sum?: number | null;
}

function insertSummary(db: TestDb, input: SummaryInput): void {
  const sample = input.sample_count ?? 1;
  db.prepare(
    `INSERT INTO host_daily_summary (
        day, host_name, tz, host, sample_count, success_count,
        cpu_sum, cpu_max, cpu_min, memory_pct_sum, memory_pct_max,
        disk_pct_sum, disk_pct_max, gpu_util_sum, gpu_util_max,
        gpu_memory_pct_sum, gpu_memory_pct_max, load_sum, users_sum,
        processes_sum, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.day,
    input.host_name ?? 'h1',
    input.tz ?? 'UTC',
    input.host ?? '10.0.0.1',
    sample,
    input.success_count ?? sample,
    input.cpu_sum ?? null,
    input.cpu_max ?? null,
    input.cpu_min ?? null,
    input.memory_pct_sum ?? null,
    input.memory_pct_max ?? null,
    input.disk_pct_sum ?? null,
    input.disk_pct_max ?? null,
    input.gpu_util_sum ?? null,
    input.gpu_util_max ?? null,
    input.gpu_memory_pct_sum ?? null,
    input.gpu_memory_pct_max ?? null,
    input.load_sum ?? null,
    input.users_sum ?? null,
    input.processes_sum ?? null,
    '2026-01-15T00:00:00+00:00',
  );
}

// ---------------------------------------------------------------------------
// fetchHostHistory
// ---------------------------------------------------------------------------

describe('fetchHostHistory', () => {
  const now = new Date('2026-01-15T12:00:00.000Z');

  it('24h: returns raw points oldest→newest, computes derived percentages and net rates', () => {
    const { db } = freshDb();
    insertHistory(db, {
      collected_at: '2026-01-15T10:00:00.000000+00:00',
      cpu: 10,
      memory_used_mb: 100,
      memory_total_mb: 1000,
      disk: 20,
      gpu_util: 30,
      gpu_used: 1000,
      gpu_total: 4000,
      load1: 0.5,
      temp: 45,
      rx: 1000,
      tx: 2000,
    });
    insertHistory(db, {
      collected_at: '2026-01-15T10:10:00.000000+00:00',
      cpu: 20,
      memory_used_mb: 200,
      memory_total_mb: 1000,
      disk: 30,
      gpu_util: 40,
      gpu_used: 2000,
      gpu_total: 4000,
      load1: 0.5,
      temp: 46,
      rx: 2200,
      tx: 3200,
    });
    // success=0 must be ignored.
    insertHistory(db, { collected_at: '2026-01-15T10:05:00.000000+00:00', success: 0, cpu: 99 });
    // Older than the 24h cutoff (now-24h = 2026-01-14T12:00).
    insertHistory(db, { collected_at: '2026-01-14T11:00:00.000000+00:00', cpu: 1 });

    const points = fetchHostHistory(db, 'h1', { rangeKey: '24h', now });

    expect(points).toEqual([
      {
        t: '2026-01-15T10:00:00+00:00',
        cpu: 10,
        memory: 10,
        disk: 20,
        gpu_util: 30,
        gpu_memory: 25,
        temperature: 45,
        load_1: 0.5,
        net_rx: null,
        net_tx: null,
      },
      {
        t: '2026-01-15T10:10:00+00:00',
        cpu: 20,
        memory: 20,
        disk: 30,
        gpu_util: 40,
        gpu_memory: 50,
        temperature: 46,
        load_1: 0.5,
        net_rx: 2,
        net_tx: 2,
      },
    ]);
  });

  it('24h: a counter reset (negative delta) yields null rates', () => {
    const { db } = freshDb();
    insertHistory(db, { collected_at: '2026-01-15T10:00:00.000000+00:00', cpu: 1, rx: 5000, tx: 5000 });
    insertHistory(db, { collected_at: '2026-01-15T10:01:00.000000+00:00', cpu: 2, rx: 100, tx: 9000 });
    const points = fetchHostHistory(db, 'h1', { now });
    // The oracle only emits BOTH rates when both deltas are non-negative, so a
    // reset on rx suppresses the tx rate too.
    expect(points[1].net_rx).toBeNull();
    expect(points[1].net_tx).toBeNull();
  });

  it('preserves microsecond precision and formats in the requested timezone', () => {
    const { db } = freshDb();
    insertHistory(db, { collected_at: '2026-01-15T10:00:00.123456+00:00', cpu: 5 });
    const points = fetchHostHistory(db, 'h1', { tz: 'Asia/Shanghai', now });
    expect(points[0].t).toBe('2026-01-15T18:00:00.123456+08:00');
  });

  it('7d: reads the daily summary, divides sums by sample_count and orders by day ASC', () => {
    const { db } = freshDb();
    // Inserted out of order on purpose.
    insertSummary(db, {
      day: '2026-01-10',
      sample_count: 2,
      cpu_sum: 30,
      memory_pct_sum: 40,
      disk_pct_sum: 50,
      gpu_util_sum: 60,
      gpu_memory_pct_sum: 70,
      load_sum: 1,
    });
    insertSummary(db, {
      day: '2026-01-09',
      sample_count: 1,
      cpu_sum: 10,
      memory_pct_sum: 20,
      disk_pct_sum: 30,
      gpu_util_sum: 40,
      gpu_memory_pct_sum: 50,
      load_sum: 1,
    });
    // Zero sample_count -> skipped.
    insertSummary(db, { day: '2026-01-11', sample_count: 0, cpu_sum: 0 });
    // Before the 7d window (start = 2026-01-09).
    insertSummary(db, { day: '2026-01-08', sample_count: 1, cpu_sum: 99 });
    // Other timezone partition must not leak in.
    insertSummary(db, { day: '2026-01-10', tz: 'Asia/Shanghai', sample_count: 1, cpu_sum: 999 });

    const points = fetchHostHistory(db, 'h1', { rangeKey: '7d', now });

    expect(points.map((p) => p.t)).toEqual(['2026-01-09', '2026-01-10']);
    expect(points[0]).toEqual({
      t: '2026-01-09',
      cpu: 10,
      memory: 20,
      disk: 30,
      gpu_util: 40,
      gpu_memory: 50,
      temperature: null,
      load_1: 1,
      net_rx: null,
      net_tx: null,
    });
    expect(points[1]).toEqual({
      t: '2026-01-10',
      cpu: 15,
      memory: 20,
      disk: 25,
      gpu_util: 30,
      gpu_memory: 35,
      temperature: null,
      load_1: 0.5,
      net_rx: null,
      net_tx: null,
    });
  });

  it('rejects an unknown range key', () => {
    const { db } = freshDb();
    expect(() => fetchHostHistory(db, 'h1', { rangeKey: '1d' })).toThrow(
      'range_key must be 24h, 7d, 30d or 90d',
    );
  });
});

// ---------------------------------------------------------------------------
// fetchHostSparklines
// ---------------------------------------------------------------------------

describe('fetchHostSparklines', () => {
  const now = new Date('2026-01-15T12:00:00.000Z');

  it('groups per host, ignores failures, caps to the last N points and rounds to 1 decimal', () => {
    const { db } = freshDb();
    insertHistory(db, { collected_at: '2026-01-15T10:00:00.000000+00:00', cpu: 10, memory_used_mb: 100, memory_total_mb: 1000 });
    insertHistory(db, { collected_at: '2026-01-15T10:10:00.000000+00:00', cpu: 20, memory_used_mb: 200, memory_total_mb: 1000 });
    insertHistory(db, { collected_at: '2026-01-15T10:20:00.000000+00:00', cpu: 30, memory_used_mb: 300, memory_total_mb: 1000 });
    insertHistory(db, { collected_at: '2026-01-15T10:15:00.000000+00:00', cpu: 99, success: 0 });
    // Before the look-back window.
    insertHistory(db, { collected_at: '2026-01-14T11:00:00.000000+00:00', cpu: 77 });
    // Rounding host.
    insertHistory(db, { collected_at: '2026-01-15T10:05:00.000000+00:00', host_name: 'h3', cpu: 12.34, memory_used_mb: 333, memory_total_mb: 1000 });
    insertHistory(db, { collected_at: '2026-01-15T10:06:00.000000+00:00', host_name: 'h3', cpu: 56.78, memory_used_mb: 666, memory_total_mb: 1000 });

    const result = fetchHostSparklines(db, { points: 2, now });

    expect(result).toEqual({
      h1: { cpu: [20, 30], memory: [20, 30] },
      h3: { cpu: [12.3, 56.8], memory: [33.3, 66.6] },
    });
  });

  it('keeps at least two points even when points < 2 is requested', () => {
    const { db } = freshDb();
    insertHistory(db, { collected_at: '2026-01-15T10:00:00.000000+00:00', cpu: 1 });
    insertHistory(db, { collected_at: '2026-01-15T10:01:00.000000+00:00', cpu: 2 });
    insertHistory(db, { collected_at: '2026-01-15T10:02:00.000000+00:00', cpu: 3 });
    const result = fetchHostSparklines(db, { points: 1, now });
    expect(result.h1.cpu).toEqual([2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Uptime strips
// ---------------------------------------------------------------------------

describe('fetchHostUptimeStrip', () => {
  const now = new Date('2026-01-15T12:00:00.000Z');

  it('places samples into floor((moment - since)/bucket) slots and counts ok', () => {
    const { db } = freshDb();
    insertHistory(db, { collected_at: '2026-01-15T11:10:00.000000+00:00', success: 1 });
    insertHistory(db, { collected_at: '2026-01-15T11:20:00.000000+00:00', success: 1 });
    insertHistory(db, { collected_at: '2026-01-15T11:20:30.000000+00:00', success: 0 });
    insertHistory(db, { collected_at: '2026-01-15T11:59:00.000000+00:00', success: 1 });
    // Before the window.
    insertHistory(db, { collected_at: '2026-01-15T10:59:00.000000+00:00', success: 1 });
    // Index would be 6 (>= count 4) -> dropped.
    insertHistory(db, { collected_at: '2026-01-15T12:30:00.000000+00:00', success: 1 });

    const strip = fetchHostUptimeStrip(db, 'h1', { hours: 1, bucketMinutes: 15, now });

    expect(strip.hours).toBe(1);
    expect(strip.bucket_minutes).toBe(15);
    expect(strip.buckets.map((b) => b.start)).toEqual([
      '2026-01-15T11:00:00+00:00',
      '2026-01-15T11:15:00+00:00',
      '2026-01-15T11:30:00+00:00',
      '2026-01-15T11:45:00+00:00',
    ]);
    expect(strip.buckets.map((b) => [b.index, b.total, b.ok])).toEqual([
      [0, 1, 1],
      [1, 2, 1],
      [2, 0, 0],
      [3, 1, 1],
    ]);
    expect(strip.samples).toBe(4);
    expect(strip.ok).toBe(3);
  });

  it('returns an empty strip (no rows) with max(1, int(hours*60/bucket)) buckets', () => {
    const { db } = freshDb();
    const strip = fetchHostUptimeStrip(db, 'nohost', { hours: 1, bucketMinutes: 20, now });
    expect(strip.buckets).toHaveLength(3);
    expect(strip.samples).toBe(0);
    expect(strip.ok).toBe(0);
  });
});

describe('fetchAllHostUptimeStrips', () => {
  const now = new Date('2026-01-15T12:00:00.000Z');

  it('returns one strip per host with the same semantics, ordered by host_name', () => {
    const { db } = freshDb();
    insertHistory(db, { collected_at: '2026-01-15T11:10:00.000000+00:00', host_name: 'h1', success: 1 });
    insertHistory(db, { collected_at: '2026-01-15T11:20:00.000000+00:00', host_name: 'h1', success: 0 });
    insertHistory(db, { collected_at: '2026-01-15T11:50:00.000000+00:00', host_name: 'h2', success: 1 });

    const strips = fetchAllHostUptimeStrips(db, { hours: 1, bucketMinutes: 15, now });

    expect(Object.keys(strips)).toEqual(['h1', 'h2']);
    expect(strips.h1.samples).toBe(2);
    expect(strips.h1.ok).toBe(1);
    expect(strips.h1.buckets[0]).toEqual({ index: 0, start: '2026-01-15T11:00:00+00:00', total: 1, ok: 1 });
    expect(strips.h1.buckets[1]).toEqual({ index: 1, start: '2026-01-15T11:15:00+00:00', total: 1, ok: 0 });
    expect(strips.h2.samples).toBe(1);
    expect(strips.h2.ok).toBe(1);
    expect(strips.h2.buckets[3]).toEqual({ index: 3, start: '2026-01-15T11:45:00+00:00', total: 1, ok: 1 });
  });
});

// ---------------------------------------------------------------------------
// fetchOverviewHistory
// ---------------------------------------------------------------------------

describe('fetchOverviewHistory', () => {
  const now = new Date('2026-01-15T12:00:00.000Z');

  it('24h: AVG/CASE aggregate across hosts per collected_at, ordered ASC', () => {
    const { db } = freshDb();
    insertHistory(db, { collected_at: '2026-01-15T11:00:00.000000+00:00', host_name: 'h1', cpu: 10, memory_used_mb: 100, memory_total_mb: 1000, disk: 20, gpu_util: 30, gpu_used: 1000, gpu_total: 4000, load1: 1 });
    insertHistory(db, { collected_at: '2026-01-15T11:00:00.000000+00:00', host_name: 'h2', cpu: 20, memory_used_mb: 300, memory_total_mb: 1000, disk: 40, gpu_util: 50, gpu_used: 3000, gpu_total: 4000, load1: 3 });
    insertHistory(db, { collected_at: '2026-01-15T11:10:00.000000+00:00', host_name: 'h1', cpu: 30, memory_used_mb: 500, memory_total_mb: 1000, disk: 60, gpu_util: 70, gpu_used: 2000, gpu_total: 4000, load1: 5 });
    // success=0 ignored.
    insertHistory(db, { collected_at: '2026-01-15T11:05:00.000000+00:00', success: 0, cpu: 99 });
    // After the ceiling (now) ignored.
    insertHistory(db, { collected_at: '2026-01-15T12:30:00.000000+00:00', cpu: 99 });

    const points = fetchOverviewHistory(db, { rangeKey: '24h', now });

    expect(points).toEqual([
      { t: '2026-01-15T11:00:00+00:00', cpu: 15, memory: 20, disk: 30, gpu_util: 40, gpu_memory: 50, load_1: 2 },
      { t: '2026-01-15T11:10:00+00:00', cpu: 30, memory: 50, disk: 60, gpu_util: 70, gpu_memory: 50, load_1: 5 },
    ]);
  });

  it('24h: honours the host filter (no cross-host averaging)', () => {
    const { db } = freshDb();
    insertHistory(db, { collected_at: '2026-01-15T11:00:00.000000+00:00', host_name: 'h1', cpu: 10 });
    insertHistory(db, { collected_at: '2026-01-15T11:00:00.000000+00:00', host_name: 'h2', cpu: 20, memory_used_mb: 300, memory_total_mb: 1000 });
    const points = fetchOverviewHistory(db, { rangeKey: '24h', now, host: 'h2' });
    expect(points).toHaveLength(1);
    expect(points[0].cpu).toBe(20);
    expect(points[0].memory).toBe(30);
  });

  it('24h: offset_days shifts the window backwards', () => {
    const { db } = freshDb();
    insertHistory(db, { collected_at: '2026-01-15T11:00:00.000000+00:00', cpu: 10 });
    expect(fetchOverviewHistory(db, { rangeKey: '24h', now, offsetDays: 1 })).toEqual([]);
    expect(() => fetchOverviewHistory(db, { offsetDays: -1 })).toThrow('offset_days must be zero or positive');
  });

  it('7d: SUMs the daily summary per day and divides by the summed sample_count', () => {
    const { db } = freshDb();
    insertSummary(db, { day: '2026-01-10', host_name: 'h1', host: 'ip1', sample_count: 2, cpu_sum: 30, memory_pct_sum: 40, disk_pct_sum: 50, gpu_util_sum: 60, gpu_memory_pct_sum: 70, load_sum: 1 });
    insertSummary(db, { day: '2026-01-10', host_name: 'h2', host: 'ip2', sample_count: 3, cpu_sum: 60, memory_pct_sum: 60, disk_pct_sum: 90, gpu_util_sum: 60, gpu_memory_pct_sum: 80, load_sum: 2 });
    insertSummary(db, { day: '2026-01-09', host_name: 'h1', host: 'ip1', sample_count: 1, cpu_sum: 10, memory_pct_sum: 20, disk_pct_sum: 30, gpu_util_sum: 40, gpu_memory_pct_sum: 50, load_sum: 1 });
    // Out of range / other tz.
    insertSummary(db, { day: '2026-01-08', sample_count: 1, cpu_sum: 99 });
    insertSummary(db, { day: '2026-01-10', tz: 'Asia/Shanghai', sample_count: 1, cpu_sum: 999 });

    const points = fetchOverviewHistory(db, { rangeKey: '7d', now });

    expect(points.map((p) => p.t)).toEqual(['2026-01-09', '2026-01-10']);
    expect(points[0]).toEqual({ t: '2026-01-09', cpu: 10, memory: 20, disk: 30, gpu_util: 40, gpu_memory: 50, load_1: 1 });
    // Day 2026-01-10: cpu 90/5=18, memory 100/5=20, disk 140/5=28, gpu 120/5=24,
    // gpu_memory 150/5=30, load 3/5=0.6.
    expect(points[1]).toEqual({ t: '2026-01-10', cpu: 18, memory: 20, disk: 28, gpu_util: 24, gpu_memory: 30, load_1: 0.6 });
  });

  it('7d: host filter restricts the daily-summary aggregation', () => {
    const { db } = freshDb();
    insertSummary(db, { day: '2026-01-10', host_name: 'h1', sample_count: 2, cpu_sum: 30 });
    insertSummary(db, { day: '2026-01-10', host_name: 'h2', sample_count: 3, cpu_sum: 60 });
    const points = fetchOverviewHistory(db, { rangeKey: '7d', now, host: 'h1' });
    expect(points).toEqual([{ t: '2026-01-10', cpu: 15, memory: null, disk: null, gpu_util: null, gpu_memory: null, load_1: null }]);
  });
});

// ---------------------------------------------------------------------------
// fetchWeeklyMetrics
// ---------------------------------------------------------------------------

describe('fetchWeeklyMetrics', () => {
  it('summary branch: mean of daily means, raw extremes, summed counts, sorted by host_name', () => {
    const { db } = freshDb();
    insertSummary(db, {
      day: '2026-01-12', host_name: 'h1', host: 'ip1', sample_count: 2, success_count: 2,
      cpu_sum: 30, cpu_max: 20, cpu_min: 10,
      memory_pct_sum: 40, memory_pct_max: 25,
      disk_pct_sum: 50, disk_pct_max: 30,
      gpu_util_sum: 60, gpu_util_max: 35,
      gpu_memory_pct_sum: 70, gpu_memory_pct_max: 40,
      load_sum: 1, users_sum: 4, processes_sum: 200,
    });
    insertSummary(db, {
      day: '2026-01-13', host_name: 'h1', host: 'ip1', sample_count: 3, success_count: 3,
      cpu_sum: 90, cpu_max: 40, cpu_min: 25,
      memory_pct_sum: 120, memory_pct_max: 50,
      disk_pct_sum: 150, disk_pct_max: 60,
      gpu_util_sum: 120, gpu_util_max: 50,
      gpu_memory_pct_sum: 150, gpu_memory_pct_max: 60,
      load_sum: 3, users_sum: 6, processes_sum: 300,
    });
    insertSummary(db, { day: '2026-01-12', host_name: 'h2', host: 'ip2', sample_count: 1, cpu_sum: 5, cpu_max: 5, cpu_min: 5, memory_pct_sum: 10, memory_pct_max: 10, disk_pct_sum: 10, disk_pct_max: 10, gpu_util_sum: 10, gpu_util_max: 10, gpu_memory_pct_sum: 10, gpu_memory_pct_max: 10, load_sum: 1, users_sum: 1, processes_sum: 10 });
    // Out of week / other tz.
    insertSummary(db, { day: '2026-01-11', sample_count: 1, cpu_sum: 999 });
    insertSummary(db, { day: '2026-01-12', tz: 'Asia/Shanghai', sample_count: 1, cpu_sum: 999 });

    const results = fetchWeeklyMetrics(db, '2026-01-12', '2026-01-18', 'UTC');

    expect(results.map((r) => r.host_name)).toEqual(['h1', 'h2']);
    expect(results[0]).toEqual({
      host_name: 'h1',
      host: 'ip1',
      sample_count: 5,
      success_count: 5,
      cpu_avg: 22.5, // mean(15, 30)
      cpu_max: 40,
      cpu_min: 10,
      memory_avg_percent: 30, // mean(20, 40)
      memory_max_percent: 50,
      disk_avg_percent: 37.5, // mean(25, 50)
      disk_max_percent: 60,
      gpu_util_avg: 35, // mean(30, 40)
      gpu_util_max: 50,
      gpu_memory_avg_percent: 42.5, // mean(35, 50)
      gpu_memory_max_percent: 60,
      load_avg: 0.75, // mean(0.5, 1)
      users_avg: 2, // mean(2, 2)
      processes_avg: 100, // mean(100, 100)
    });
  });

  it('raw branch: aggregates raw history as mean-of-daily-means with raw extremes', () => {
    const { db } = freshDb();
    insertHistory(db, { collected_at: '2026-01-12T01:00:00.000000+00:00', host_name: 'h1', cpu: 10, memory_used_mb: 100, memory_total_mb: 1000, disk: 20, gpu_util: 30, gpu_used: 1000, gpu_total: 4000, load1: 1, users: 2, processes: 100 });
    insertHistory(db, { collected_at: '2026-01-12T02:00:00.000000+00:00', host_name: 'h1', cpu: 30, memory_used_mb: 300, memory_total_mb: 1000, disk: 40, gpu_util: 50, gpu_used: 2000, gpu_total: 4000, load1: 3, users: 4, processes: 200 });
    insertHistory(db, { collected_at: '2026-01-13T01:00:00.000000+00:00', host_name: 'h1', cpu: 50, memory_used_mb: 500, memory_total_mb: 1000, disk: 60, gpu_util: 70, gpu_used: 3000, gpu_total: 4000, load1: 5, users: 6, processes: 300 });
    insertHistory(db, { collected_at: '2026-01-12T03:00:00.000000+00:00', host_name: 'h1', success: 0, cpu: 999 });
    // Outside the week.
    insertHistory(db, { collected_at: '2026-01-11T23:00:00.000000+00:00', host_name: 'h1', cpu: 999 });
    insertHistory(db, { collected_at: '2026-01-19T00:00:00.000000+00:00', host_name: 'h1', cpu: 999 });
    // Second host for ordering.
    insertHistory(db, { collected_at: '2026-01-12T01:00:00.000000+00:00', host_name: 'h2', cpu: 5, memory_used_mb: 100, memory_total_mb: 1000, disk: 5, gpu_util: 5, gpu_used: 100, gpu_total: 4000, load1: 1, users: 1, processes: 10 });

    const results = fetchWeeklyMetrics(db, '2026-01-12', '2026-01-18', 'UTC');

    expect(results.map((r) => r.host_name)).toEqual(['h1', 'h2']);
    expect(results[0]).toEqual({
      host_name: 'h1',
      host: '10.0.0.1',
      sample_count: 3,
      success_count: 3,
      cpu_avg: 35, // mean of daily means mean(10,30)=20, mean(50)=50 -> 35
      cpu_max: 50,
      cpu_min: 10,
      memory_avg_percent: 35, // daily means 20, 50
      memory_max_percent: 50,
      disk_avg_percent: 45, // daily means 30, 60
      disk_max_percent: 60,
      gpu_util_avg: 55, // daily means 40, 70
      gpu_util_max: 70,
      gpu_memory_avg_percent: 56.25, // daily means 37.5, 75
      gpu_memory_max_percent: 75,
      load_avg: 3.5, // daily means 2, 5
      users_avg: 4.5, // daily means 3, 6
      processes_avg: 225, // daily means 150, 300
    });
  });
});

// ---------------------------------------------------------------------------
// fetchDailyPointsForWeek
// ---------------------------------------------------------------------------

describe('fetchDailyPointsForWeek', () => {
  it('summary branch: per-day averages ordered by host_name then day', () => {
    const { db } = freshDb();
    insertSummary(db, { day: '2026-01-13', host_name: 'h2', host: 'ip2', sample_count: 2, cpu_sum: 40, memory_pct_sum: 60, gpu_util_sum: 80 });
    insertSummary(db, { day: '2026-01-12', host_name: 'h1', host: 'ip1', sample_count: 2, cpu_sum: 30, memory_pct_sum: 40, gpu_util_sum: 60 });
    insertSummary(db, { day: '2026-01-13', host_name: 'h1', host: 'ip1', sample_count: 4, cpu_sum: 80, memory_pct_sum: 120, gpu_util_sum: 160 });

    const points = fetchDailyPointsForWeek(db, '2026-01-12', '2026-01-18', 'UTC');

    expect(points).toEqual([
      { day: '2026-01-12', host_name: 'h1', host: 'ip1', cpu_avg: 15, memory_percent: 20, gpu_util: 30 },
      { day: '2026-01-13', host_name: 'h1', host: 'ip1', cpu_avg: 20, memory_percent: 30, gpu_util: 40 },
      { day: '2026-01-13', host_name: 'h2', host: 'ip2', cpu_avg: 20, memory_percent: 30, gpu_util: 40 },
    ]);
  });

  it('raw branch: buckets raw samples by local day and orders by (host_name, day)', () => {
    const { db } = freshDb();
    insertHistory(db, { collected_at: '2026-01-13T01:00:00.000000+00:00', host_name: 'h2', host: 'ip2', cpu: 40, memory_used_mb: 600, memory_total_mb: 1000, gpu_util: 80 });
    insertHistory(db, { collected_at: '2026-01-12T02:00:00.000000+00:00', host_name: 'h1', host: 'ip1', cpu: 30, memory_used_mb: 400, memory_total_mb: 1000, gpu_util: 60 });
    insertHistory(db, { collected_at: '2026-01-12T01:00:00.000000+00:00', host_name: 'h1', host: 'ip1', cpu: 10, memory_used_mb: 200, memory_total_mb: 1000, gpu_util: 20 });
    // Outside the week.
    insertHistory(db, { collected_at: '2026-01-11T01:00:00.000000+00:00', host_name: 'h1', cpu: 99 });

    const points = fetchDailyPointsForWeek(db, '2026-01-12', '2026-01-18', 'UTC');

    expect(points).toEqual([
      { day: '2026-01-12', host_name: 'h1', host: 'ip1', cpu_avg: 20, memory_percent: 30, gpu_util: 40 },
      { day: '2026-01-13', host_name: 'h2', host: 'ip2', cpu_avg: 40, memory_percent: 60, gpu_util: 80 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// countRecentSamples / countRecentSamplesByHost
// ---------------------------------------------------------------------------

describe('countRecentSamples', () => {
  const now = new Date('2026-01-15T12:00:00.000Z');

  it('counts a host inside the window and excludes older rows', () => {
    const { db } = freshDb();
    insertHistory(db, { collected_at: '2026-01-15T10:30:00.000000+00:00', host_name: 'h1' });
    insertHistory(db, { collected_at: '2026-01-15T11:59:00.000000+00:00', host_name: 'h1' });
    insertHistory(db, { collected_at: '2026-01-15T09:59:00.000000+00:00', host_name: 'h1' });

    expect(countRecentSamples(db, 'h1', { hours: 2, now })).toBe(2);
    expect(countRecentSamples(db, 'h1', { hours: 1, now })).toBe(1);
    expect(countRecentSamples(db, 'nohost', { hours: 2, now })).toBe(0);
  });

  it('counts every host in one grouped query', () => {
    const { db } = freshDb();
    insertHistory(db, { collected_at: '2026-01-15T10:30:00.000000+00:00', host_name: 'h1' });
    insertHistory(db, { collected_at: '2026-01-15T11:59:00.000000+00:00', host_name: 'h1' });
    insertHistory(db, { collected_at: '2026-01-15T11:00:00.000000+00:00', host_name: 'h2' });
    insertHistory(db, { collected_at: '2026-01-15T08:00:00.000000+00:00', host_name: 'h2' });

    expect(countRecentSamplesByHost(db, { hours: 2, now })).toEqual({ h1: 2, h2: 1 });
  });

  it('clamps hours to at least 1', () => {
    const { db } = freshDb();
    insertHistory(db, { collected_at: '2026-01-15T11:30:00.000000+00:00', host_name: 'h1' });
    insertHistory(db, { collected_at: '2026-01-15T10:30:00.000000+00:00', host_name: 'h1' });
    expect(countRecentSamples(db, 'h1', { hours: 0, now })).toBe(1);
  });
});
