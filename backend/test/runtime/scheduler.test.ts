import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_RESULT_LENGTH, Scheduler, type ScheduledTask } from '../../src/runtime/scheduler';
import { getTaskState, setTaskState } from '../../src/storage/tasks';

const TASK_STATE_DDL = `
  CREATE TABLE task_state (
    task_name TEXT PRIMARY KEY,
    last_run_at TEXT NOT NULL,
    last_result TEXT
  );
  CREATE TABLE task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL,
    trigger TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    error TEXT,
    duration_ms INTEGER
  );
  CREATE INDEX idx_task_runs_task_started ON task_runs (task, started_at);
  CREATE INDEX idx_task_runs_started ON task_runs (started_at);
`;

const openDbs: Array<InstanceType<typeof Database>> = [];

/** Fresh in-memory DB with the `task_state` schema. */
function makeDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(TASK_STATE_DDL);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  vi.useRealTimers();
});

/** Civil/instant UTC Date builder (tests run with tz 'UTC' unless noted). */
function wall(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

function stateOf(db: InstanceType<typeof Database>, name: string) {
  const row = getTaskState(db, name);
  expect(row, `task_state row for ${name}`).not.toBeNull();
  return row as NonNullable<typeof row>;
}

/** Interval task helper. */
function intervalTask(
  name: string,
  intervalSeconds: number,
  run: () => string | Promise<string> = () => 'ok',
): ScheduledTask {
  return { name, intervalSeconds, run };
}

describe('Scheduler — interval tasks', () => {
  it('runs a never-run interval task on the first tick', async () => {
    const db = makeDb();
    let calls = 0;
    const scheduler = new Scheduler([intervalTask('collect', 300, () => {
      calls += 1;
      return 'ok';
    })], { db, tz: 'UTC', now: () => wall(2026, 11, 26, 9, 0) });

    await expect(scheduler.runPending()).resolves.toEqual(['collect']);
    expect(calls).toBe(1);
    const row = stateOf(db, 'collect');
    expect(row.last_result).toBe('ok');
    // task_state write format: six-digit fraction + explicit +00:00 offset.
    expect(row.last_run_at).toBe('2026-11-26T09:00:00.000000+00:00');
    expect(row.last_run_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/);
  });

  it('does not run again before the interval elapses', async () => {
    const db = makeDb();
    let clock = wall(2026, 11, 26, 9, 0);
    const scheduler = new Scheduler([intervalTask('collect', 300)], {
      db,
      tz: 'UTC',
      now: () => clock,
    });

    await expect(scheduler.runPending()).resolves.toEqual(['collect']);
    clock = wall(2026, 11, 26, 9, 4); // 240 s elapsed
    await expect(scheduler.runPending()).resolves.toEqual([]);
  });

  it('runs again once the interval has elapsed', async () => {
    const db = makeDb();
    let clock = wall(2026, 11, 26, 9, 0);
    const scheduler = new Scheduler([intervalTask('collect', 300)], {
      db,
      tz: 'UTC',
      now: () => clock,
    });

    await scheduler.runPending();
    clock = wall(2026, 11, 26, 9, 5); // exactly 300 s
    await expect(scheduler.runPending()).resolves.toEqual(['collect']);
  });

  it('treats a non-positive interval as always due', async () => {
    const db = makeDb();
    const scheduler = new Scheduler([intervalTask('heartbeat', 0)], {
      db,
      tz: 'UTC',
      now: () => wall(2026, 11, 26, 9, 0),
    });

    await expect(scheduler.runPending()).resolves.toEqual(['heartbeat']);
    await expect(scheduler.runPending()).resolves.toEqual(['heartbeat']);
  });
});

describe('Scheduler — daily calendar tasks', () => {
  const daily = (hhmm = '09:00'): ScheduledTask => ({
    name: 'daily-report',
    calendar: { kind: 'daily', hhmm },
    run: () => 'ok',
  });

  it("waits for today's target on a fresh install", async () => {
    const db = makeDb();
    const scheduler = new Scheduler([daily()], {
      db,
      tz: 'UTC',
      now: () => wall(2026, 11, 26, 8, 0),
    });

    await expect(scheduler.runPending()).resolves.toEqual([]);
  });

  it("fires after today's target on a fresh install", async () => {
    const db = makeDb();
    const scheduler = new Scheduler([daily()], {
      db,
      tz: 'UTC',
      now: () => wall(2026, 11, 26, 9, 30),
    });

    await expect(scheduler.runPending()).resolves.toEqual(['daily-report']);
  });

  it('does not fire twice in the same period', async () => {
    const db = makeDb();
    let clock = wall(2026, 11, 26, 9, 30);
    const scheduler = new Scheduler([daily()], { db, tz: 'UTC', now: () => clock });

    await expect(scheduler.runPending()).resolves.toEqual(['daily-report']);
    clock = wall(2026, 11, 26, 9, 45);
    await expect(scheduler.runPending()).resolves.toEqual([]);
  });

  it('catches up exactly once after several missed days', async () => {
    const db = makeDb();
    let clock = wall(2026, 11, 26, 9, 30);
    const scheduler = new Scheduler([daily()], { db, tz: 'UTC', now: () => clock });

    await expect(scheduler.runPending()).resolves.toEqual(['daily-report']);

    // Service was offline for three days; one catch-up run only.
    clock = wall(2026, 11, 29, 10, 0);
    await expect(scheduler.runPending()).resolves.toEqual(['daily-report']);
    await expect(scheduler.runPending()).resolves.toEqual([]);
  });
});

describe('Scheduler — weekly calendar tasks', () => {
  // 2026-11-26 is a Thursday → Python weekday 3.
  const weekly = (weekday = 3): ScheduledTask => ({
    name: 'weekly-report',
    calendar: { kind: 'weekly', hhmm: '09:00', weekday },
    run: () => 'ok',
  });

  it("waits for this week's target before it has passed", async () => {
    const db = makeDb();
    const scheduler = new Scheduler([weekly()], {
      db,
      tz: 'UTC',
      now: () => wall(2026, 11, 26, 8, 0),
    });

    await expect(scheduler.runPending()).resolves.toEqual([]);
  });

  it("fires after this week's target", async () => {
    const db = makeDb();
    const scheduler = new Scheduler([weekly()], {
      db,
      tz: 'UTC',
      now: () => wall(2026, 11, 26, 9, 30),
    });

    await expect(scheduler.runPending()).resolves.toEqual(['weekly-report']);
  });

  it('catches up exactly once across missed weeks', async () => {
    const db = makeDb();
    let clock = wall(2026, 11, 26, 9, 30);
    const scheduler = new Scheduler([weekly()], { db, tz: 'UTC', now: () => clock });

    await expect(scheduler.runPending()).resolves.toEqual(['weekly-report']);

    // Two weeks later (another Thursday): a single catch-up, then quiet.
    clock = wall(2026, 12, 10, 10, 0);
    await expect(scheduler.runPending()).resolves.toEqual(['weekly-report']);
    await expect(scheduler.runPending()).resolves.toEqual([]);
  });
});

describe('Scheduler — failure handling', () => {
  it('records the failure and still consumes the slot', async () => {
    const db = makeDb();
    let clock = wall(2026, 11, 26, 9, 0);
    const scheduler = new Scheduler([
      intervalTask('broken', 600, () => {
        throw new Error('boom');
      }),
    ], { db, tz: 'UTC', now: () => clock });

    await expect(scheduler.runPending()).resolves.toEqual(['broken']);
    const row = stateOf(db, 'broken');
    expect(row.last_result).toBe('error: Error: boom');
    expect(row.last_run_at).toBe('2026-11-26T09:00:00.000000+00:00');

    // The slot is consumed: no re-run before the interval elapses.
    clock = wall(2026, 11, 26, 9, 1);
    await expect(scheduler.runPending()).resolves.toEqual([]);
  });

  it('truncates the persisted error to 500 characters', async () => {
    const db = makeDb();
    const message = 'x'.repeat(1000);
    const scheduler = new Scheduler([
      intervalTask('broken', 600, () => {
        throw new Error(message);
      }),
    ], { db, tz: 'UTC', now: () => wall(2026, 11, 26, 9, 0) });

    await scheduler.runPending();
    const row = stateOf(db, 'broken');
    expect(row.last_result).toHaveLength(MAX_RESULT_LENGTH);
    expect(row.last_result).toBe(`error: Error: ${message}`.slice(0, MAX_RESULT_LENGTH));
  });

  it('does not let a failing task block later tasks', async () => {
    const db = makeDb();
    const order: string[] = [];
    const scheduler = new Scheduler([
      intervalTask('first-bad', 0, () => {
        order.push('first-bad');
        throw new Error('nope');
      }),
      intervalTask('second-good', 0, () => {
        order.push('second-good');
        return 'ok';
      }),
      intervalTask('third-good', 0, () => {
        order.push('third-good');
        return 'ok';
      }),
    ], { db, tz: 'UTC', now: () => wall(2026, 11, 26, 9, 0) });

    await expect(scheduler.runPending()).resolves.toEqual([
      'first-bad',
      'second-good',
      'third-good',
    ]);
    expect(order).toEqual(['first-bad', 'second-good', 'third-good']);
    expect(stateOf(db, 'first-bad').last_result).toMatch(/^error: Error: nope/);
    expect(stateOf(db, 'second-good').last_result).toBe('ok');
    expect(stateOf(db, 'third-good').last_result).toBe('ok');
  });

  it('isolates a malformed calendar schedule to its own task', async () => {
    const db = makeDb();
    const scheduler = new Scheduler([
      // weekly without a weekday → currentPeriodTarget throws during the due check.
      { name: 'bad-schedule', calendar: { kind: 'weekly', hhmm: '09:00' }, run: () => 'ok' },
      intervalTask('healthy', 0),
    ], { db, tz: 'UTC', now: () => wall(2026, 11, 26, 9, 30) });

    await expect(scheduler.runPending()).resolves.toEqual(['bad-schedule', 'healthy']);
    expect(stateOf(db, 'bad-schedule').last_result).toMatch(/^error: Error: /);
    expect(stateOf(db, 'healthy').last_result).toBe('ok');
  });

  it('records a non-Error throwable', async () => {
    const db = makeDb();
    const scheduler = new Scheduler([
      intervalTask('weird', 600, () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'kaboom';
      }),
    ], { db, tz: 'UTC', now: () => wall(2026, 11, 26, 9, 0) });

    await scheduler.runPending();
    expect(stateOf(db, 'weird').last_result).toBe('error: string: kaboom');
  });
});

