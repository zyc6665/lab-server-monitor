/**
 * Integration tests for the task center (`tasks.html` page + the two
 * `/api/system/tasks` endpoints).
 *
 * Each case builds the real middleware chain through {@link createWebApp} on a
 * fresh in-memory SQLite database, with DPAPI replaced by an identity stub so
 * the admin credential can be seeded without the Windows key store.
 */
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/storage/dpapi', () => ({
  dpapiAvailable: () => true,
  protect: (buffer: Buffer) => Buffer.from(buffer),
  unprotect: (buffer: Buffer) => Buffer.from(buffer),
  DpapiUnavailableError: class DpapiUnavailableError extends Error {},
}));

import type { AppConfig } from '../../src/config/config';
import { Scheduler, type ScheduledTask } from '../../src/runtime/scheduler';
import { openDatabase } from '../../src/storage/db';
import { initSchema } from '../../src/storage/schema';
import { createWebApp } from '../../src/web/app';
import { setAdminPassword } from '../../src/web/routes/auth';
import {
  registerTasksRoutes,
  type TasksSchedulerSource,
  type TasksRouteDeps,
} from '../../src/web/routes/tasks';
import type { SessionManager } from '../../src/web/session';

const CSRF_TOKEN = 'csrf-token-for-tasks-tests';

const openDbs: Array<ReturnType<typeof openDatabase>> = [];

/** In-memory database with the real schema. */
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
      // already closed
    }
  }
});

function makeConfig(): AppConfig {
  return {
    dbPath: ':memory:',
    host: '127.0.0.1',
    port: 0,
    dataDir: '',
    logDir: '',
    servers: [],
    appVersion: 'test',
  };
}

/** One interval task fixture. */
function intervalTask(
  name: string,
  run: () => string | Promise<string> = () => 'ok',
): ScheduledTask {
  return { name, intervalSeconds: 300, run };
}

