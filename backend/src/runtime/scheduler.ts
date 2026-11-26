/**
 * Interval / calendar task scheduler — a line-for-line port of the
 * `ScheduledTask` + `Scheduler` half of `servermanage/scheduler.py:261-457`.
 *
 * Design parity with the Python oracle
 * ------------------------------------
 * - A task is either an **interval task** (`intervalSeconds`) or a **calendar
 *   task** (`calendar` = daily / weekly at `HH:MM`). Interval tasks use
 *   {@link shouldRun}; calendar tasks use {@link isReportDue} against a target
 *   computed from the last run (catch-up) or the current period (fresh
 *   install), exactly like `Scheduler._is_due`.
 * - State lives in the `task_state` table via {@link getTaskState} /
 *   {@link setTaskState}. `last_run_at` is written as a UTC ISO string
 *   (`nowIsoUtc`, `…+00:00`); read back through `parseIsoOrNull` and projected
 *   into the configured wall clock with `toLocalWall`.
 * - One failing task never aborts the others: the due check *and* the run both
 *   live inside a per-task guard, the failure is written to `last_result` as
 *   `error: <Type>: <msg>` (truncated to 500 chars) and the slot is still
 *   consumed (`last_run_at` is recorded).
 * - The background loop is a `setInterval` tick (clamped to 1…60 s) whose timer
 *   is `unref()`-ed so it never keeps the process alive on its own.
 *
 * ## Time representation
 *
 * `now()` returns a real instant (`Date`). The pure helpers imported from
 * `./schedule-time` work in the "civil wall clock" domain, so every call site
 * converts an instant with `toLocalWall(instant, tz)`, and converts a stored
 * timestamp with `parseIsoOrNull` first (naive strings are already civil wall
 * dates; offset-bearing strings are instants that need `toLocalWall`).
 */
import {
  computeDailyFire,
  computeWeeklyFire,
  currentPeriodTarget,
  isReportDue,
  normalizeDt,
  parseIsoOrNull,
  shouldRun,
  toLocalWall,
} from './schedule-time';
import {
  recordTaskRunFinish,
  recordTaskRunStart,
  type TaskRunTrigger,
} from '../storage/task-runs';
import { getTaskState, setTaskState } from '../storage/tasks';
import { nowIsoUtc } from '../storage/time';

type SqliteDatabase = import('better-sqlite3').Database;

/** Smallest / largest allowed tick, in milliseconds (Python 1…60 seconds). */
export const MIN_TICK_MS = 1_000;
export const MAX_TICK_MS = 60_000;

/** Longest failure text persisted to `task_state.last_result` (Python `_MAX_RESULT_LENGTH`). */
export const MAX_RESULT_LENGTH = 500;

/** Calendar cadence for a report task. */
export interface CalendarSpec {
  kind: 'daily' | 'weekly';
  /** Fire time as `"HH:MM"` local wall clock. */
  hhmm: string;
  /** Python weekday (Monday = 0 … Sunday = 6); required when `kind === 'weekly'`. */
  weekday?: number;
}

/**
 * One task the scheduler can run.
 *
 * `intervalSeconds` drives plain interval tasks; `calendar` switches the due
 * check to report semantics. Exactly one of them is expected to be set.
 * `run` may be synchronous or async; its return value is advisory (the success
 * marker persisted to `last_result` is always `"ok"`, mirroring Python).
 */
export interface ScheduledTask {
  name: string;
  intervalSeconds?: number;
  calendar?: CalendarSpec;
  run: () => Promise<string> | string;
}

/** Construction options for {@link Scheduler}. */
export interface SchedulerOptions {
  /** SQLite handle holding the `task_state` table. */
  db: SqliteDatabase;
  /** IANA time zone used to interpret report targets and stored wall clocks. */
  tz: string;
  /** Injectable clock returning the current instant. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Background tick in milliseconds; clamped to 1_000…60_000. Defaults to the smallest positive task interval. */
  tickMs?: number;
}

/** Thrown by {@link Scheduler.runTaskNow} when the task is already in flight. */
export class TaskRunningError extends Error {
  /** Name of the task that is currently running. */
  readonly task: string;

