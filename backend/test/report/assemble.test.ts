/**
 * Tests for the P5 Task 11a report assembly (`report/assemble.ts`).
 *
 * All DB-backed cases run against a fresh SQLite database seeded through
 * `host_daily_summary` / `host_check_snapshot`, so no SSH or filesystem work
 * outside the temp DB is involved.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { HostReport } from '../../src/collect/types';
import {
  buildDailyReport,
  computeIntensityScore,
  generateWeeklyReport,
  previousWeekRange,
} from '../../src/report/assemble';
import { cleanupStorageTests, freshDb, type TestDb } from '../storage-helpers';

afterEach(() => {
  cleanupStorageTests();
});

interface SummarySeed {
  day: string;
  hostName: string;
  host?: string;
  sampleCount: number;
  successCount?: number;
  cpu?: number | null;
  mem?: number | null;
  gpu?: number | null;
}

function scaled(value: number | null | undefined, count: number): number | null {
  return value === null || value === undefined ? null : value * count;
}

/** Inserts one `host_daily_summary` row (tz = UTC) whose averages match the seed. */
function insertSummary(db: TestDb, seed: SummarySeed): void {
  const cpu = seed.cpu ?? null;
  const mem = seed.mem ?? null;
  const gpu = seed.gpu ?? null;
  db.prepare(
    `INSERT INTO host_daily_summary (
       day, host_name, tz, host, sample_count, success_count,
       cpu_sum, cpu_max, cpu_min,
       memory_pct_sum, memory_pct_max,
       disk_pct_sum, disk_pct_max,
       gpu_util_sum, gpu_util_max,
       gpu_memory_pct_sum, gpu_memory_pct_max,
       load_sum, users_sum, processes_sum, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seed.day,
    seed.hostName,
    'UTC',
    seed.host ?? `${seed.hostName}.example`,
    seed.sampleCount,
    seed.successCount ?? seed.sampleCount,
    scaled(cpu, seed.sampleCount),
    cpu,
    cpu,
    scaled(mem, seed.sampleCount),
    mem,
    null,
    null,
    scaled(gpu, seed.sampleCount),
    gpu,
    null,
    null,
    null,
    null,
    null,
    '2024-01-07T00:00:00Z',
  );
}

function insertCheck(db: TestDb, hostName: string, checkName: string, status = 'ok'): void {
  db.prepare(
    `INSERT INTO host_check_snapshot
       (host_name, check_name, check_type, target, status, message, latency_ms, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(hostName, checkName, 'tcp', '22', status, '', 12, '2024-01-07T00:00:00Z');
}

function seedClassificationFixture(db: TestDb): void {
  // Busy: score 95 and 80 (descending expected).
  insertSummary(db, { day: '2024-01-03', hostName: 'busyA', sampleCount: 5, cpu: 95, mem: 95 });
  insertSummary(db, { day: '2024-01-03', hostName: 'busyB', sampleCount: 5, cpu: 80, mem: 80 });
  // Idle: score 5 and 15 (ascending expected).
  insertSummary(db, { day: '2024-01-03', hostName: 'idleA', sampleCount: 5, cpu: 5, mem: 5 });
  insertSummary(db, { day: '2024-01-03', hostName: 'idleB', sampleCount: 5, cpu: 15, mem: 15 });
  // Below the 3-sample floor: never classified.
  insertSummary(db, { day: '2024-01-03', hostName: 'low', sampleCount: 2, cpu: 99, mem: 99 });
  // Mid (score 50): neither busy nor idle.
  insertSummary(db, { day: '2024-01-03', hostName: 'mid', sampleCount: 5, cpu: 50, mem: 50 });
  // Two daily points for `multi`: weekly mean is 50, daily points 40 then 60.
  insertSummary(db, { day: '2024-01-03', hostName: 'multi', sampleCount: 5, cpu: 40, mem: 40 });
  insertSummary(db, { day: '2024-01-04', hostName: 'multi', sampleCount: 5, cpu: 60, mem: 60 });

  insertCheck(db, 'busyA', 'cpu');
  insertCheck(db, 'busyA', 'disk');
}

describe('previousWeekRange', () => {
  it('returns the previous Mon..Sun week for a mid-week reference date (crosses new year)', () => {
    expect(previousWeekRange({ referenceDate: '2024-01-03' })).toEqual({
      weekStart: '2023-12-25',
      weekEnd: '2023-12-31',
    });
  });

  it('handles a Monday reference date', () => {
    expect(previousWeekRange({ referenceDate: '2024-01-08' })).toEqual({
      weekStart: '2024-01-01',
      weekEnd: '2024-01-07',
    });
  });

  it('handles a Sunday reference date', () => {
    expect(previousWeekRange({ referenceDate: '2024-01-07' })).toEqual({
      weekStart: '2023-12-25',
      weekEnd: '2023-12-31',
    });
  });

  it('derives the week from an injected now in a non-UTC timezone', () => {
    // 2024-01-03T23:30Z is 2024-01-04 (Thu) in Asia/Tokyo → the prior Mon..Sun.
    expect(
      previousWeekRange({ now: new Date('2024-01-03T23:30:00Z'), tz: 'Asia/Tokyo' }),
    ).toEqual({ weekStart: '2023-12-25', weekEnd: '2023-12-31' });
  });
});

describe('computeIntensityScore', () => {
  it('weights cpu/memory/gpu when GPU samples exist', () => {
    expect(
      computeIntensityScore({ cpuAvg: 80, memoryAvgPercent: 60, gpuUtilAvg: 40 }),
    ).toBe(66);
  });

  it('renormalises over 0.8 when GPU is missing', () => {
    expect(
      computeIntensityScore({ cpuAvg: 80, memoryAvgPercent: 60, gpuUtilAvg: null }),
    ).toBe(72.5);
  });

  it('treats all-null inputs as zero', () => {
    expect(
      computeIntensityScore({ cpuAvg: null, memoryAvgPercent: null, gpuUtilAvg: null }),
    ).toBe(0);
  });
});

describe('buildDailyReport', () => {
  it('copies reports and stamps generatedAt / subjectPrefix', () => {
    const reports = [{ hostName: 'alpha' } as unknown as HostReport];
    const daily = buildDailyReport(reports, {
      generatedAt: '2024-01-07T00:00:00.000Z',
      subjectPrefix: '[Server Daily Report]',
    });
    expect(daily.generatedAt).toBe('2024-01-07T00:00:00.000Z');
    expect(daily.subjectPrefix).toBe('[Server Daily Report]');
    expect(daily.reports).toEqual(reports);
    expect(daily.reports).not.toBe(reports);
  });
});

describe('generateWeeklyReport', () => {
  it('classifies busy/idle, merges checks + daily points, and keeps low-sample hosts in summaries', () => {
    const { db } = freshDb();
    seedClassificationFixture(db);

    const report = generateWeeklyReport(db, { referenceDate: '2024-01-10', tz: 'UTC' });

    expect(report.weekStart).toBe('2024-01-01');
    expect(report.weekEnd).toBe('2024-01-07');
    expect(report.subjectPrefix).toBe('[Server Weekly Report]');
    expect(Number.isNaN(Date.parse(report.generatedAt))).toBe(false);

    // Every host with ≥1 weekly row is present, sorted by host name.
    expect(report.summaries.map((s) => s.hostName)).toEqual([
      'busyA',
      'busyB',
      'idleA',
      'idleB',
      'low',
      'mid',
      'multi',
    ]);

    // Busy sorted by intensity descending; idle ascending.
    expect(report.busyHosts.map((s) => s.hostName)).toEqual(['busyA', 'busyB']);
    expect(report.idleHosts.map((s) => s.hostName)).toEqual(['idleA', 'idleB']);
    // The below-threshold host is never classified.
    expect([...report.busyHosts, ...report.idleHosts].map((s) => s.hostName)).not.toContain('low');

    // Checks merged from the current snapshot, ordered by check name.
    const busyA = report.summaries.find((s) => s.hostName === 'busyA');
    expect(busyA).toBeDefined();
    expect(busyA?.checks.map((check) => check['check_name'])).toEqual(['cpu', 'disk']);

    // Daily points merged per (host_name, host), ordered by day.
    const multi = report.summaries.find((s) => s.hostName === 'multi');
    expect(multi?.dailyPoints.map((point) => point.day)).toEqual([
      '2024-01-03',
      '2024-01-04',
    ]);
    expect(multi?.dailyPoints.map((point) => point.cpu_avg)).toEqual([40, 60]);
    expect(multi?.gpuUtilAvg).toBeNull();

    // The low-sample host keeps its summary but is excluded from classification.
    const low = report.summaries.find((s) => s.hostName === 'low');
    expect(low?.sampleCount).toBe(2);
  });

  it('honours config overrides for subject prefix and thresholds', () => {
    const { db } = freshDb();
    seedClassificationFixture(db);

    const report = generateWeeklyReport(db, {
      referenceDate: '2024-01-10',
      config: { subjectPrefix: '[Custom]', busyThreshold: 100, idleThreshold: 60 },
    });

    expect(report.subjectPrefix).toBe('[Custom]');
    expect(report.busyHosts).toEqual([]);
    expect(report.idleHosts.map((s) => s.hostName)).toEqual([
      'idleA',
      'idleB',
      'mid',
      'multi',
    ]);
  });
});
