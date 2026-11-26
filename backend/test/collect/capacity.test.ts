/**
 * Tests for `src/collect/capacity.ts` — port of `servermanage/capacity.py`.
 *
 * The pure functions (`linearSlope`, `parseDay`, `forecastSeries`) are exercised
 * against hand-built series; `buildCapacityForecasts` is driven by a real
 * temporary SQLite database seeded with `host_daily_summary` rows (the same
 * `freshDb` fixture the storage tests use), so the whole path
 * `buildCapacityForecasts -> fetchHostHistory -> daily points` is real, not
 * stubbed.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  CapacityError,
  META_METRICS,
  buildCapacityForecasts,
  forecastSeries,
  linearSlope,
  parseDay,
} from '../../src/collect/capacity';
import type { AuthConfig, HostConfig } from '../../src/config/config';
import { cleanupStorageTests, freshDb, type TestDb } from '../storage-helpers';

afterEach(cleanupStorageTests);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoAddDays(start: string, offset: number): string {
  const [y, m, d] = start.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + offset * 86400000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(
    dt.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** `[{t, [key]: value}]`, one point per day starting at `start`. */
function makeSeries(
  values: Array<number | null>,
  key = 'disk',
  start = '2026-10-01',
): Array<Record<string, unknown>> {
  return values.map((value, index) => ({ t: isoAddDays(start, index), [key]: value }));
}

function makeHost(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    name: 'gpu-01',
    host: '10.0.0.1',
    port: 22,
    username: 'monitor',
    auth: { type: 'key' } as AuthConfig,
    tags: [],
    disk_mounts: ['/'],
    group: '未分组',
    owner: '',
    location: '',
    notes: '',
    checks: [],
    allow_user_write: false,
    ...overrides,
  };
}

interface SummaryInput {
  day: string;
  host_name?: string;
  host?: string;
  tz?: string;
  sample_count?: number;
  memory_pct_sum?: number | null;
  disk_pct_sum?: number | null;
  gpu_memory_pct_sum?: number | null;
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
    input.host_name ?? 'gpu-01',
    input.tz ?? 'UTC',
    input.host ?? '10.0.0.1',
    sample,
    sample,
    null,
    null,
    null,
    input.memory_pct_sum ?? null,
    null,
    input.disk_pct_sum ?? null,
    null,
    null,
    null,
    input.gpu_memory_pct_sum ?? null,
    null,
    null,
    null,
    null,
    '2026-01-15T00:00:00+00:00',
  );
}

// ---------------------------------------------------------------------------
// META_METRICS
// ---------------------------------------------------------------------------

