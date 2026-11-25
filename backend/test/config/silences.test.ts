import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError } from '../../src/config/errors';
import { addSilence, deleteSilence, listSilences, SilencesError } from '../../src/config/silences';
import { insertAlert, listAlerts } from '../../src/storage/alerts';
import { cleanupStorageTests, freshDb } from '../storage-helpers';

afterEach(cleanupStorageTests);

const START = '2026-03-01T00:00:00Z';
const END = '2026-03-02T00:00:00Z';
const MID = new Date('2026-03-01T12:00:00Z');

function errorFrom(fn: () => unknown): SilencesError {
  try {
    fn();
  } catch (err) {
    return err as SilencesError;
  }
  throw new Error('expected a throw');
}

function addAlert(db: ReturnType<typeof freshDb>['db'], host: string, fingerprint: string, status = 'active'): number {
  const id = insertAlert(db, {
    host_name: host,
    category: 'cpu',
    severity: 'critical',
    title: `cpu high on ${host}`,
    message: 'm',
    fingerprint,
  });
  if (status !== 'active') {
    db.prepare('UPDATE alerts SET status = ? WHERE id = ?').run(status, id);
  }
  return id;
}

function alertStatus(db: ReturnType<typeof freshDb>['db'], id: number): string | null {
  const row = db.prepare('SELECT status FROM alerts WHERE id = ?').get(id) as { status: string | null };
  return row.status;
}

describe('addSilence — validation', () => {
  it('rejects a non-writable platform', () => {
    const { db } = freshDb();
    const err = errorFrom(() => addSilence(db, 'all', null, 'x', START, END, null, { writable: false }));
    expect(err).toBeInstanceOf(SilencesError);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('settings are not writable on this platform');
  });

  it('rejects an unknown scope_type', () => {
    const { db } = freshDb();
    const err = errorFrom(() => addSilence(db, 'galaxy', null, 'x', START, END));
    expect(err.message).toBe('scope_type 必须是 host、group 或 all');
  });

  it('rejects a non-empty scope for the all scope', () => {
    const { db } = freshDb();
    const err = errorFrom(() => addSilence(db, 'all', 'h1', 'x', START, END));
    expect(err.message).toBe('all 作用域的 scope 必须为空');
  });

  it('requires a scope for host/group', () => {
    const { db } = freshDb();
    expect(errorFrom(() => addSilence(db, 'host', '  ', 'x', START, END)).message).toBe('scope 不能为空');
    expect(errorFrom(() => addSilence(db, 'group', null, 'x', START, END)).message).toBe('scope 不能为空');
  });

  it('rejects an unparseable datetime', () => {
    const { db } = freshDb();
    expect(errorFrom(() => addSilence(db, 'all', null, 'x', 'not-a-date', END)).message).toBe(
      'starts_at 不是有效时间',
    );
    expect(errorFrom(() => addSilence(db, 'all', null, 'x', START, '')).message).toBe(
      'ends_at 不是有效时间',
    );
  });

  it('rejects an inverted window', () => {
    const { db } = freshDb();
    expect(errorFrom(() => addSilence(db, 'all', null, 'x', END, START)).message).toBe(
      'starts_at 必须早于 ends_at',
    );
  });

  it('rejects a window longer than 30 days', () => {
    const { db } = freshDb();
    const err = errorFrom(() =>
      addSilence(db, 'all', null, 'x', '2026-01-01T00:00:00Z', '2026-02-15T00:00:00Z'),
    );
    expect(err.message).toBe('静默窗口不能超过 30 天');
  });
});

describe('addSilence / listSilences / deleteSilence', () => {
  it('inserts an all-scope silence with a null scope and lists it', () => {
    const { db } = freshDb();
    const id = addSilence(db, 'all', null, 'maintenance', START, END, 'tester');
    expect(id).toBeGreaterThan(0);

    const rows = listSilences(db, { activeOnly: true, now: MID });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope_type: 'all',
      scope: null,
      reason: 'maintenance',
      created_by: 'tester',
    });
  });

  it('filters inactive windows when activeOnly is set', () => {
    const { db } = freshDb();
    addSilence(db, 'all', null, 'past', '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');
    addSilence(db, 'all', null, 'active', START, END);

    expect(listSilences(db, { activeOnly: true, now: MID })).toHaveLength(1);
    expect(listSilences(db, { activeOnly: false })).toHaveLength(2);
  });

  it('trims the scope for host scopes and deletes by id', () => {
    const { db } = freshDb();
    const id = addSilence(db, 'host', ' h1 ', 'x', START, END);
    const rows = listSilences(db, { activeOnly: false });
    expect(rows[0].scope).toBe('h1');

    expect(deleteSilence(db, id)).toBe(true);
    expect(deleteSilence(db, id)).toBe(false);
    expect(listSilences(db, { activeOnly: false })).toHaveLength(0);
  });
});

describe('addSilence — resolves open alerts in scope', () => {
  it('resolves every active/acknowledged alert for the all scope', () => {
    const { db } = freshDb();
    const active = addAlert(db, 'h1', 'f1', 'active');
    const ack = addAlert(db, 'h2', 'f2', 'acknowledged');
    const resolved = addAlert(db, 'h3', 'f3', 'resolved');

    addSilence(db, 'all', null, 'x', START, END);

    expect(alertStatus(db, active)).toBe('resolved');
    expect(alertStatus(db, ack)).toBe('resolved');
    expect(alertStatus(db, resolved)).toBe('resolved');
    expect(listAlerts(db, { status: 'active' })).toHaveLength(0);
  });

  it('only resolves the targeted host for a host scope', () => {
    const { db } = freshDb();
    const h1 = addAlert(db, 'h1', 'f1');
    const h2 = addAlert(db, 'h2', 'f2');

    addSilence(db, 'host', 'h1', 'x', START, END);

    expect(alertStatus(db, h1)).toBe('resolved');
    expect(alertStatus(db, h2)).toBe('active');
  });

  it('resolves the hosts whose group matches for a group scope', () => {
    const { db } = freshDb();
    const g1 = addAlert(db, 'h1', 'f1');
    const g2 = addAlert(db, 'h2', 'f2');
    const g3 = addAlert(db, 'h3', 'f3');

    addSilence(db, 'group', 'g1', 'x', START, END, null, {
      hosts: [
        { name: 'h1', group: 'g1' },
        { name: 'h2', group: 'g2' },
        // h3 has no group -> defaults to 未分组
      ],
    });

    expect(alertStatus(db, g1)).toBe('resolved');
    expect(alertStatus(db, g2)).toBe('active');
    expect(alertStatus(db, g3)).toBe('active');
  });
});