describe('Scheduler — defaultTick / tick clamping', () => {
  const bare = (intervalSeconds?: number): ScheduledTask => ({
    name: 't',
    intervalSeconds,
    run: () => 'ok',
  });

  it('is the smallest positive interval, in milliseconds', () => {
    expect(Scheduler.defaultTick([bare(300), bare(30), bare(120)])).toBe(30_000);
  });

  it('falls back to 60 s when no task has a positive interval', () => {
    expect(Scheduler.defaultTick([bare(), bare(0), bare(-5)])).toBe(60_000);
  });

  it('clamps a sub-second interval up to 1 s', () => {
    expect(Scheduler.defaultTick([bare(0.2)])).toBe(1_000);
  });

  it('clamps an over-long interval down to 60 s', () => {
    expect(Scheduler.defaultTick([bare(3600)])).toBe(60_000);
  });

  it('clamps an explicit tickMs and derives it from tasks by default', () => {
    const db = makeDb();
    expect(new Scheduler([bare(300)], { db, tz: 'UTC', tickMs: 250 }).tickMs).toBe(1_000);
    expect(new Scheduler([bare(300)], { db, tz: 'UTC', tickMs: 120_000 }).tickMs).toBe(60_000);
    expect(new Scheduler([bare(45)], { db, tz: 'UTC' }).tickMs).toBe(45_000);
  });
});

