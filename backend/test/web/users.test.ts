/**
 * Integration tests for the users routes (P2 Task 14).
 *
 * Every case mounts the full middleware chain through {@link createWebApp} on a
 * fresh temp SQLite database. The scan/refresh worker and the account planner
 * are injected stubs, so no test ever opens a real SSH connection. DPAPI is
 * replaced with an identity stub so the admin credential round-trips without
 * the Windows store.
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

import { createWebApp } from '../../src/web/app';
import {
  registerUsersRoutes,
  type UsersAdminApi,
  type UsersMonitorService,
  type UsersRouteDeps,
} from '../../src/web/routes/users';
import { setAdminPassword } from '../../src/web/routes/auth';
import { saveSection } from '../../src/config/service';
import type { AppConfig, HostConfig } from '../../src/config/config';
import type { SessionManager } from '../../src/web/session';
import {
  appendUserUsageHistory,
  saveHostUserSnapshot,
  saveUserOperation,
  saveUserScanState,
  upsertUserBaseline,
  type UserAccountInput,
} from '../../src/storage/users';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

afterEach(() => {
  cleanupStorageTests();
});

function makeConfig(servers: HostConfig[]): AppConfig {
  return {
    dbPath: '/tmp/users-test.db',
    host: '127.0.0.1',
    port: 0,
    dataDir: '',
    logDir: '',
    servers,
    appVersion: 'test',
  };
}

function makeServer(name: string, host: string, overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    name,
    host,
    port: 22,
    username: 'root',
    auth: { type: 'password' } as never,
    tags: [],
    disk_mounts: ['/', '/data'],
    group: '',
    owner: '',
    location: '',
    notes: '',
    checks: [],
    user_monitoring: true,
    allow_user_write: false,
    ...overrides,
  };
}

interface Harness {
  fresh: FreshDb;
  app: Express;
  cookie: string;
  config: AppConfig;
  get(path: string): request.Test;
  post(path: string): request.Test;
}

/** Builds a fully wired app with `registerUsersRoutes` mounted. */
function setup(
  options: {
    authenticate?: boolean;
    servers?: HostConfig[];
    deps?: Partial<UsersRouteDeps>;
    mode?: 'admin' | 'user';
  } = {},
): Harness {
  const fresh = freshDb();
  setAdminPassword(fresh.db, { newPassword: 'secret-password', username: 'admin' });
  if (options.mode === 'user') {
    saveSection(
      fresh.db,
      'monitoring',
      { mode: 'user', member_account: 'alice' },
      { writable: true },
    );
  }
  const config = makeConfig(options.servers ?? []);
  const app = createWebApp({
    db: fresh.db,
    config,
    mountStatic: false,
    registerRoutes: (instance) => {
      registerUsersRoutes(instance, { db: fresh.db, config, appVersion: 'test', ...(options.deps ?? {}) });
    },
  });
  const cookie =
    options.authenticate === false
      ? ''
      : (app.locals.session as SessionManager).createCookie({
          logged_in: true,
          username: 'admin',
          csrf_token: 'csrf-test',
        });
  return {
    fresh,
    app,
    cookie,
    config,
    get: (path) => request(app).get(path).set('Cookie', cookie),
    post: (path) => request(app).post(path).set('Cookie', cookie).set('X-CSRF-Token', 'csrf-test'),
  };
}

/** Enables the account write master switch in the user_monitoring settings. */
function enableWrite(h: Harness): void {
  saveSection(h.fresh.db, 'user_monitoring', { write_enabled: true }, { writable: true });
}

const ALICE: UserAccountInput = {
  username: 'alice',
  uid: 1001,
  gid: 1001,
  primary_group: 'alice',
  home: '/home/alice',
  shell: '/bin/bash',
  groups: ['alice', 'sudo'],
  in_docker: true,
  in_sudo: true,
  home_exists: true,
  home_owner: 'alice',
  home_group: 'alice',
  home_mode: '755',
  home_size_bytes: 1000,
  data_exists: true,
  data_owner: 'alice',
  data_group: 'alice',
  data_mode: '755',
  data_size_bytes: 2000,
  data_supported: true,
  usage_readable: true,
};

const BOB: UserAccountInput = {
  username: 'bob',
  uid: 1002,
  gid: 1002,
  primary_group: 'bob',
  home: '/home/bob',
  shell: '/bin/bash',
  groups: ['bob'],
  in_docker: false,
  in_sudo: false,
  home_exists: true,
  home_owner: 'bob',
  home_group: 'bob',
  home_mode: '755',
  home_size_bytes: 500,
  data_exists: null,
  data_supported: false,
  usage_readable: true,
};