  constructor(task: string) {
    super(`task already running: ${task}`);
    this.name = 'TaskRunningError';
    this.task = task;
  }
}

/** Thrown by {@link Scheduler.runTaskNow} for a name the scheduler does not know. */
export class TaskNotFoundError extends Error {
  /** The unknown task name. */
  readonly task: string;

  constructor(task: string) {
    super(`unknown task: ${task}`);
    this.name = 'TaskNotFoundError';
    this.task = task;
  }
}

/**
 * Public description of one scheduled task, consumed by the task-center API
 * (`GET /api/system/tasks`).
 *
 * `schedule` is display text; the structured fields (`kind`, `interval_seconds`,
 * `hhmm`, `weekday`) let a client format it differently if needed.
 */
export interface ScheduledTaskInfo {
  name: string;
  /** Human-readable cadence, e.g. `每 5 分钟`, `每天 09:00`, `每周五 16:00`. */
  schedule: string;
  /** Which cadence source is set: bare interval, daily or weekly calendar. */
  kind: 'interval' | 'daily' | 'weekly';
  /** Interval length in seconds (null for calendar tasks). */
  interval_seconds: number | null;
  /** Local wall-clock `HH:MM` (null for interval tasks). */
  hhmm: string | null;
  /** Python weekday, Monday = 0 (null unless weekly). */
  weekday: number | null;
  /** Whether a run is in flight right now. */
  running: boolean;
  /**
   * Best-effort next due instant (UTC ISO string, `null` when the schedule is
   * malformed or cannot be projected). Approximation: when the task is already
   * overdue this returns "now" because the next tick will pick it up.
   */
  next_run_at: string | null;
}

/** A started run: its row id plus the promise that settles when it finishes. */
interface StartedRun {
  runId: number;
  done: Promise<void>;
}

/** Clamp a tick value into the allowed 1…60 s window. */
function clampTick(ms: number): number {
  return Math.max(MIN_TICK_MS, Math.min(ms, MAX_TICK_MS));
}

/** True when an ISO string carries an explicit offset (`Z` or `±HH:MM`). */
const AWARE_SUFFIX_RE = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Convert a stored `last_run_at` string into a civil wall-clock `Date` in `tz`.
 *
 * - Naive strings (`parseIsoOrNull` returns a civil Date) are already the local
 *   wall clock — returned unchanged, matching Python's `replace(tzinfo=tz)`.
 * - Offset-bearing strings are real instants — projected with `toLocalWall`.
 *
 * Returns `null` for an empty/unparseable value (treated as "never ran").
 */
function storedToLocalWall(value: string, tz: string): Date | null {
  const parsed = parseIsoOrNull(value);
  if (parsed === null) {
    return null;
  }
  return AWARE_SUFFIX_RE.test(value.trim()) ? toLocalWall(parsed, tz) : parsed;
}

/**
 * Runs due tasks and persists their state in `task_state`.
 *
 * Tasks are evaluated in order; each task's state is read before deciding so a
 * task never runs twice within one `runPending()` call. Failures are isolated
 * per task.
 */
export class Scheduler {
  private readonly tasks: ScheduledTask[];
  private readonly db: SqliteDatabase;
  private readonly tz: string;
  private readonly now: () => Date;
  private readonly _tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** Names whose task body is currently executing (single-flight guard). */
  private readonly running = new Set<string>();
  /** Detached run promises (manual triggers) awaited by {@link waitForIdle}. */
  private readonly pending = new Set<Promise<void>>();

  constructor(tasks: ScheduledTask[], options: SchedulerOptions) {
    this.tasks = [...tasks];
    this.db = options.db;
    this.tz = options.tz;
    this.now = options.now ?? (() => new Date());
    this._tickMs = clampTick(
      options.tickMs ?? Scheduler.defaultTick(this.tasks),
    );
  }

  /** Effective background tick in milliseconds. */
  get tickMs(): number {
    return this._tickMs;
  }

