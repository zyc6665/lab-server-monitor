import { describe, it, expect, afterEach } from 'vitest';

import { getTaskState, setTaskState, listTaskStates } from '../src/storage/tasks';
import { cleanupStorageTests, freshDb } from './storage-helpers';

const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/;

afterEach(cleanupStorageTests);

describe('task_state storage', () => {
  it('returns null / empty when nothing has been stored', () => {
    const { db } = freshDb();
    expect(getTaskState(db, 'collector')).toBeNull();
    expect(listTaskStates(db)).toEqual([]);
  });

  it('round-trips an explicit last_run_at and last_result', () => {
    const { db } = freshDb();
    setTaskState(db, 'collector', {
      lastRunAt: '2026-01-02T03:04:05.123000+00:00',
      lastResult: 'ok',
    });

    expect(getTaskState(db, 'collector')).toEqual({
      task_name: 'collector',
      last_run_at: '2026-01-02T03:04:05.123000+00:00',
      last_result: 'ok',
    });
  });

  it('defaults last_run_at to the current UTC instant when omitted', () => {
    const { db } = freshDb();
    setTaskState(db, 'collector');

    const state = getTaskState(db, 'collector');
    expect(state).not.toBeNull();
    expect(state?.last_run_at).toMatch(STRICT_ISO);
    expect(state?.last_result).toBeNull();
  });

  it('defaults last_result to null', () => {
    const { db } = freshDb();
    setTaskState(db, 'collector', { lastRunAt: '2026-01-02T03:04:05.000000+00:00' });
    expect(getTaskState(db, 'collector')?.last_result).toBeNull();
  });

  it('overwrites the row for an existing task_name', () => {
    const { db } = freshDb();
    setTaskState(db, 'collector', { lastRunAt: '2026-01-01T00:00:00.000000+00:00', lastResult: 'first' });
    setTaskState(db, 'collector', { lastRunAt: '2026-01-02T00:00:00.000000+00:00', lastResult: 'second' });

    expect(getTaskState(db, 'collector')).toEqual({
      task_name: 'collector',
      last_run_at: '2026-01-02T00:00:00.000000+00:00',
      last_result: 'second',
    });
    const count = db.prepare('SELECT COUNT(*) AS n FROM task_state').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('lists every task state ordered by task_name', () => {
    const { db } = freshDb();
    setTaskState(db, 'beta', { lastRunAt: '2026-01-01T00:00:00.000000+00:00' });
    setTaskState(db, 'alpha', { lastRunAt: '2026-01-01T00:00:00.000000+00:00' });

    expect(listTaskStates(db).map((row) => row.task_name)).toEqual(['alpha', 'beta']);
  });
});
