import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/storage/db';
import { initSchema } from '../src/storage/schema';
import {
  DEFAULT_TASK_RUN_LIMIT,
  latestRunByTask,
  listTaskRuns,
  listTaskRunsForTask,
  pruneTaskRuns,
  recordTaskRunFinish,
  recordTaskRunStart,
} from '../src/storage/task-runs';

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

/** Insert a running row and hand back its id. */
function start(
  handle: ReturnType<typeof openDatabase>,
  task: string,
  startedAt: string,
): number {
  return recordTaskRunStart(handle, { task, trigger: 'schedule', startedAt });
}

describe('task_runs storage', () => {
  it('starts empty', () => {
    db = open();
    expect(listTaskRuns(db)).toEqual([]);
    expect(listTaskRunsForTask(db, 'collect')).toEqual([]);
    expect(latestRunByTask(db)).toEqual({});
  });

  it('inserts a running row and defaults started_at to the current UTC instant', () => {
    db = open();
    const id = recordTaskRunStart(db, { task: 'collect', trigger: 'schedule' });

    expect(id).toBeGreaterThan(0);
    const rows = listTaskRuns(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      task: 'collect',
      trigger: 'schedule',
      finished_at: null,
      status: 'running',
      error: null,
      duration_ms: null,
    });
    expect(rows[0]?.started_at).toMatch(STRICT_ISO);
  });

  it('keeps an explicit started_at and returns increasing ids', () => {
    db = open();
    const first = start(db, 'collect', '2026-01-01T00:00:00.000000+00:00');
    const second = recordTaskRunStart(db, {
      task: 'prune',
      trigger: 'manual',
      startedAt: '2026-01-01T00:00:01.000000+00:00',
    });

    expect(second).toBeGreaterThan(first);
    expect(listTaskRuns(db)).toHaveLength(2);
    expect(listTaskRunsForTask(db, 'collect')[0]?.started_at).toBe(
      '2026-01-01T00:00:00.000000+00:00',
    );
  });

  it('finishes a run with ok status and a duration derived from the timestamps', () => {
    db = open();
    const id = start(db, 'collect', '2026-01-01T00:00:00.000000+00:00');
    expect(
      recordTaskRunFinish(db, id, {
        status: 'ok',
        finishedAt: '2026-01-01T00:00:02.500000+00:00',
      }),
    ).toBe(true);

    expect(listTaskRuns(db)[0]).toMatchObject({
      status: 'ok',
      error: null,
      finished_at: '2026-01-01T00:00:02.500000+00:00',
      duration_ms: 2500,
    });
  });

  it('finishes a run with error status and stores the failure text', () => {
    db = open();
    const id = start(db, 'collect', '2026-01-01T00:00:00.000000+00:00');
    recordTaskRunFinish(db, id, {
      status: 'error',
      error: 'error: Error: boom',
      finishedAt: '2026-01-01T00:00:00.250000+00:00',
    });

    expect(listTaskRuns(db)[0]).toMatchObject({
      status: 'error',
      error: 'error: Error: boom',
      duration_ms: 250,
    });
  });

  it('defaults finished_at to now and clears error on success', () => {
    db = open();
    const id = start(db, 'collect', '2026-01-01T00:00:00.000000+00:00');
    recordTaskRunFinish(db, id, { status: 'ok' });

    const row = listTaskRuns(db)[0];
    expect(row?.finished_at).toMatch(STRICT_ISO);
    expect(row?.status).toBe('ok');
    expect(row?.error).toBeNull();
    expect(row?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('returns false when the run row vanished and validates its inputs', () => {
    db = open();
    const id = start(db, 'collect', '2026-01-01T00:00:00.000000+00:00');
    expect(db.prepare('DELETE FROM task_runs WHERE id = ?').run(id).changes).toBe(1);
    expect(recordTaskRunFinish(db, id, { status: 'ok' })).toBe(false);

    expect(() => recordTaskRunFinish(db, 0, { status: 'ok' })).toThrow(/invalid run id/);
    expect(() =>
      recordTaskRunFinish(db, id, { status: 'nope' as never }),
    ).toThrow(/unknown finish status/);
    expect(() => recordTaskRunStart(db, { task: '  ', trigger: 'schedule' })).toThrow(
      /task name is required/,
    );
    expect(() =>
      recordTaskRunStart(db, { task: 'collect', trigger: 'bogus' as never }),
    ).toThrow(/unknown trigger/);
  });

  it('lists runs newest-first and honours the limit', () => {
    db = open();
    start(db, 'collect', '2026-01-01T00:00:00.000000+00:00');
    start(db, 'collect', '2026-01-01T00:00:01.000000+00:00');
    const third = start(db, 'collect', '2026-01-01T00:00:02.000000+00:00');

    expect(listTaskRuns(db).map((row) => row.started_at)).toEqual([
      '2026-01-01T00:00:02.000000+00:00',
      '2026-01-01T00:00:01.000000+00:00',
      '2026-01-01T00:00:00.000000+00:00',
    ]);
    expect(listTaskRuns(db, { limit: 2 })).toHaveLength(2);
    expect(listTaskRuns(db, { limit: 2 })[0]?.id).toBe(third);
    // Non-positive limits fall back to the default page size.
    expect(listTaskRuns(db, { limit: 0 })[0]?.id).toBe(third);
    expect(DEFAULT_TASK_RUN_LIMIT).toBe(200);
  });

  it('filters by task', () => {
    db = open();
    start(db, 'collect', '2026-01-01T00:00:00.000000+00:00');
    start(db, 'prune', '2026-01-01T00:00:01.000000+00:00');
    start(db, 'collect', '2026-01-01T00:00:02.000000+00:00');

    const collect = listTaskRunsForTask(db, 'collect', 1);
    expect(collect).toHaveLength(1);
    expect(collect[0]?.started_at).toBe('2026-01-01T00:00:02.000000+00:00');
    expect(listTaskRunsForTask(db, 'collect')).toHaveLength(2);
    expect(listTaskRunsForTask(db, 'missing')).toEqual([]);
    expect(listTaskRunsForTask(db, '  ')).toEqual([]);
  });

  it('reports the latest run per task', () => {
    db = open();
    const collectFirst = start(db, 'collect', '2026-01-01T00:00:00.000000+00:00');
    recordTaskRunFinish(db, collectFirst, { status: 'error', error: 'first' });
    const collectSecond = start(db, 'collect', '2026-01-01T00:00:10.000000+00:00');
    recordTaskRunFinish(db, collectSecond, { status: 'ok' });
    const pruneFirst = start(db, 'prune', '2026-01-01T00:00:05.000000+00:00');

    const latest = latestRunByTask(db);
    expect(Object.keys(latest).sort()).toEqual(['collect', 'prune']);
    expect(latest.collect?.id).toBe(collectSecond);
    expect(latest.collect?.status).toBe('ok');
    expect(latest.prune?.id).toBe(pruneFirst);
    expect(latest.prune?.status).toBe('running');
  });

  it('prunes old rows, keeping the newest N', () => {
    db = open();
    for (let index = 0; index < 5; index += 1) {
      const startedAt = `2026-01-01T00:00:0${index}.000000+00:00`;
      start(db, index % 2 === 0 ? 'collect' : 'prune', startedAt);
    }
    expect(listTaskRuns(db)).toHaveLength(5);

    expect(pruneTaskRuns(db, 2)).toBe(3);
    expect(listTaskRuns(db).map((row) => row.started_at)).toEqual([
      '2026-01-01T00:00:04.000000+00:00',
      '2026-01-01T00:00:03.000000+00:00',
    ]);
    expect(pruneTaskRuns(db, 2)).toBe(0);
    expect(pruneTaskRuns(db, 0)).toBe(2);
    expect(listTaskRuns(db)).toEqual([]);
    expect(pruneTaskRuns(db)).toBe(0);
  });

  it('tolerates a database without the task_runs table', () => {
    db = openDatabase(':memory:');
    expect(listTaskRuns(db)).toEqual([]);
    expect(listTaskRunsForTask(db, 'collect')).toEqual([]);
    expect(latestRunByTask(db)).toEqual({});
    expect(pruneTaskRuns(db)).toBe(0);
    expect(() =>
      recordTaskRunStart(db, { task: 'collect', trigger: 'schedule' }),
    ).toThrow(/no such table/i);
  });
});