/** Seeds a host with two present accounts and one missing baseline. */
function seedUsers(h: Harness, hostName = 'alpha'): void {
  saveHostUserSnapshot(h.fresh.db, hostName, [ALICE, BOB]);
  upsertUserBaseline(
    h.fresh.db,
    hostName,
    { username: 'carol', uid: 1003, gid: 1003, primary_group: 'carol', home: '/home/carol' },
    {},
  );
}

function makeAdmin(): UsersAdminApi {
  class AdminPlanError extends Error {}
  return {
    AdminPlanError: AdminPlanError as unknown as UsersAdminApi['AdminPlanError'],
    validateAccountName: (value: unknown): string => {
      const name = String(value ?? '').trim();
      if (!name) throw new AdminPlanError('请填写账号名');
      if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new AdminPlanError('账号名不合法');
      return name;
    },
    buildPlan: (operation: string, opts: Record<string, unknown>) => ({
      plan_hash: 'plan-hash-1',
      host: opts['hostName'],
      account: opts['account'],
      operation,
      blocked: false,
      blocked_reasons: [],
      warnings: [],
      rollback_hint: '',
      steps: [
        { id: 1, title: 'create', command: 'useradd alice', elevated: true, stdin: 'secret', stdin_label: 'password', skipped_reason: '' },
      ],
    }),
    publicPlan: (plan: Record<string, unknown>) => ({
      ...plan,
      steps: (plan['steps'] as Array<Record<string, unknown>>).map((step) => ({
        id: step['id'],
        title: step['title'],
        command: step['command'],
        elevated: step['elevated'],
        stdin_label: step['stdin_label'],
        has_stdin: Boolean(step['stdin']),
        skipped_reason: step['skipped_reason'],
      })),
    }),
  };
}

describe('users routes — authentication gating', () => {
  it('redirects the users page to /login when unauthenticated', async () => {
    const h = setup({ authenticate: false });
    const res = await request(h.app).get('/users');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('returns 401 JSON for the users API when unauthenticated', async () => {
    const h = setup({ authenticate: false });
    const res = await request(h.app).get('/api/users');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });
});

describe('users routes — fleet page + payload', () => {
  it('renders the users page when authenticated', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    const res = await h.get('/users');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('returns the fleet payload with accounts, hosts, summary and filters', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    seedUsers(h);
    const res = await h.get('/api/users');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accounts');
    expect(res.body).toHaveProperty('hosts');
    expect(res.body).toHaveProperty('summary');
    expect(res.body).toHaveProperty('usage_totals');
    expect(res.body).toHaveProperty('usage_scan');
    expect(res.body.filters).toEqual({ host: '', q: '', status: 'all' });
    expect(res.body.write_enabled).toBe(false);
    expect(res.body.summary).toMatchObject({ total: 3, present: 2, missing: 1, docker_issues: 1 });
  });

  it('filters accounts by query text', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    seedUsers(h);
    const res = await h.get('/api/users?q=alice');
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].username).toBe('alice');
    expect(res.body.accounts[0].state).toBe('present');
  });

  it('filters accounts to warning rows (issues or missing)', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    seedUsers(h);
    const res = await h.get('/api/users?status=warning');
    expect(res.status).toBe(200);
    const usernames = res.body.accounts.map((row: { username: string }) => row.username).sort();
    expect(usernames).toEqual(['bob', 'carol']);
  });

  it('reports write_enabled once the master switch is on', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    enableWrite(h);
    const res = await h.get('/api/users');
    expect(res.status).toBe(200);
    expect(res.body.write_enabled).toBe(true);
  });
});

describe('users routes — usage history + top growth', () => {
  it('requires a host for the history endpoint', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    const res = await h.get('/api/users/history');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'host_required' });
  });

  it('rejects a non-numeric days value', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    const res = await h.get('/api/users/history?host=alpha&days=abc');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_days' });
  });

  it('returns the usage series for a host', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    const day = 86_400_000;
    appendUserUsageHistory(
      h.fresh.db,
      'alpha',
      [{ username: 'alice', home_size_bytes: 1000, data_size_bytes: 0 }],
      { now: new Date(Date.now() - 2 * day), minIntervalHours: 0 },
    );
    appendUserUsageHistory(
      h.fresh.db,
      'alpha',
      [{ username: 'alice', home_size_bytes: 3000, data_size_bytes: 0 }],
      { now: new Date(Date.now() - day), minIntervalHours: 0 },
    );
    const res = await h.get('/api/users/history?host=alpha&days=30');
    expect(res.status).toBe(200);
    expect(res.body.host).toBe('alpha');
    expect(res.body.days).toBe(30);
    expect(Array.isArray(res.body.accounts.alice)).toBe(true);
    expect(res.body.accounts.alice.length).toBeGreaterThan(0);
  });

  it('rejects a bad limit on the top endpoint', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    const res = await h.get('/api/users/top?limit=abc');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_limit' });
  });

  it('ranks accounts by growth', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    const day = 86_400_000;
    appendUserUsageHistory(
      h.fresh.db,
      'alpha',
      [{ username: 'alice', home_size_bytes: 1000, data_size_bytes: 0 }],
      { now: new Date(Date.now() - 2 * day), minIntervalHours: 0 },
    );
    appendUserUsageHistory(
      h.fresh.db,
      'alpha',
      [{ username: 'alice', home_size_bytes: 3000, data_size_bytes: 0 }],
      { now: new Date(Date.now() - day), minIntervalHours: 0 },
    );
    const res = await h.get('/api/users/top?days=7&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
    expect(res.body.items[0]).toMatchObject({ host: 'alpha', account: 'alice', delta: 2000 });
  });
});