describe('META_METRICS', () => {
  it('is the three metric tuples in order', () => {
    expect(META_METRICS).toEqual([
      ['memory', '内存', 'memory_percent'],
      ['disk', '磁盘', 'disk_percent'],
      ['gpu_memory', 'GPU 显存', 'gpu_memory_percent'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// linearSlope
// ---------------------------------------------------------------------------

describe('linearSlope', () => {
  it('returns null for fewer than two points', () => {
    expect(linearSlope([])).toBeNull();
    expect(linearSlope([[0, 5]])).toBeNull();
  });

  it('returns null when the x denominator is zero', () => {
    expect(linearSlope([[2, 10], [2, 20], [2, 30]])).toBeNull();
  });

  it('returns the per-index least-squares growth', () => {
    expect(linearSlope([[0, 50], [1, 60], [2, 70]])).toBeCloseTo(10, 10);
  });

  it('returns a negative slope for a falling series', () => {
    expect(linearSlope([[0, 70], [1, 60], [2, 50]])).toBeCloseTo(-10, 10);
  });
});

// ---------------------------------------------------------------------------
// parseDay
// ---------------------------------------------------------------------------

describe('parseDay', () => {
  it('parses the first ten characters of an ISO date', () => {
    expect(parseDay('2026-10-01')).toEqual({ y: 2026, m: 10, d: 1 });
    expect(parseDay('2026-10-01T12:34:56+00:00')).toEqual({ y: 2026, m: 10, d: 1 });
  });

  it('returns null for null/empty/non-date values', () => {
    expect(parseDay(null)).toBeNull();
    expect(parseDay(undefined)).toBeNull();
    expect(parseDay('')).toBeNull();
    expect(parseDay('not-a-date')).toBeNull();
    expect(parseDay('2026-1-1')).toBeNull();
  });

  it('returns null for impossible calendar dates', () => {
    expect(parseDay('2026-13-01')).toBeNull();
    expect(parseDay('2026-02-30')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// forecastSeries
// ---------------------------------------------------------------------------

describe('forecastSeries', () => {
  it('reports insufficient_data with fewer than five valid points', () => {
    const result = forecastSeries(makeSeries([50, 52, 54, 56]), 'disk', { threshold: 90 });
    expect(result.status).toBe('insufficient_data');
    expect(result.current).toBe(56);
    expect(result.slope_per_day).toBeNull();
    expect(result.days_to_threshold).toBeNull();
    expect(result.threshold).toBe(90);
    expect(result.key).toBe('disk');
  });

  it('is critical with zero days when already at/over threshold', () => {
    const result = forecastSeries(makeSeries([95, 95, 95, 95, 95, 95, 95, 95, 95, 95]), 'disk', {
      threshold: 90,
    });
    expect(result.current).toBe(95);
    expect(result.status).toBe('critical');
    expect(result.days_to_threshold).toBe(0);
  });

  it('is stable when flat or falling', () => {
    const flat = forecastSeries(makeSeries([50, 50, 50, 50, 50, 50]), 'disk', { threshold: 90 });
    expect(flat.status).toBe('stable');
    expect(flat.slope_per_day).toBe(0);

    const falling = forecastSeries(
      makeSeries([80, 78, 76, 74, 72, 70, 68, 66, 64, 62]),
      'disk',
      { threshold: 90 },
    );
    expect(falling.status).toBe('stable');
  });

  it('is stable when the slope is positive but <= 0.01', () => {
    // Perfectly linear growth of 0.008/day: positive, but below the 0.01 floor.
    const result = forecastSeries(makeSeries([50, 50.008, 50.016, 50.024, 50.032]), 'disk', {
      threshold: 90,
    });
    expect(result.slope_per_day).toBe(0.01); // rounded half-to-even-ish at 2dp
    expect(result.status).toBe('stable');
  });

  it('is critical when the threshold is reached within seven days', () => {
    const result = forecastSeries(
      makeSeries([50, 53, 57, 60, 63, 67, 70, 73, 77, 80]),
      'disk',
      { threshold: 90 },
    );
    expect(result.current).toBe(80);
    expect(result.slope_per_day).toBeCloseTo(3.35, 2);
    expect(result.days_to_threshold).toBeCloseTo(3, 1);
    expect(result.status).toBe('critical');
  });

  it('is warning when the threshold is reached between eight and thirty days', () => {
    const result = forecastSeries(
      makeSeries([50, 52, 54, 56, 58, 60, 62, 64, 66, 68]),
      'disk',
      { threshold: 90 },
    );
    expect(result.slope_per_day).toBeCloseTo(2, 10);
    expect(result.days_to_threshold).toBeCloseTo(11, 10);
    expect(result.status).toBe('warning');
  });

  it('is stable when the threshold is more than thirty days away', () => {
    const result = forecastSeries(
      makeSeries([50, 50.5, 51, 51.5, 52, 52.5, 53, 53.5, 54, 54.5]),
      'disk',
      { threshold: 90 },
    );
    expect(result.slope_per_day).toBeCloseTo(0.5, 10);
    expect(result.days_to_threshold).toBeCloseTo(71, 10);
    expect(result.status).toBe('stable');
  });

  it('honours a custom horizon', () => {
    // Same series: 11 days away is "warning" at horizon 30 but "stable" at horizon 7.
    const series = makeSeries([50, 52, 54, 56, 58, 60, 62, 64, 66, 68]);
    expect(forecastSeries(series, 'disk', { threshold: 90, horizonDays: 7 }).status).toBe('stable');
  });

  it('skips missing values and treats missing days as gaps', () => {
    const result = forecastSeries(makeSeries([50, null, null, 65, null, 75, null, 85, null, 95]), 'disk', {
      threshold: 90,
    });
    expect(result.slope_per_day).toBeCloseTo(5, 1);
    expect(['warning', 'critical']).toContain(result.status);
  });

  it('returns null current when no value is usable', () => {
    const result = forecastSeries([{ t: '2026-10-01', disk: null }], 'disk', { threshold: 90 });
    expect(result.current).toBeNull();
    expect(result.status).toBe('insufficient_data');
  });

  it('rounds current/slope to two decimals', () => {
    // Perfectly linear 0.123456/day; the raw slope is not representable at 2dp.
    const values = Array.from({ length: 10 }, (_, i) => 50 + i * 0.123456);
    const result = forecastSeries(makeSeries(values), 'disk', { threshold: 90 });
    expect(result.slope_per_day).toBe(0.12);
    expect(result.current).toBe(51.11); // 50 + 9 * 0.123456 = 51.111104
    expect(result.threshold).toBe(90);
  });

  it("uses banker's rounding on an exact .xx5 tie", () => {
    // 0.125 is exactly representable; Python round(0.125, 2) == 0.12 (ties to
    // even), NOT 0.13 as Math.round would give.
    const result = forecastSeries(makeSeries([0.125, 0.125, 0.125, 0.125, 0.125]), 'disk', {
      threshold: 90,
    });
    expect(result.current).toBe(0.12);
  });
});

// ---------------------------------------------------------------------------
// buildCapacityForecasts
// ---------------------------------------------------------------------------

describe('buildCapacityForecasts', () => {
  const now = new Date('2026-10-15T12:00:00.000Z');

  function seedHost(db: TestDb, name: string, host: string): void {
    for (let i = 0; i < 10; i += 1) {
      insertSummary(db, {
        day: isoAddDays('2026-10-01', i),
        host_name: name,
        host,
        // memory flat, disk rising fast, gpu rising slowly
        memory_pct_sum: 50,
        disk_pct_sum: 50 + i * 3.2,
        gpu_memory_pct_sum: 40 + i * 0.2,
      });
    }
  }

  it('rejects a days value outside {7, 30, 90} with the Python message', () => {
    const { db } = freshDb();
    expect(() => buildCapacityForecasts(db, [], { days: 14 })).toThrowError(
      'days must be 7, 30 or 90',
    );
    try {
      buildCapacityForecasts(db, [], { days: 14 });
    } catch (err) {
      expect(err).toBeInstanceOf(CapacityError);
      expect((err as Error).name).toBe('CapacityError');
    }
  });

  it('returns one host with three labelled metrics, snake_case keys', () => {
    const { db } = freshDb();
    seedHost(db, 'gpu-01', '10.0.0.1');

    const result = buildCapacityForecasts(db, [makeHost({ name: 'gpu-01', host: '10.0.0.1' })], {
      now,
    });

    expect(result).toHaveLength(1);
    expect(result[0].host_name).toBe('gpu-01');
    expect(result[0].host).toBe('10.0.0.1');
    expect(result[0].metrics).toHaveLength(3);
    expect(result[0].metrics.map((m) => m.key)).toEqual(['memory', 'disk', 'gpu_memory']);
    expect(result[0].metrics.map((m) => m.label)).toEqual(['内存', '磁盘', 'GPU 显存']);
    for (const metric of result[0].metrics) {
      expect(metric.threshold).toBe(90);
      expect(typeof metric.status).toBe('string');
    }
    const disk = result[0].metrics.find((m) => m.key === 'disk')!;
    expect(disk.status).toBe('critical');
    expect(disk.current).toBeCloseTo(78.8, 2);
  });

  it('tolerates a host with no history (insufficient_data, null current)', () => {
    const { db } = freshDb();
    seedHost(db, 'gpu-01', '10.0.0.1');

    const result = buildCapacityForecasts(
      db,
      [makeHost({ name: 'gpu-01', host: '10.0.0.1' }), makeHost({ name: 'empty-02', host: '10.0.0.2' })],
      { now },
    );

    expect(result).toHaveLength(2);
    const empty = result.find((row) => row.host_name === 'empty-02')!;
    expect(empty.metrics).toHaveLength(3);
    for (const metric of empty.metrics) {
      expect(metric.status).toBe('insufficient_data');
      expect(metric.current).toBeNull();
    }
  });

  it('applies the thresholds option override', () => {
    const { db } = freshDb();
    seedHost(db, 'gpu-01', '10.0.0.1');

    const result = buildCapacityForecasts(db, [makeHost()], {
      now,
      thresholds: { memory: 60, disk: 70, gpu_memory: 65 },
    });

    const byKey = Object.fromEntries(result[0].metrics.map((m) => [m.key, m]));
    expect(byKey.memory.threshold).toBe(60);
    expect(byKey.disk.threshold).toBe(70);
    expect(byKey.gpu_memory.threshold).toBe(65);
  });

  it('lets server-level alertRules override per field, above the option', () => {
    const { db } = freshDb();
    seedHost(db, 'gpu-01', '10.0.0.1');

    const host = makeHost({ alert_rules: { disk_percent: 85 } });
    const result = buildCapacityForecasts(db, [host], {
      now,
      thresholds: { memory: 60, disk: 70, gpu_memory: 65 },
    });

    const byKey = Object.fromEntries(result[0].metrics.map((m) => [m.key, m]));
    expect(byKey.disk.threshold).toBe(85); // server override wins
    expect(byKey.memory.threshold).toBe(60); // inherited from option
    expect(byKey.gpu_memory.threshold).toBe(65);
  });

  it('selects the range matching days (7d excludes older-than-window points)', () => {
    const { db } = freshDb();
    // Ten daily points that fall inside a 30-day window ending 2026-10-15
    // (start 2026-09-16) but outside the 7-day window (start 2026-10-09).
    for (let i = 0; i < 10; i += 1) {
      insertSummary(db, {
        day: isoAddDays('2026-09-20', i),
        memory_pct_sum: 50,
        disk_pct_sum: 60 + i,
      });
    }

    const shortWindow = buildCapacityForecasts(db, [makeHost()], { now, days: 7 });
    for (const metric of shortWindow[0].metrics) {
      expect(metric.status).toBe('insufficient_data');
      expect(metric.current).toBeNull();
    }

    const wideWindow = buildCapacityForecasts(db, [makeHost()], { now, days: 30 });
    const disk = wideWindow[0].metrics.find((m) => m.key === 'disk')!;
    expect(disk.current).toBeCloseTo(69, 2);
    expect(disk.status).toBe('warning'); // slope 1/day -> 21 days away, horizon 30
  });

  it('uses default thresholds from the settings alerts section', () => {
    const { db } = freshDb();
    seedHost(db, 'gpu-01', '10.0.0.1');
    const result = buildCapacityForecasts(db, [makeHost()], { now });
    for (const metric of result[0].metrics) {
      expect(metric.threshold).toBe(90);
    }
  });
});
