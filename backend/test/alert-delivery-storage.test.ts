import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/storage/db';
import { initSchema } from '../src/storage/schema';
import {
  latestFailuresByAlert,
  listDeliveryFailures,
  pruneDeliveryFailures,
  recordDeliveryFailure,
} from '../src/storage/alert-delivery';
import { insertAlert } from '../src/storage/alerts';

const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/;

const open = (): ReturnType<typeof openDatabase> => {
  const db = openDatabase(':memory:');
  initSchema(db);
  return db;
};

let db: ReturnType<typeof openDatabase> | null = null;

afterEach(() => {
  if (db) {
    db.close();
    db = null;
  }
});

function seedAlert(handle: ReturnType<typeof openDatabase>, host = 'gpu-01'): number {
  return insertAlert(handle, {
    host_name: host,
    category: 'cpu',
    severity: 'warning',
    title: 'cpu high',
    message: 'cpu usage above threshold',
    fingerprint: `cpu:${host}:${Math.random()}`,
  });
}

describe('alert-delivery storage', () => {
  it('records a failure and lists it with camelCase fields', () => {
    db = open();
    const alertId = seedAlert(db);

    const id = recordDeliveryFailure(db, {
      alertId,
      channel: 'email',
      target: 'ops@example.test',
      error: 'smtp timeout',
    });
    expect(id).toBeGreaterThan(0);

    const rows = listDeliveryFailures(db, { alertId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id,
      alertId,
      channel: 'email',
      target: 'ops@example.test',
      error: 'smtp timeout',
      at: expect.stringMatching(STRICT_ISO) as unknown as string,
    });
  });

  it('stores a null target when the channel has none', () => {
    db = open();
    const alertId = seedAlert(db);

    recordDeliveryFailure(db, { alertId, channel: 'desktop', error: 'bridge missing' });
    const [row] = listDeliveryFailures(db, { alertId });
    expect(row.channel).toBe('desktop');
    expect(row.target).toBeNull();
  });

  it('filters by alert id and orders newest first', () => {
    db = open();
    const first = seedAlert(db, 'gpu-01');
    const second = seedAlert(db, 'gpu-02');

    recordDeliveryFailure(
      db,
      { alertId: first, channel: 'email', error: 'old' },
      { at: '2026-01-01T00:00:00.000000+00:00' },
    );
    recordDeliveryFailure(
      db,
      { alertId: first, channel: 'webhook', error: 'new' },
      { at: '2026-01-02T00:00:00.000000+00:00' },
    );
    recordDeliveryFailure(db, { alertId: second, channel: 'email', error: 'other' });

    const rows = listDeliveryFailures(db, { alertId: first });
    expect(rows).toHaveLength(2);
    expect(rows[0].error).toBe('new');
    expect(rows[1].error).toBe('old');

    const all = listDeliveryFailures(db);
    expect(all).toHaveLength(3);
  });

  it('honours and clamps the limit', () => {
    db = open();
    const alertId = seedAlert(db);
    for (let index = 0; index < 5; index += 1) {
      recordDeliveryFailure(db, { alertId, channel: 'email', error: `e${index}` });
    }
    expect(listDeliveryFailures(db, { limit: 2 })).toHaveLength(2);
    expect(listDeliveryFailures(db, { limit: 0 })).toHaveLength(1);
    expect(listDeliveryFailures(db, { limit: -5, alertId })).toHaveLength(1);
  });

  it('prunes failures older than the given window', () => {
    db = open();
    const alertId = seedAlert(db);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const fresh = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    recordDeliveryFailure(db, { alertId, channel: 'email', error: 'old' }, { at: old });
    recordDeliveryFailure(db, { alertId, channel: 'email', error: 'fresh' }, { at: fresh });

    expect(pruneDeliveryFailures(db, 30)).toBe(1);
    const remaining = listDeliveryFailures(db, { alertId });
    expect(remaining.map((row) => row.error)).toEqual(['fresh']);
  });

  it('returns the newest failure per alert as a map', () => {
    db = open();
    const first = seedAlert(db, 'gpu-01');
    const second = seedAlert(db, 'gpu-02');
    recordDeliveryFailure(
      db,
      { alertId: first, channel: 'email', error: 'older' },
      { at: '2026-01-01T00:00:00.000000+00:00' },
    );
    recordDeliveryFailure(
      db,
      { alertId: first, channel: 'webhook', error: 'newer' },
      { at: '2026-01-03T00:00:00.000000+00:00' },
    );
    recordDeliveryFailure(db, { alertId: second, channel: 'desktop', error: 'only' });

    const latest = latestFailuresByAlert(db);
    expect(latest.size).toBe(2);
    expect(latest.get(first)?.error).toBe('newer');
    expect(latest.get(second)?.channel).toBe('desktop');
  });

  it('rejects an invalid alert id and a blank channel', () => {
    db = open();
    expect(() => recordDeliveryFailure(db as never, { alertId: 0, channel: 'email', error: 'x' })).toThrow(
      /alertId/,
    );
    expect(() =>
      recordDeliveryFailure(db as never, { alertId: 1, channel: '   ', error: 'x' }),
    ).toThrow(/channel/);
  });
});