  /**
   * Run every task that is due, in declaration order, and return the names of
   * the tasks invoked (whether they succeeded or threw). Mirrors
   * `Scheduler.run_pending` (`scheduler.py:321-352`).
   */
  async runPending(): Promise<string[]> {
    const invoked: string[] = [];
    const instant = this.now();
    const nowLocal = toLocalWall(instant, this.tz);

    for (const task of this.tasks) {
      // Single-flight: a manual trigger (or an overlapping cycle) already owns
      // this task; skip it without consuming its slot.
      if (this.running.has(task.name)) {
        continue;
      }
      const lastRunAt = this.readLastRunAt(task.name);
      try {
        // The due check itself is guarded: a malformed schedule (e.g. "25:99")
        // must only fail this task, never abort later healthy tasks.
        if (!this.isDue(task, nowLocal, lastRunAt)) {
          continue;
        }
      } catch (exc) {
        if (!invoked.includes(task.name)) {
          invoked.push(task.name);
        }
        this.record(task.name, instant, describeError(exc));
        continue;
      }

      let started: StartedRun;
      try {
        started = this.startTask(task, 'schedule', instant);
      } catch {
        // Bookkeeping failure (e.g. an uninitialised task_runs table): leave
        // the slot unconsumed so the next tick retries instead of silently
        // marking the task as run.
        continue;
      }
      if (!invoked.includes(task.name)) {
        invoked.push(task.name);
      }
      await started.done;
    }

    return invoked;
  }

  /**
   * Whether `name` currently has a run in flight.
   *
   * The set is in-process only: it covers the background loop and manual
   * triggers in this Node process (single-process deployment).
   */
  isRunning(name: string): boolean {
    return this.running.has(name);
  }

  /** Names with a run in flight right now (insertion order). */
  runningTasks(): string[] {
    return [...this.running];
  }

  /**
   * Public description of every registered task for the task-center API.
   *
   * `next_run_at` is a best-effort projection (see {@link ScheduledTaskInfo}).
   */
  taskInfos(): ScheduledTaskInfo[] {
    const instant = this.now();
    const nowLocal = toLocalWall(instant, this.tz);
    return this.tasks.map((task) => {
      const lastRunAt = this.readLastRunAt(task.name);
      return {
        name: task.name,
        schedule: describeSchedule(task),
        kind: task.calendar?.kind ?? 'interval',
        interval_seconds: task.calendar === undefined ? task.intervalSeconds ?? 0 : null,
        hhmm: task.calendar?.hhmm ?? null,
        weekday: task.calendar?.weekday ?? null,
        running: this.running.has(task.name),
        next_run_at: this.nextRunAt(task, instant, nowLocal, lastRunAt),
      };
    });
  }

  /**
   * Trigger `name` immediately, recording a `manual` run row.
   *
   * Resolves as soon as the run row exists and the task body has been started;
   * completion is recorded asynchronously in `task_runs` / `task_state` (use
   * {@link waitForIdle} to await it). Rejects with {@link TaskRunningError} when
   * the task is already in flight and {@link TaskNotFoundError} for an unknown
   * name.
   */
  async runTaskNow(name: string): Promise<{ runId: number }> {
    const task = this.tasks.find((candidate) => candidate.name === name);
    if (task === undefined) {
      throw new TaskNotFoundError(name);
    }
    const { runId, done } = this.startTask(task, 'manual', this.now());
    this.track(done);
    return { runId };
  }