describe('users routes — scan control', () => {
  it('reports refresh-status unavailable without a worker service', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    const res = await h.get('/api/users/refresh-status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ running: false, error: 'unavailable' });
  });

  it('passes through a worker user_scan_status snapshot', async () => {
    const monitorService: UsersMonitorService = {
      user_scan_status: () => ({ running: true, hosts_done: 1, hosts_total: 2, accounts_done: 3 }),
    };
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')], deps: { monitorService } });
    const res = await h.get('/api/users/refresh-status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ running: true, hosts_done: 1, hosts_total: 2 });
  });

  it('returns 503 when refresh is requested without a worker service', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    const res = await h.post('/api/users/refresh').send({});
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'unavailable' });
  });

  it('triggers a refresh and forwards force_usage', async () => {
    const calls: Array<{ force_usage?: boolean } | undefined> = [];
    const monitorService: UsersMonitorService = {
      refresh_users: (options) => {
        calls.push(options);
        return { ok: true, started: true };
      },
    };
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')], deps: { monitorService } });
    const res = await h.post('/api/users/refresh').send({ usage: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, started: true });
    expect(calls[0]).toEqual({ force_usage: true });
  });

  it('returns refresh_failed when the worker throws twice', async () => {
    const monitorService: UsersMonitorService = {
      refresh_users: () => {
        throw new Error('boom');
      },
    };
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')], deps: { monitorService } });
    const res = await h.post('/api/users/refresh').send({});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'refresh_failed' });
  });
});

