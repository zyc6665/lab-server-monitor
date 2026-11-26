import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/storage/db';
import { initSchema } from '../../src/storage/schema';
import {
  DEFAULT_REPORT_RUN_KEEP,
  latestReportRunByKind,
  listReportRuns,
  pruneReportRuns,
  recordReportRun,
} from '../../src/storage/report-runs';

const openDbs: Array<ReturnType<typeof openDatabase>> = [];

function memoryDb(): ReturnType<typeof openDatabase> {
  const db = openDatabase(':memory:');
  initSchema(db);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
});

describe('report_runs storage', () => {
  it('records a sent run and reads it back', () => {
    const db = memoryDb();
    const id = recordReportRun(db, {
      kind: 'daily',
      variant: 'technical',
      status: 'sent',
      recipients: ['a@example.com', 'b@example.com'],
      createdAt: '2026-01-01T00:00:00.000000+00:00',
    });
    expect(id).toBeGreaterThan(0);
    const rows = listReportRuns(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      kind: 'daily',
      variant: 'technical',
      status: 'sent',
      recipients: 'a@example.com, b@example.com',
      error: null,
    });
    expect(rows[0].sent_at).toBe('2026-01-01T00:00:00.000000+00:00');
  });

  it('records an error run without sent_at', () => {
    const db = memoryDb();
    recordReportRun(db, { kind: 'weekly', variant: 'weekly', status: 'error', error: 'boom' });
    const [row] = listReportRuns(db);
    expect(row.status).toBe('error');
    expect(row.error).toBe('boom');
    expect(row.sent_at).toBeNull();
  });

  it('rejects an unknown status', () => {
    const db = memoryDb();
    expect(() =>
      recordReportRun(db, { kind: 'daily', variant: 'technical', status: 'nope' as never }),
    ).toThrow(/unknown status/);
  });

  it('lists newest first and honours the limit', () => {
    const db = memoryDb();
    recordReportRun(db, { kind: 'daily', variant: 'technical', status: 'sent', createdAt: '2026-01-01T00:00:00.000000+00:00' });
    recordReportRun(db, { kind: 'daily', variant: 'technical', status: 'sent', createdAt: '2026-01-03T00:00:00.000000+00:00' });
    recordReportRun(db, { kind: 'daily', variant: 'technical', status: 'sent', createdAt: '2026-01-02T00:00:00.000000+00:00' });
    const rows = listReportRuns(db, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0].created_at).toBe('2026-01-03T00:00:00.000000+00:00');
    expect(rows[1].created_at).toBe('2026-01-02T00:00:00.000000+00:00');
  });

  it('returns the latest run per kind', () => {
    const db = memoryDb();
    recordReportRun(db, { kind: 'daily', variant: 'technical', status: 'sent', createdAt: '2026-01-01T00:00:00.000000+00:00' });
    recordReportRun(db, { kind: 'weekly', variant: 'weekly', status: 'sent', createdAt: '2026-01-02T00:00:00.000000+00:00' });
    expect(latestReportRunByKind(db, 'daily')?.kind).toBe('daily');
    expect(latestReportRunByKind(db, 'weekly')?.kind).toBe('weekly');
    expect(latestReportRunByKind(db, 'monthly')).toBeNull();
  });

  it('prunes to the newest keep rows', () => {
    const db = memoryDb();
    for (let i = 0; i < 5; i += 1) {
      recordReportRun(db, {
        kind: 'daily',
        variant: 'technical',
        status: 'sent',
        createdAt: `2026-01-0${i + 1}T00:00:00.000000+00:00`,
      });
    }
    const deleted = pruneReportRuns(db, 2);
    expect(deleted).toBe(3);
    expect(listReportRuns(db)).toHaveLength(2);
    // Default keep constant is exported for callers that want the built-in policy.
    expect(DEFAULT_REPORT_RUN_KEEP).toBeGreaterThan(0);
  });

  it('tolerates a database without the table', () => {
    const db = openDatabase(':memory:');
    openDbs.push(db);
    expect(listReportRuns(db)).toEqual([]);
    expect(latestReportRunByKind(db, 'daily')).toBeNull();
    expect(pruneReportRuns(db)).toBe(0);
  });
});