  /**
   * Resolves once no detached (manual) run is in flight.
   *
   * Intended for tests and orderly shutdown; the background tick is awaited by
   * {@link stop} only through its own timer clearing.
   */
  async waitForIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  /**
   * Start the background loop (idempotent). The interval is `unref()`-ed so it
   * does not, by itself, keep the Node event loop alive.
   */
  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tickOnce();
    }, this._tickMs);
    this.timer.unref?.();
  }

  /** Stop the background loop (idempotent). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Whether `task` is due at the civil wall-clock instant `nowLocal`.
   *
   * `lastRunAt` defaults to the value persisted in `task_state` for the task;
   * pass it explicitly to reuse a value already read. Mirrors
   * `Scheduler._is_due` (`scheduler.py:392-419`).
   */
  isDue(
    task: ScheduledTask,
    nowLocal: Date,
    lastRunAt: Date | null = this.readLastRunAt(task.name),
  ): boolean {
    if (task.calendar !== undefined) {
      const { kind, hhmm, weekday } = task.calendar;
      const spacingDays = kind === 'daily' ? 1 : 7;
      let targetLocal: Date;
      if (lastRunAt !== null) {
        // The first occurrence strictly after the last run: the missed slot.
        targetLocal =
          kind === 'daily'
            ? computeDailyFire(lastRunAt, hhmm)
            : computeWeeklyFire(lastRunAt, requireWeekday(weekday), hhmm);
      } else {
        // Never ran: reconcile against the current period's occurrence.
        targetLocal = currentPeriodTarget(
          nowLocal,
          spacingDays,
          hhmm,
          weekday,
        );
      }
      return isReportDue(nowLocal, lastRunAt, targetLocal);
    }
    return shouldRun(lastRunAt, nowLocal, task.intervalSeconds ?? 0);
  }

  /**
   * Default tick, in milliseconds: the smallest positive interval (clamped to
   * 1…60 s), or 60 s when no task has a positive interval. Mirrors
   * `Scheduler._default_tick` (`scheduler.py:449-457`).
   */
  static defaultTick(tasks: ScheduledTask[]): number {
    const positive = tasks
      .map((task) => task.intervalSeconds)
      .filter((seconds): seconds is number => typeof seconds === 'number' && seconds > 0)
      .map((seconds) => seconds * 1_000);
    const base = positive.length > 0 ? Math.min(...positive) : MAX_TICK_MS;
    return clampTick(base);
  }

  // -- internals ---------------------------------------------------------

  /** Read + convert the stored `last_run_at`, treating any error as "never ran". */
  private readLastRunAt(name: string): Date | null {
    try {
      const state = getTaskState(this.db, name);
      if (!state) {
        return null;
      }
      return storedToLocalWall(state.last_run_at, this.tz);
    } catch {
      // Cannot read state: treat as never run so a transient DB problem never
      // permanently skips the task (Python catches sqlite3.Error the same way).
      return null;
    }
  }

  /** Persist a run outcome; recording failures are swallowed (Python logs + continues). */
  private record(name: string, instant: Date, result: string): void {
    try {
      setTaskState(this.db, name, {
        lastRunAt: nowIsoUtc(instant),
        lastResult: result.slice(0, MAX_RESULT_LENGTH),
      });
    } catch {
      // ignore — a record failure must not abort the run loop
    }
  }

  /** One tick of the background loop; never rejects, never overlaps itself. */
  private async tickOnce(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.runPending();
    } catch {
      // The loop must never die on a failed cycle (Python `_loop`).
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Start one run: enforce single-flight, insert the `task_runs` row, then
   * invoke the body.
   *
   * Throws {@link TaskRunningError} for a duplicate start. A `task_runs` insert
   * failure propagates before the body executes (the caller decides whether to
   * skip or surface it).
   */
  private startTask(
    task: ScheduledTask,
    trigger: TaskRunTrigger,
    instant: Date,
  ): StartedRun {
    if (this.running.has(task.name)) {
      throw new TaskRunningError(task.name);
    }
    const runId = recordTaskRunStart(this.db, {
      task: task.name,
      trigger,
      startedAt: nowIsoUtc(this.now()),
    });
    this.running.add(task.name);
    return { runId, done: this.completeTask(task, runId, instant) };
  }

  /** Run the body, persist the outcome, release the single-flight slot. */
  private completeTask(
    task: ScheduledTask,
    runId: number,
    instant: Date,
  ): Promise<void> {
    return (async () => {
      try {
        let failed = false;
        let result = 'ok';
        try {
          await task.run();
        } catch (exc) {
          failed = true;
          result = describeError(exc);
        }
        this.finishRun(
          runId,
          failed
            ? { status: 'error', error: result.slice(0, MAX_RESULT_LENGTH) }
            : { status: 'ok' },
        );
        this.record(task.name, instant, result);
      } finally {
        this.running.delete(task.name);
      }
    })();
  }

  /** Complete the `task_runs` row; recording failures are swallowed. */
  private finishRun(
    runId: number,
    input: { status: 'ok' | 'error'; error?: string },
  ): void {
    try {
      recordTaskRunFinish(this.db, runId, {
        ...input,
        finishedAt: nowIsoUtc(this.now()),
      });
    } catch {
      // ignore — run bookkeeping must never abort the scheduler loop
    }
  }

  /** Track a detached run so {@link waitForIdle} can await it. */
  private track(done: Promise<void>): void {
    const entry: Promise<void> = done.then(
      () => {
        this.pending.delete(entry);
      },
      () => {
        this.pending.delete(entry);
      },
    );
    this.pending.add(entry);
  }

  /**
   * Best-effort next due projection, as a UTC ISO string.
   *
   * Interval tasks fire at `last_run_at + interval`; calendar tasks at the
   * first occurrence after the last run (or the current period's occurrence
   * when they never ran). A task that is already overdue reports "now" because
   * the next tick will pick it up. Malformed schedules yield `null` instead of
   * failing the listing API.
   */
  private nextRunAt(
    task: ScheduledTask,
    instant: Date,
    nowLocal: Date,
    lastRunAt: Date | null,
  ): string | null {
    try {
      let target: Date;
      if (task.calendar !== undefined) {
        const { kind, hhmm, weekday } = task.calendar;
        if (lastRunAt !== null) {
          target =
            kind === 'daily'
              ? computeDailyFire(lastRunAt, hhmm)
              : computeWeeklyFire(lastRunAt, requireWeekday(weekday), hhmm);
        } else {
          target = currentPeriodTarget(
            nowLocal,
            kind === 'daily' ? 1 : 7,
            hhmm,
            weekday,
          );
        }
      } else {
        const intervalSeconds = task.intervalSeconds ?? 0;
        if (!(intervalSeconds > 0) || lastRunAt === null) {
          return nowIsoUtc(instant);
        }
        target = new Date(lastRunAt.getTime() + intervalSeconds * 1_000);
      }
      if (target.getTime() <= nowLocal.getTime()) {
        return nowIsoUtc(instant);
      }
      return nowIsoUtc(normalizeDt(target, this.tz));
    } catch {
      return null;
    }
  }
}

