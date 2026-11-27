/**
 * Disk-health trend storage (M6): `fetchDiskHealthHistory` reads a host's
 * recent `disk_health_snapshot` batches and aggregates per-batch drive counts
 * from `disk_pd_snapshot`, oldest-first for charting.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { fetchDiskHealthHistory, saveDiskHealth } from '../../src/storage/disk';
import { cleanupStorageTests, freshDb } from '../storage-helpers';

afterEach(() => {
  cleanupStorageTests();
});

const DAY = 86_400_000;
const BASE = new Date('2026-11-01T00:00:00.000Z');

function seedBatch(
  db: Parameters<typeof saveDiskHealth>[0],
  hostName: string,
  dayOffset: number,
  status: string,
  drives: Array<{ health: string; temp: number | null }>,
): void {
  saveDiskHealth(db, {
    host_name: hostName,
    collected_at: new Date(BASE.getTime() + dayOffset * DAY),
    status,
    message: status === 'ok' ? null : `${status} message`,
    physical_drives: drives.map((drive, index) => ({
      controller: 0,
      enclosure: 0,
      slot: index,
      health: drive.health,
      temperature_c: drive.temp,
    })),
  });
}

describe('fetchDiskHealthHistory', () => {
  it('returns batches oldest-first with per-batch drive counts', () => {
    const { db } = freshDb();
    seedBatch(db, 'h1', 0, 'ok', [
      { health: 'healthy', temp: 30 },
      { health: 'healthy', temp: 32 },
    ]);
    seedBatch(db, 'h1', 1, 'ok', [
      { health: 'healthy', temp: 31 },
      { health: 'warning', temp: 40 },
    ]);
    seedBatch(db, 'h1', 2, 'degraded', [
      { health: 'warning', temp: 45 },
      { health: 'critical', temp: 50 },
    ]);

    const points = fetchDiskHealthHistory(db, 'h1', {
      days: 30,
      now: new Date(BASE.getTime() + 3 * DAY),
    });

    expect(points).toHaveLength(3);
    expect(points[0].collected_at < points[2].collected_at).toBe(true);
    expect(points[2].status).toBe('degraded');
    expect(points[2].drives).toBe(2);
    expect(points[2].warning).toBe(1);
    expect(points[2].critical).toBe(1);
    expect(points[2].healthy).toBe(0);
    expect(points[2].max_temperature_c).toBe(50);
    expect(points[0].healthy).toBe(2);
    expect(points[0].max_temperature_c).toBe(32);
  });

  it('returns an empty list for an unknown host', () => {
    const { db } = freshDb();
    expect(fetchDiskHealthHistory(db, 'nope', { days: 30 })).toEqual([]);
  });

  it('isolates hosts and honours the day cutoff', () => {
    const { db } = freshDb();
    seedBatch(db, 'h1', 0, 'ok', [{ health: 'healthy', temp: 30 }]);
    seedBatch(db, 'h1', 20, 'ok', [{ health: 'healthy', temp: 33 }]);
    seedBatch(db, 'h2', 20, 'error', []);

    const recent = fetchDiskHealthHistory(db, 'h1', {
      days: 10,
      now: new Date(BASE.getTime() + 21 * DAY),
    });
    expect(recent).toHaveLength(1);
    expect(recent[0].max_temperature_c).toBe(33);

    const all = fetchDiskHealthHistory(db, 'h1', {
      days: 30,
      now: new Date(BASE.getTime() + 21 * DAY),
    });
    expect(all).toHaveLength(2);
    expect(all.every((point) => point.status === 'ok')).toBe(true);

    const other = fetchDiskHealthHistory(db, 'h2', {
      days: 30,
      now: new Date(BASE.getTime() + 21 * DAY),
    });
    expect(other).toHaveLength(1);
    expect(other[0].drives).toBe(0);
    expect(other[0].max_temperature_c).toBeNull();
  });

  it('caps the number of points to the newest `limit` batches', () => {
    const { db } = freshDb();
    for (let day = 0; day < 5; day += 1) {
      seedBatch(db, 'h1', day, 'ok', [{ health: 'healthy', temp: 30 + day }]);
    }
    const points = fetchDiskHealthHistory(db, 'h1', {
      days: 30,
      limit: 2,
      now: new Date(BASE.getTime() + 10 * DAY),
    });
    expect(points).toHaveLength(2);
    expect(points[0].max_temperature_c).toBe(33);
    expect(points[1].max_temperature_c).toBe(34);
  });
});