describe('users routes — baselines', () => {
  it('rejects a non-object payload', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    const res = await h.post('/api/users/baseline/remove').send({ host: 'alpha' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_payload' });
  });

  it('rejects an unknown host', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    const res = await h.post('/api/users/baseline/remove').send({ host: 'nope', username: 'carol' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unknown_host' });
  });

  it('refuses to clear a baseline whose account is still present', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    seedUsers(h);
    const res = await h.post('/api/users/baseline/remove').send({ host: 'alpha', username: 'alice' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('account_present');
  });

  it('returns 404 when the baseline is absent', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    const res = await h.post('/api/users/baseline/remove').send({ host: 'alpha', username: 'ghost' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('removes a missing baseline', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    seedUsers(h);
    const res = await h.post('/api/users/baseline/remove').send({ host: 'alpha', username: 'carol' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: 1 });
  });
});

describe('users routes — operations audit', () => {
  it('rejects an unknown host filter', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    const res = await h.get('/api/users/operations?host=nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unknown_host' });
  });

  it('lists recent operations', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    saveUserOperation(h.fresh.db, 'alpha', 'alice', 'create', 'success', { actor: 'admin' });
    const res = await h.get('/api/users/operations');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items[0]).toMatchObject({ host_name: 'alpha', account: 'alice', operation: 'create' });
  });
});

describe('users routes — plan + execute write gates', () => {
  it('blocks planning when the write master switch is off', async () => {
    const h = setup({
      servers: [makeServer('alpha', '10.0.0.1', { allow_user_write: true, sudo_password: 'pw' })],
      deps: { admin: makeAdmin() },
    });
    const res = await h.post('/api/users/plan').send({ host: 'alpha', account: 'alice', operation: 'create' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('write_disabled');
  });

  it('blocks planning when the host disallows user writes', async () => {
    const h = setup({
      servers: [makeServer('alpha', '10.0.0.1', { allow_user_write: false, sudo_password: 'pw' })],
      deps: { admin: makeAdmin() },
    });
    enableWrite(h);
    const res = await h.post('/api/users/plan').send({ host: 'alpha', account: 'alice', operation: 'create' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('host_write_disabled');
  });

  it('blocks planning when the host has no sudo password', async () => {
    const h = setup({
      servers: [makeServer('alpha', '10.0.0.1', { allow_user_write: true })],
      deps: { admin: makeAdmin() },
    });
    enableWrite(h);
    const res = await h.post('/api/users/plan').send({ host: 'alpha', account: 'alice', operation: 'create' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('sudo_password_missing');
  });

  it('returns 503 when the planner is not wired in', async () => {
    const h = setup({
      servers: [makeServer('alpha', '10.0.0.1', { allow_user_write: true, sudo_password: 'pw' })],
    });
    enableWrite(h);
    const res = await h.post('/api/users/plan').send({ host: 'alpha', account: 'alice', operation: 'create' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('unavailable');
  });

  it('returns 400 invalid_request when account validation fails', async () => {
    const h = setup({
      servers: [makeServer('alpha', '10.0.0.1', { allow_user_write: true, sudo_password: 'pw' })],
      deps: { admin: makeAdmin() },
    });
    enableWrite(h);
    const res = await h.post('/api/users/plan').send({ host: 'alpha', account: '', operation: 'create' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('previews a public plan that hides step secrets', async () => {
    const h = setup({
      servers: [makeServer('alpha', '10.0.0.1', { allow_user_write: true, sudo_password: 'pw' })],
      deps: { admin: makeAdmin() },
    });
    enableWrite(h);
    const res = await h.post('/api/users/plan').send({ host: 'alpha', account: 'alice', operation: 'create' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.plan.plan_hash).toBe('plan-hash-1');
    expect(res.body.plan.steps[0]).not.toHaveProperty('stdin');
    expect(res.body.plan.steps[0].has_stdin).toBe(true);
  });

  it('rejects execute when the plan is not cached', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    const res = await h.post('/api/users/execute').send({ plan_hash: 'missing' });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('plan_expired');
  });

  it('executes a cached plan, then exposes a running job without step secrets', async () => {
    const h = setup({
      servers: [makeServer('alpha', '10.0.0.1', { allow_user_write: true, sudo_password: 'pw' })],
      deps: { admin: makeAdmin() },
    });
    enableWrite(h);
    await h.post('/api/users/plan').send({ host: 'alpha', account: 'alice', operation: 'create' });
    const exec = await h.post('/api/users/execute').send({
      plan_hash: 'plan-hash-1',
      confirm_host: 'alpha',
      confirm_account: 'alice',
    });
    expect(exec.status).toBe(200);
    expect(typeof exec.body.job_id).toBe('string');

    const status = await h.get(`/api/users/execute/status?job_id=${exec.body.job_id}`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ host: 'alpha', account: 'alice', state: 'running' });
    expect(status.body.steps[0]).not.toHaveProperty('stdin');
  });

  it('rejects execute when the confirmation text does not match', async () => {
    const h = setup({
      servers: [makeServer('alpha', '10.0.0.1', { allow_user_write: true, sudo_password: 'pw' })],
      deps: { admin: makeAdmin() },
    });
    enableWrite(h);
    await h.post('/api/users/plan').send({ host: 'alpha', account: 'alice', operation: 'create' });
    const res = await h.post('/api/users/execute').send({
      plan_hash: 'plan-hash-1',
      confirm_host: 'alpha',
      confirm_account: 'wrong',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('confirm_mismatch');
  });

  it('requires a job_id when polling execute status', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    const res = await h.get('/api/users/execute/status');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'missing_job_id' });
  });

  it('returns 404 for an unknown execute job', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    const res = await h.get('/api/users/execute/status?job_id=nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_job');
  });
});

describe('users routes — user mode', () => {
  it('redirects the users page to /my in user mode', async () => {
    const h = setup({ mode: 'user', servers: [makeServer('alpha', '10.0.0.1')] });
    const res = await h.get('/users');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/my');
  });

  it('returns 403 admin_only for the users API in user mode', async () => {
    const h = setup({ mode: 'user', servers: [makeServer('alpha', '10.0.0.1')] });
    const res = await h.get('/api/users');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'admin_only', message: '该功能仅在管理员模式下可用' });
  });
});

describe('users routes — disabled hosts', () => {
  it('marks a host with user_monitoring=false as disabled', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1', { user_monitoring: false })] });
    const res = await h.get('/api/users');
    expect(res.status).toBe(200);
    const block = res.body.hosts.find((item: { name: string }) => item.name === 'alpha');
    expect(block).toMatchObject({ name: 'alpha', status: 'disabled', monitored: false, accounts: 0 });
  });

  it('surfaces a host error status from the last scan state', async () => {
    const h = setup({ servers: [makeServer('alpha', '10.0.0.1')] });
    saveUserScanState(h.fresh.db, 'alpha', { lastError: 'ssh timeout' });
    const res = await h.get('/api/users');
    expect(res.status).toBe(200);
    const block = res.body.hosts.find((item: { name: string }) => item.name === 'alpha');
    expect(block.status).toBe('error');
    expect(block.last_error).toBe('ssh timeout');
  });
});