describe('Scheduler — start / stop', () => {
  it('is idempotent and schedules exactly one timer', () => {
    vi.useFakeTimers();
    const db = makeDb();
    const scheduler = new Scheduler([intervalTask('x', 0)], {
      db,
      tz: 'UTC',
      now: () => wall(2026, 11, 26, 9, 0),
      tickMs: 5000,
    });

    scheduler.start();
    expect(vi.getTimerCount()).toBe(1);
    scheduler.start();
    expect(vi.getTimerCount()).toBe(1);
    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('invokes runPending on each tick', async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const scheduler = new Scheduler([intervalTask('x', 0)], {
      db,
      tz: 'UTC',
      now: () => wall(2026, 11, 26, 9, 0),
      tickMs: 5000,
    });
    const spy = vi.spyOn(scheduler, 'runPending').mockResolvedValue([]);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(spy).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
});

describe('Scheduler — stored last_run_at handling', () => {
  it('interprets a naive stored timestamp as local wall time', async () => {
    const db = makeDb();
    // Naive "09:00" means 09:00 Shanghai (= 01:00Z) in the configured zone.
    setTaskState(db, 'collect', { lastRunAt: '2026-11-26T09:00:00', lastResult: 'ok' });
    let clock = new Date(Date.UTC(2026, 10, 26, 1, 4)); // 09:04 local → 240 s
    const scheduler = new Scheduler([intervalTask('collect', 300)], {
      db,
      tz: 'Asia/Shanghai',
      now: () => clock,
    });

    await expect(scheduler.runPending()).resolves.toEqual([]);
    clock = new Date(Date.UTC(2026, 10, 26, 1, 6)); // 09:06 local → 360 s
    await expect(scheduler.runPending()).resolves.toEqual(['collect']);
  });

  it('projects an offset-bearing stored timestamp into the target zone', async () => {
    const db = makeDb();
    // 01:00Z is 09:00 Shanghai.
    setTaskState(db, 'collect', {
      lastRunAt: '2026-11-26T01:00:00.000000+00:00',
      lastResult: 'ok',
    });
    let clock = new Date(Date.UTC(2026, 10, 26, 1, 4)); // 240 s
    const scheduler = new Scheduler([intervalTask('collect', 300)], {
      db,
      tz: 'Asia/Shanghai',
      now: () => clock,
    });

    await expect(scheduler.runPending()).resolves.toEqual([]);
    clock = new Date(Date.UTC(2026, 10, 26, 1, 6)); // 360 s
    await expect(scheduler.runPending()).resolves.toEqual(['collect']);
  });

  it('honours the configured time zone for calendar targets', async () => {
    const db = makeDb();
    let clock = new Date(Date.UTC(2026, 10, 25, 0, 0)); // 08:00 Shanghai
    const scheduler = new Scheduler([
      { name: 'daily-report', calendar: { kind: 'daily', hhmm: '09:00' }, run: () => 'ok' },
    ], { db, tz: 'Asia/Shanghai', now: () => clock });

    await expect(scheduler.runPending()).resolves.toEqual([]);
    clock = new Date(Date.UTC(2026, 10, 25, 1, 30)); // 09:30 Shanghai
    await expect(scheduler.runPending()).resolves.toEqual(['daily-report']);
  });
});
