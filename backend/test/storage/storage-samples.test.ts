/** Unit tests for the `storage_samples` accessors (P2-4). */
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';
import {
  listStorageSamples,
  pruneStorageSamples,
  recordStorageSample,
} from '../../src/storage/storage-samples';

let fresh: FreshDb;

afterEach(() => {
  cleanupStorageTests();
});

describe('storage_samples storage', () => {
  it('upserts one row per day and returns oldest-first', () => {
    fresh = freshDb();
    recordStorageSample(fresh.db, { dbBytes: 100, dataDirBytes: 1000, now: new Date('2026-03-01T10:00:00Z') });
    recordStorageSample(fresh.db, { dbBytes: 200, dataDirBytes: 2000, now: new Date('2026-03-01T18:00:00Z') });
    recordStorageSample(fresh.db, { dbBytes: 300, dataDirBytes: 3000, now: new Date('2026-03-02T09:00:00Z') });
    const rows = listStorageSamples(fresh.db, 90);
    expect(rows.map((r) => r.day)).toEqual(['2026-03-01', '2026-03-02']);
    expect(rows[0]!.db_bytes).toBe(200); // same-day upsert kept the latest
  });

  it('clamps the requested window', () => {
    fresh = freshDb();
    recordStorageSample(fresh.db, { dbBytes: 1, dataDirBytes: 1, now: new Date('2026-03-01T00:00:00Z') });
    expect(listStorageSamples(fresh.db, 0)).toHaveLength(1);
    expect(listStorageSamples(fresh.db, 9999)).toHaveLength(1);
  });

  it('prunes samples older than 180 days', () => {
    fresh = freshDb();
    recordStorageSample(fresh.db, { dbBytes: 1, dataDirBytes: 1, now: new Date('2020-01-01T00:00:00Z') });
    recordStorageSample(fresh.db, { dbBytes: 2, dataDirBytes: 2, now: new Date('2026-03-01T00:00:00Z') });
    expect(pruneStorageSamples(fresh.db, new Date('2026-03-02T00:00:00Z'))).toBe(1);
    expect(listStorageSamples(fresh.db, 90)).toHaveLength(1);
  });
});
