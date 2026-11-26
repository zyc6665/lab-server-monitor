/**
 * 任务中心 (task center) — Track B of the P1 module-optimization plan (§6 P1-2).
 *
 *   GET  /api/system/tasks            list scheduled tasks + last run info
 *   POST /api/system/tasks/:name/run  single-flight manual trigger (202)
 *   GET  /tasks                       admin task-center page (`tasks.html`)
 *
 * The scheduler is created by `server.ts` *after* the web app exists, so
 * `scheduler` accepts either a direct instance, `null`, or a late-bound getter
 * (`() => scheduler | null`). Without a scheduler the list API returns an
 * empty task list and the trigger API answers `503 scheduler_unavailable`.
 *
 * Middleware (setup / CSRF / auth / admin user-mode) is installed by
 * `createWebApp` / `createServerApp`; this module only registers handlers.
 */
import type { Express, Request, Response } from 'express';

import type { AppConfig } from '../../config/config';
import {
  TaskNotFoundError,
  TaskRunningError,
  type ScheduledTaskInfo,
} from '../../runtime/scheduler';
import { latestRunByTask, type TaskRunRow } from '../../storage/task-runs';
import { listTaskStates, type TaskStateRow } from '../../storage/tasks';
import { createTemplating, type Templating } from '../templating';
import { ENDPOINTS } from './registry';

type SqliteDatabase = import('better-sqlite3').Database;

/** The scheduler surface used by these routes (the `Scheduler` class matches). */
export interface TasksScheduler {
  /** Registered tasks with cadence / next-run metadata. */
  taskInfos(): ScheduledTaskInfo[];
  /** Whether a task currently has a run in flight. */
  isRunning(name: string): boolean;
  /** Manual trigger; resolves once the run has started. */
  runTaskNow(name: string): Promise<{ runId: number }>;
}

/** A scheduler instance, `null`, or a late-bound getter for either. */
export type TasksSchedulerSource =
  | TasksScheduler
  | null
  | (() => TasksScheduler | null);

/** Injected dependencies for {@link registerTasksRoutes}. */
export interface TasksRouteDeps {
  /** Open SQLite handle (`task_state` + `task_runs`). */
  db: SqliteDatabase;
  /** Scheduler source (late-bound getter recommended from `server.ts`). */
  scheduler: TasksSchedulerSource;
  /** Resolved runtime config; only used for the app version fallback. */
  config?: AppConfig;
  /** Pre-built templating bundle (defaults to a fresh one). */
  templating?: Templating;
  /** `APP_VERSION` used by the templating bundle when `templating` is absent. */
  appVersion?: string;
}

/** One row of `GET /api/system/tasks`. */
export interface TaskSummary {
  name: string;
  schedule: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_result: string | null;
  running: boolean;
  last_duration_ms: number | null;
}

/** Resolve the (possibly late-bound) scheduler for one request. */
function resolveScheduler(deps: TasksRouteDeps): TasksScheduler | null {
  const source = deps.scheduler;
  if (typeof source === 'function') {
    return source();
  }
  return source;
}

/** True for {@link TaskRunningError} — name-based check survives stub schedulers. */
function isTaskRunningError(err: unknown): boolean {
  return (
    err instanceof TaskRunningError ||
    (err instanceof Error && err.name === 'TaskRunningError')
  );
}

/** True for {@link TaskNotFoundError} — name-based check survives stub schedulers. */
function isTaskNotFoundError(err: unknown): boolean {
  return (
    err instanceof TaskNotFoundError ||
    (err instanceof Error && err.name === 'TaskNotFoundError')
  );
}

/** Merge scheduler metadata with persisted task state + latest run row. */
function buildTaskSummaries(
  db: SqliteDatabase,
  scheduler: TasksScheduler | null,
): TaskSummary[] {
  if (scheduler === null) {
    return [];
  }
  const states = new Map<string, TaskStateRow>();
  for (const row of listTaskStates(db)) {
    states.set(row.task_name, row);
  }
  const latest: Record<string, TaskRunRow> = latestRunByTask(db);
  return scheduler.taskInfos().map((info) => {
    const state = states.get(info.name);
    const lastRun = latest[info.name];
    return {
      name: info.name,
      schedule: info.schedule,
      next_run_at: info.next_run_at,
      last_run_at: state?.last_run_at ? state.last_run_at : null,
      last_result: state?.last_result ?? null,
      running: info.running || scheduler.isRunning(info.name),
      last_duration_ms: lastRun?.duration_ms ?? null,
    };
  });
}

/** `{name}` → `:name` (Express 5 route syntax). */
function routePath(template: string): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ':$1');
}

/** Wrap an async handler so rejections reach the Express error handler. */
function wrap(
  fn: (req: Request, res: Response) => unknown,
): (req: Request, res: Response, next: (err?: unknown) => void) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

/**
 * Registers the task-center page, the listing API and the manual-trigger API.
 *
 * @param app  Express application (middleware chain already installed).
 * @param deps Open DB handle plus a (possibly late-bound) scheduler.
 */
export function registerTasksRoutes(app: Express, deps: TasksRouteDeps): void {
  const templating =
    deps.templating ??
    createTemplating({ appVersion: deps.appVersion ?? deps.config?.appVersion });

  app.get(ENDPOINTS.tasks_page, (_req, res) => {
    templating.renderPage(res, 'tasks.html', { active_page: 'tasks' });
  });

  app.get(ENDPOINTS.api_system_tasks, (_req, res) => {
    res.json({ tasks: buildTaskSummaries(deps.db, resolveScheduler(deps)) });
  });

  app.post(
    routePath(ENDPOINTS.api_run_system_task),
    wrap(async (req, res) => {
      const scheduler = resolveScheduler(deps);
      if (scheduler === null) {
        res.status(503).json({
          error: 'scheduler_unavailable',
          message: '调度器尚未启动',
        });
        return;
      }
      const name = String(req.params.name ?? '');
      try {
        const { runId } = await scheduler.runTaskNow(name);
        res.status(202).json({ ok: true, run_id: runId });
      } catch (err) {
        if (isTaskNotFoundError(err)) {
          res.status(404).json({ error: 'unknown_task' });
          return;
        }
        if (isTaskRunningError(err)) {
          res.status(409).json({
            error: 'task_running',
            message: '任务正在运行，请稍后再试',
          });
          return;
        }
        throw err;
      }
    }),
  );
}