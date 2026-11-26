import { afterEach, describe, expect, it } from 'vitest';

import {
  Scheduler,
  TaskNotFoundError,
  TaskRunningError,
  type ScheduledTask,
} from '../../src/runtime/scheduler';
import { openDatabase } from '../../src/storage/db';
import { initSchema } from '../../src/storage/schema';
import { listTaskRuns, listTaskRunsForTask } from '../../src/storage/task-runs';
import { getTaskState } from '../../src/storage/tasks';

const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/;

/** Fixed clock: 2026-11-26 09:00 UTC (a Thursday). */
const FIXED_NOW = new Date(Date.UTC(2026, 10, 26, 9, 0, 0));

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

function makeScheduler(
  handle: ReturnType<typeof openDatabase>,
  tasks: ScheduledTask[],
): Scheduler {
  return new Scheduler(tasks, {
    db: handle,
    tz: 'UTC',
    now: () => new Date(FIXED_NOW.getTime()),
  });
}

/** A promise plus its external resolve/reject, used to hold a run in flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function intervalTask(
  name: string,
  intervalSeconds: number,
  run: () => string | Promise<string> = () => 'ok',
): ScheduledTask {
  return { name, intervalSeconds, run };
}

describe('Scheduler — task_runs bookkeeping', () => {
  it('records a scheduled run with ok status, timestamps and duration', async () => {
    db = open();
    const scheduler = makeScheduler(db, [intervalTask('collect', 300)]);

    await expect(scheduler.runPending()).resolves.toEqual(['collect']);

    const runs = listTaskRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      task: 'collect',
      trigger: 'schedule',
      status: 'ok',
      error: null,
    });
    expect(runs[0]?.started_at).toMatch(STRICT_ISO);
    expect(runs[0]?.finished_at).toMatch(STRICT_ISO);
    expect(runs[0]?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(runs[0]?.started_at).toBe('2026-11-26T09:00:00.000000+00:00');

    const state = getTaskState(db, 'collect');
    expect(state?.last_result).toBe('ok');
    expect(state?.last_run_at).toBe('2026-11-26T09:00:00.000000+00:00');
  });

  it('records a failing scheduled run and keeps the failure semantics', async () => {
    db = open();
    const scheduler = makeScheduler(db, [
      intervalTask('collect', 300, () => {
        throw new Error('boom');
      }),
    ]);

    await expect(scheduler.runPending()).resolves.toEqual(['collect']);

    const runs = listTaskRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      task: 'collect',
      trigger: 'schedule',
      status: 'error',
      error: 'error: Error: boom',
    });
    expect(runs[0]?.duration_ms).toBeGreaterThanOrEqual(0);

    // The failing task still consumes its slot: last_result is the error text
    // and last_run_at is the tick instant.
    const state = getTaskState(db, 'collect');
    expect(state?.last_result).toBe('error: Error: boom');
    expect(state?.last_run_at).toBe('2026-11-26T09:00:00.000000+00:00');
  });

  it('truncates run errors to MAX_RESULT_LENGTH', async () => {
    db = open();
    const longMessage = 'x'.repeat(700);
    const scheduler = makeScheduler(db, [
      intervalTask('collect', 300, () => {
        throw new Error(longMessage);
      }),
    ]);

    await scheduler.runPending();

    const state = getTaskState(db, 'collect');
    expect(state?.last_result).toHaveLength(500);
    // task_runs.error is stored with the same truncation.
    expect(listTaskRuns(db)[0]?.error).toHaveLength(500);
  });

  it('runs two due tasks in declaration order and records one row each', async () => {
    db = open();
    const calls: string[] = [];
    const scheduler = makeScheduler(db, [
      intervalTask('first', 60, () => {
        calls.push('first');
        return 'ok';
      }),
      intervalTask('second', 60, () => {
        calls.push('second');
        return 'ok';
      }),
    ]);

    await expect(scheduler.runPending()).resolves.toEqual(['first', 'second']);
    expect(calls).toEqual(['first', 'second']);
    const rows = listTaskRuns(db);
    expect(rows.map((row) => row.task)).toEqual(['second', 'first']); // newest first
    expect(rows.every((row) => row.trigger === 'schedule' && row.status === 'ok')).toBe(true);
  });

  it('skips a task that is not due and writes no run row', async () => {
    db = open();
    const scheduler = makeScheduler(db, [intervalTask('collect', 300)]);
    // Pretend it just ran; the fixed clock is 09:00 and interval is 5 minutes.
    db.prepare(
      'INSERT INTO task_state (task_name, last_run_at, last_result) VALUES (?, ?, ?)',
    ).run('collect', '2026-11-26T08:58:00.000000+00:00', 'ok');

    await expect(scheduler.runPending()).resolves.toEqual([]);
    expect(listTaskRuns(db)).toEqual([]);
  });
});

describe('Scheduler — manual runs and single-flight', () => {
  it('runTaskNow records a manual run row and resolves before completion', async () => {
    db = open();
    const gate = deferred();
    const scheduler = makeScheduler(db, [
      intervalTask('collect', 300, async () => {
        await gate.promise;
        return 'done';
      }),
    ]);

    const { runId } = await scheduler.runTaskNow('collect');
    expect(runId).toBeGreaterThan(0);
    expect(scheduler.isRunning('collect')).toBe(true);
    expect(scheduler.runningTasks()).toEqual(['collect']);

    const runningRow = listTaskRunsForTask(db, 'collect')[0];
    expect(runningRow).toMatchObject({
      id: runId,
      task: 'collect',
      trigger: 'manual',
      status: 'running',
      finished_at: null,
      duration_ms: null,
    });

    gate.resolve();
    await scheduler.waitForIdle();
    expect(scheduler.isRunning('collect')).toBe(false);
    expect(scheduler.runningTasks()).toEqual([]);

    const finishedRow = listTaskRunsForTask(db, 'collect')[0];
    expect(finishedRow?.id).toBe(runId);
    expect(finishedRow?.status).toBe('ok');
    expect(finishedRow?.finished_at).toMatch(STRICT_ISO);
  });

  it('rejects a second runTaskNow while the first is in flight', async () => {
    db = open();
    const gate = deferred();
    let calls = 0;
    const scheduler = makeScheduler(db, [
      intervalTask('collect', 300, async () => {
        calls += 1;
        await gate.promise;
        return 'ok';
      }),
    ]);

    await scheduler.runTaskNow('collect');
    await expect(scheduler.runTaskNow('collect')).rejects.toBeInstanceOf(TaskRunningError);
    await expect(scheduler.runTaskNow('collect')).rejects.toThrow(
      'task already running: collect',
    );
    expect(calls).toBe(1);
    expect(listTaskRunsForTask(db, 'collect')).toHaveLength(1);

    gate.resolve();
    await scheduler.waitForIdle();
    expect(listTaskRunsForTask(db, 'collect')).toHaveLength(1);
  });

  it('runPending skips a task whose manual run is in flight', async () => {
    db = open();
    const gate = deferred();
    let calls = 0;
    const scheduler = makeScheduler(db, [
      intervalTask('collect', 1, async () => {
        calls += 1;
        await gate.promise;
        return 'ok';
      }),
    ]);

    await scheduler.runTaskNow('collect');
    // The task is due (never ran) but the single-flight guard wins.
    await expect(scheduler.runPending()).resolves.toEqual([]);
    expect(calls).toBe(1);
    expect(listTaskRunsForTask(db, 'collect')).toHaveLength(1);

    gate.resolve();
    await scheduler.waitForIdle();
    expect(listTaskRunsForTask(db, 'collect')[0]?.trigger).toBe('manual');
    expect(listTaskRunsForTask(db, 'collect')[0]?.status).toBe('ok');
    // The slot was not consumed by runPending: task_state now has the manual run.
    expect(getTaskState(db, 'collect')?.last_result).toBe('ok');
  });

  it('throws TaskNotFoundError for an unknown name', async () => {
    db = open();
    const scheduler = makeScheduler(db, [intervalTask('collect', 300)]);

    await expect(scheduler.runTaskNow('nope')).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(scheduler.runTaskNow('nope')).rejects.toThrow('unknown task: nope');
    expect(listTaskRuns(db)).toEqual([]);
  });

  it('runTaskNow ignores the interval and runs a just-completed task', async () => {
    db = open();
    db.prepare(
      'INSERT INTO task_state (task_name, last_run_at, last_result) VALUES (?, ?, ?)',
    ).run('collect', '2026-11-26T08:59:30.000000+00:00', 'ok');
    const scheduler = makeScheduler(db, [intervalTask('collect', 300)]);

    await expect(scheduler.runPending()).resolves.toEqual([]);
    const { runId } = await scheduler.runTaskNow('collect');
    await scheduler.waitForIdle();

    expect(listTaskRuns(db)).toHaveLength(1);
    expect(listTaskRuns(db)[0]).toMatchObject({ id: runId, trigger: 'manual', status: 'ok' });
  });

  it('waitForIdle resolves immediately when nothing is running', async () => {
    db = open();
    const scheduler = makeScheduler(db, [intervalTask('collect', 300)]);
    await expect(scheduler.waitForIdle()).resolves.toBeUndefined();
  });
});

describe('Scheduler — task metadata', () => {
  it('describes interval and calendar schedules', () => {
    db = open();
    const scheduler = makeScheduler(db, [
      intervalTask('seconds', 45),
      intervalTask('minutes', 300),
      intervalTask('hours', 7_200),
      { name: 'daily', calendar: { kind: 'daily', hhmm: '09:00' }, run: () => 'ok' },
      {
        name: 'weekly',
        calendar: { kind: 'weekly', hhmm: '16:00', weekday: 4 },
        run: () => 'ok',
      },
    ]);

    const infos = scheduler.taskInfos();
    expect(infos.map((info) => [info.name, info.schedule])).toEqual([
      ['seconds', '每 45 秒'],
      ['minutes', '每 5 分钟'],
      ['hours', '每 2 小时'],
      ['daily', '每天 09:00'],
      ['weekly', '每周五 16:00'],
    ]);
    expect(infos[0]).toMatchObject({
      kind: 'interval',
      interval_seconds: 45,
      hhmm: null,
      weekday: null,
      running: false,
    });
    expect(infos[3]).toMatchObject({
      kind: 'daily',
      interval_seconds: null,
      hhmm: '09:00',
      weekday: null,
    });
    expect(infos[4]).toMatchObject({ kind: 'weekly', weekday: 4 });
  });

  it('projects next_run_at from the last run and reports overdue as now', async () => {
    db = open();
    const scheduler = makeScheduler(db, [intervalTask('collect', 300)]);

    // Never ran: the next tick picks it up, so "now".
    expect(scheduler.taskInfos()[0]?.next_run_at).toBe('2026-11-26T09:00:00.000000+00:00');

    await scheduler.runPending();
    expect(scheduler.taskInfos()[0]?.next_run_at).toBe('2026-11-26T09:05:00.000000+00:00');

    // A stale last run (before now) is overdue → "now".
    db.prepare(
      'UPDATE task_state SET last_run_at = ? WHERE task_name = ?',
    ).run('2026-11-26T08:00:00.000000+00:00', 'collect');
    expect(scheduler.taskInfos()[0]?.next_run_at).toBe('2026-11-26T09:00:00.000000+00:00');
  });

  it('exposes running state while a run is in flight', async () => {
    db = open();
    const gate = deferred();
    const scheduler = makeScheduler(db, [
      intervalTask('collect', 300, async () => {
        await gate.promise;
        return 'ok';
      }),
    ]);

    expect(scheduler.taskInfos()[0]?.running).toBe(false);
    await scheduler.runTaskNow('collect');
    expect(scheduler.taskInfos()[0]?.running).toBe(true);
    expect(scheduler.runningTasks()).toEqual(['collect']);

    gate.resolve();
    await scheduler.waitForIdle();
    expect(scheduler.taskInfos()[0]?.running).toBe(false);
  });
});