/** A promise plus its external resolve, used to hold a run in flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface Harness {
  db: ReturnType<typeof openDatabase>;
  app: Express;
  cookie: string;
  scheduler: Scheduler;
}

function setup(options: {
  authenticate?: boolean;
  tasks?: ScheduledTask[];
  scheduler?: (db: ReturnType<typeof openDatabase>) => TasksSchedulerSource;
} = {}): Harness {
  const db = memoryDb();
  setAdminPassword(db, { newPassword: 'admin-password-1', username: 'admin' });
  const config = makeConfig();
  const scheduler = new Scheduler(options.tasks ?? [], { db, tz: 'UTC' });
  const deps: TasksRouteDeps = {
    db,
    config,
    appVersion: 'test',
    scheduler: options.scheduler ? options.scheduler(db) : scheduler,
  };
  const app = createWebApp({
    db,
    config,
    mountStatic: false,
    registerRoutes: (instance: Express) => {
      registerTasksRoutes(instance, deps);
    },
  });
  const cookie =
    options.authenticate === false
      ? ''
      : (app.locals.session as SessionManager).createCookie({
          logged_in: true,
          username: 'admin',
          csrf_token: CSRF_TOKEN,
        });
  return { db, app, cookie, scheduler };
}

describe('tasks routes — authentication and CSRF', () => {
  it('returns 401 for the list API when unauthenticated', async () => {
    const harness = setup({ authenticate: false });
    const res = await request(harness.app).get('/api/system/tasks');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  it('redirects the page to /login when unauthenticated', async () => {
    const harness = setup({ authenticate: false });
    const res = await request(harness.app).get('/tasks');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('rejects a manual trigger without a CSRF token', async () => {
    const harness = setup({ tasks: [intervalTask('collect')] });
    const res = await request(harness.app)
      .post('/api/system/tasks/collect/run')
      .set('Cookie', harness.cookie);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'csrf_failed',
      message: '页面已过期，请刷新页面后重试',
    });
  });
});

describe('tasks routes — page', () => {
  it('renders tasks.html with the task-center headings', async () => {
    const harness = setup();
    const res = await request(harness.app).get('/tasks').set('Cookie', harness.cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('任务');
    expect(res.text).toContain('定时任务');
    // Table headers of the task-center table.
    for (const header of ['任务', '调度', '上次运行', '上次结果', '状态']) {
      expect(res.text).toContain(header);
    }
    expect(res.text).toContain('/static/pages/tasks.js');
  });
});

describe('tasks routes — GET /api/system/tasks', () => {
  it('returns an empty list when no scheduler is wired', async () => {
    const harness = setup({ scheduler: () => null });
    const res = await request(harness.app)
      .get('/api/system/tasks')
      .set('Cookie', harness.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tasks: [] });
  });

  it('lists registered tasks with schedule metadata and null run info', async () => {
    const harness = setup({ tasks: [intervalTask('collect')] });
    const res = await request(harness.app)
      .get('/api/system/tasks')
      .set('Cookie', harness.cookie);

    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0]).toEqual({
      name: 'collect',
      schedule: '每 5 分钟',
      next_run_at: expect.any(String),
      last_run_at: null,
      last_result: null,
      running: false,
      last_duration_ms: null,
    });
  });

  it('reports last run info after a scheduler run', async () => {
    const harness = setup({ tasks: [intervalTask('collect')] });
    await harness.scheduler.runPending();

    const res = await request(harness.app)
      .get('/api/system/tasks')
      .set('Cookie', harness.cookie);
    expect(res.status).toBe(200);
    expect(res.body.tasks[0]).toMatchObject({
      name: 'collect',
      last_result: 'ok',
      running: false,
    });
    expect(res.body.tasks[0].last_run_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof res.body.tasks[0].last_duration_ms).toBe('number');
  });
});

describe('tasks routes — POST /api/system/tasks/:name/run', () => {
  it('accepts a manual trigger with 202 and a run id', async () => {
    const harness = setup({ tasks: [intervalTask('collect')] });

    const res = await request(harness.app)
      .post('/api/system/tasks/collect/run')
      .set('Cookie', harness.cookie)
      .set('X-CSRF-Token', CSRF_TOKEN);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, run_id: expect.any(Number) });
    expect(res.body.run_id).toBeGreaterThan(0);
    await harness.scheduler.waitForIdle();
  });

  it('returns 404 unknown_task for an unregistered name', async () => {
    const harness = setup({ tasks: [intervalTask('collect')] });

    const res = await request(harness.app)
      .post('/api/system/tasks/nope/run')
      .set('Cookie', harness.cookie)
      .set('X-CSRF-Token', CSRF_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unknown_task' });
  });

  it('returns 409 task_running while the task is in flight', async () => {
    const gate = deferred();
    const harness = setup({
      tasks: [
        intervalTask('collect', async () => {
          await gate.promise;
          return 'ok';
        }),
      ],
    });

    const first = await request(harness.app)
      .post('/api/system/tasks/collect/run')
      .set('Cookie', harness.cookie)
      .set('X-CSRF-Token', CSRF_TOKEN);
    expect(first.status).toBe(202);

    const second = await request(harness.app)
      .post('/api/system/tasks/collect/run')
      .set('Cookie', harness.cookie)
      .set('X-CSRF-Token', CSRF_TOKEN);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: 'task_running',
      message: '任务正在运行，请稍后再试',
    });

    // The list API reflects the in-flight run.
    const listing = await request(harness.app)
      .get('/api/system/tasks')
      .set('Cookie', harness.cookie);
    expect(listing.body.tasks[0].running).toBe(true);

    gate.resolve();
    await harness.scheduler.waitForIdle();

    const after = await request(harness.app)
      .get('/api/system/tasks')
      .set('Cookie', harness.cookie);
    expect(after.body.tasks[0].running).toBe(false);
    expect(after.body.tasks[0].last_result).toBe('ok');
  });

  it('returns 503 scheduler_unavailable without a scheduler', async () => {
    const harness = setup({ scheduler: () => null });
    const res = await request(harness.app)
      .post('/api/system/tasks/collect/run')
      .set('Cookie', harness.cookie)
      .set('X-CSRF-Token', CSRF_TOKEN);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('scheduler_unavailable');
  });

  it('records a manual run row and refreshes task_state', async () => {
    const harness = setup({ tasks: [intervalTask('collect')] });
    const res = await request(harness.app)
      .post('/api/system/tasks/collect/run')
      .set('Cookie', harness.cookie)
      .set('X-CSRF-Token', CSRF_TOKEN);
    expect(res.status).toBe(202);
    await harness.scheduler.waitForIdle();

    const rows = harness.db
      .prepare('SELECT task, trigger, status FROM task_runs')
      .all() as Array<{ task: string; trigger: string; status: string }>;
    expect(rows).toEqual([{ task: 'collect', trigger: 'manual', status: 'ok' }]);

    // The manual run refreshed task_state.last_run_at and last_result.
    const state = harness.db
      .prepare('SELECT last_run_at, last_result FROM task_state WHERE task_name = ?')
      .get('collect') as { last_run_at: string; last_result: string } | undefined;
    expect(state?.last_run_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(state?.last_result).toBe('ok');
  });
});