/** Chinese weekday labels indexed by Python weekday (Monday = 0). */
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const;

/** Display text for an interval task's cadence. */
function describeInterval(seconds: number): string {
  if (!(seconds > 0)) {
    return '不定时';
  }
  if (seconds % 3_600 === 0) {
    return `每 ${seconds / 3_600} 小时`;
  }
  if (seconds % 60 === 0) {
    return `每 ${seconds / 60} 分钟`;
  }
  return `每 ${seconds} 秒`;
}

/** Display text for a task's cadence (`每 5 分钟` / `每天 09:00` / `每周五 16:00`). */
function describeSchedule(task: ScheduledTask): string {
  if (task.calendar !== undefined) {
    const { kind, hhmm, weekday } = task.calendar;
    if (kind === 'weekly') {
      const label =
        weekday !== undefined && Number.isInteger(weekday) && weekday >= 0 && weekday <= 6
          ? WEEKDAY_LABELS[weekday]
          : '?';
      return `每周${label} ${hhmm}`;
    }
    return `每天 ${hhmm}`;
  }
  return describeInterval(task.intervalSeconds ?? 0);
}

/** Require a weekday for weekly calendars; throw the same shape as the Python oracle. */
function requireWeekday(weekday: number | undefined): number {
  if (weekday === undefined) {
    throw new Error('calendar kind "weekly" requires a weekday');
  }
  return weekday;
}

/**
 * Python `Scheduler._describe_error`: `error: <Type>: <message>`.
 * For non-`Error` throwables fall back to the JS `typeof`.
 */
function describeError(exc: unknown): string {
  if (exc instanceof Error) {
    const type = exc.constructor?.name || exc.name || 'Error';
    return `error: ${type}: ${exc.message}`;
  }
  return `error: ${typeof exc}: ${String(exc)}`;
}
