/**
 * Integration tests for the SSH terminal routes (P2 Task 16).
 *
 * The PTY/session manager is not ported yet, so every case injects an in-memory
 * stub manager through `deps.sshSessions` and asserts the HTTP contract:
 * status codes, JSON error bodies, the 201 `{session_id}` payload and the SSE
 * framing (`data: <base64>` / `: keepalive`). The gate and CSRF/auth chain are
 * exercised through the real {@link createWebApp} middleware stack.
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
  registerSshTerminalRoutes,
  SessionNotFoundError,
  TerminalLimitError,
  type SshSessionManager,
  type SshTerminalRouteDeps,
} from '../../src/web/routes/ssh-terminal';
import { setAdminPassword } from '../../src/web/routes/auth';
import type { AppConfig, HostConfig } from '../../src/config/config';
import type { SessionManager } from '../../src/web/session';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

afterEach(() => {
  cleanupStorageTests();
});

const CSRF_TOKEN = 'csrf-system-token';

function makeServer(overrides: Partial<HostConfig> & { name: string; host: string }): HostConfig {
  return {
    name: overrides.name,
    host: overrides.host,
    port: 22,
    username: 'root',
    auth: { type: 'password' } as never,
    tags: [],
    disk_mounts: ['/'],
    group: '',
    owner: '',
    location: '',
    notes: '',
    checks: [],
    allow_user_write: false,
    ...overrides,
  };
}

function makeConfig(servers: HostConfig[]): AppConfig {
  return {
    dbPath: '/tmp/ssh-terminal-test.db',
    host: '127.0.0.1',
    port: 0,
    dataDir: '',
    logDir: '',
    servers,
    appVersion: 'test',
  };
}

/** In-memory {@link SshSessionManager} stub used by every case. */
class FakeManager implements SshSessionManager {
  readonly sessions = new Map<string, { host: HostConfig; cols: number; rows: number }>();
  readonly created: Array<{ host: HostConfig; cols: number; rows: number }> = [];
  readonly inputs: Array<{ id: string; data: string }> = [];
  readonly resizes: Array<{ id: string; cols: number; rows: number }> = [];
  chunks: Array<Uint8Array | string> = [];
  failCreate?: Error;
  private seq = 0;

  create(host: HostConfig, cols: number, rows: number): string {
    if (this.failCreate) {
      throw this.failCreate;
    }
    const id = `sess-${++this.seq}`;
    this.created.push({ host, cols, rows });
    this.sessions.set(id, { host, cols, rows });
    return id;
  }

  getSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  sendInput(sessionId: string, data: string): void {
    if (!this.sessions.has(sessionId)) {
      throw new SessionNotFoundError();
    }
    this.inputs.push({ id: sessionId, data });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (!this.sessions.has(sessionId)) {
      throw new SessionNotFoundError();
    }
    this.resizes.push({ id: sessionId, cols, rows });
  }

  close(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  stream(sessionId: string): AsyncIterable<Uint8Array | string> {
    const chunks = this.chunks;
    void sessionId;
    return (async function* iterate(): AsyncGenerator<Uint8Array | string> {
      for (const chunk of chunks) {
        yield chunk;
      }
    })();
  }
}

interface Harness {
  fresh: FreshDb;
  app: Express;
  cookie: string;
  manager: FakeManager;
}

function setup(options: {
  authenticate?: boolean;
  manager?: FakeManager;
  allowed?: () => boolean;
}): Harness {
  const fresh = freshDb();
  setAdminPassword(fresh.db, { newPassword: 'correcthorse', username: 'admin' });
  const config = makeConfig([makeServer({ name: 'alpha', host: '10.0.0.1' })]);
  const manager = options.manager ?? new FakeManager();
  const deps: SshTerminalRouteDeps = { db: fresh.db, config, appVersion: 'test', sshSessions: manager };
  if (options.allowed) {
    deps.isTerminalAllowed = options.allowed;
  }
  const app = createWebApp({
    db: fresh.db,
    config,
    mountStatic: false,
    registerRoutes: (instance) => {
      registerSshTerminalRoutes(instance, deps);
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
  return { fresh, app, cookie, manager };
}

function auth(res: request.Test, cookie: string): request.Test {
  return res.set('Cookie', cookie).set('X-CSRF-Token', CSRF_TOKEN);
}

describe('ssh terminal routes — access gate', () => {
  it('returns 401 on the SSE API when unauthenticated', async () => {
    const { app } = setup({ authenticate: false });
    const res = await request(app).get('/api/ssh/sessions/sess-1/stream');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  it('returns 403 forbidden when the terminal gate denies the request', async () => {
    const { app, cookie } = setup({ allowed: () => false });
    const res = await auth(request(app).post('/api/ssh/sessions'), cookie).send({ host_name: 'alpha' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden', message: 'SSH 终端仅限本机桌面客户端' });
  });

  it('denies by default outside desktop mode', async () => {
    const previous = process.env.SERVERMONITOR_DESKTOP;
    delete process.env.SERVERMONITOR_DESKTOP;
    try {
      const fresh = freshDb();
      setAdminPassword(fresh.db, { newPassword: 'correcthorse', username: 'admin' });
      const config = makeConfig([makeServer({ name: 'alpha', host: '10.0.0.1' })]);
      const app = createWebApp({
        db: fresh.db,
        config,
        mountStatic: false,
        registerRoutes: (instance) => {
          registerSshTerminalRoutes(instance, { db: fresh.db, config, sshSessions: new FakeManager() });
        },
      });
      const cookie = (app.locals.session as SessionManager).createCookie({
        logged_in: true,
        username: 'admin',
        csrf_token: CSRF_TOKEN,
      });
      const res = await auth(request(app).post('/api/ssh/sessions'), cookie).send({ host_name: 'alpha' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    } finally {
      if (previous === undefined) {
        delete process.env.SERVERMONITOR_DESKTOP;
      } else {
        process.env.SERVERMONITOR_DESKTOP = previous;
      }
    }
  });
});

describe('ssh terminal routes — POST /api/ssh/sessions', () => {
  it('creates a session with the default 80x24 size and returns 201', async () => {
    const { app, cookie, manager } = setup({ allowed: () => true });
    const res = await auth(request(app).post('/api/ssh/sessions'), cookie).send({ host_name: 'alpha' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ session_id: 'sess-1' });
    expect(manager.created).toHaveLength(1);
    expect(manager.created[0]).toMatchObject({ cols: 80, rows: 24 });
    expect(manager.created[0].host.name).toBe('alpha');
    expect(manager.created[0].host.host).toBe('10.0.0.1');
  });

  it('clamps cols to 400 and rows to 5', async () => {
    const { app, cookie, manager } = setup({ allowed: () => true });
    const res = await auth(request(app).post('/api/ssh/sessions'), cookie).send({
      host_name: 'alpha',
      cols: 9999,
      rows: 1,
    });
    expect(res.status).toBe(201);
    expect(manager.created[0]).toMatchObject({ cols: 400, rows: 5 });
  });

  it('returns 404 host_not_found for an unknown host', async () => {
    const { app, cookie } = setup({ allowed: () => true });
    const res = await auth(request(app).post('/api/ssh/sessions'), cookie).send({ host_name: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'host_not_found' });
  });

  it('returns 400 invalid_size for a non-numeric size', async () => {
    const { app, cookie } = setup({ allowed: () => true });
    const res = await auth(request(app).post('/api/ssh/sessions'), cookie).send({
      host_name: 'alpha',
      cols: 'abc',
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_size' });
  });

  it('returns 429 terminal_limit when the manager is at capacity', async () => {
    const manager = new FakeManager();
    manager.failCreate = new TerminalLimitError();
    const { app, cookie } = setup({ allowed: () => true, manager });
    const res = await auth(request(app).post('/api/ssh/sessions'), cookie).send({ host_name: 'alpha' });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'terminal_limit' });
  });

  it('returns 502 ssh_failed when the manager cannot connect', async () => {
    const manager = new FakeManager();
    manager.failCreate = new Error('boom');
    const { app, cookie } = setup({ allowed: () => true, manager });
    const res = await auth(request(app).post('/api/ssh/sessions'), cookie).send({ host_name: 'alpha' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'ssh_failed', message: 'boom' });
  });

  it('returns 502 when no manager is configured (feature not migrated)', async () => {
    const fresh = freshDb();
    setAdminPassword(fresh.db, { newPassword: 'correcthorse', username: 'admin' });
    const config = makeConfig([makeServer({ name: 'alpha', host: '10.0.0.1' })]);
    const app = createWebApp({
      db: fresh.db,
      config,
      mountStatic: false,
      registerRoutes: (instance) => {
        registerSshTerminalRoutes(instance, { db: fresh.db, config, isTerminalAllowed: () => true });
      },
    });
    const cookie = (app.locals.session as SessionManager).createCookie({
      logged_in: true,
      username: 'admin',
      csrf_token: CSRF_TOKEN,
    });
    const res = await auth(request(app).post('/api/ssh/sessions'), cookie).send({ host_name: 'alpha' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'ssh_failed', message: 'SSH 终端功能尚未迁移' });
  });
});

describe('ssh terminal routes — input / resize', () => {
  it('forwards input as 204 for an existing session', async () => {
    const { app, cookie, manager } = setup({ allowed: () => true });
    await auth(request(app).post('/api/ssh/sessions'), cookie).send({ host_name: 'alpha' });
    const res = await auth(request(app).post('/api/ssh/sessions/sess-1/input'), cookie).send({ data: 'ls\n' });
    expect(res.status).toBe(204);
    expect(manager.inputs).toEqual([{ id: 'sess-1', data: 'ls\n' }]);
  });

  it('returns 400 invalid_data when data is not a string', async () => {
    const { app, cookie } = setup({ allowed: () => true });
    await auth(request(app).post('/api/ssh/sessions'), cookie).send({ host_name: 'alpha' });
    const res = await auth(request(app).post('/api/ssh/sessions/sess-1/input'), cookie).send({ data: 5 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_data' });
  });

  it('returns 404 session_not_found for input to an unknown session', async () => {
    const { app, cookie } = setup({ allowed: () => true });
    const res = await auth(request(app).post('/api/ssh/sessions/nope/input'), cookie).send({ data: 'x' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'session_not_found' });
  });

  it('resizes an existing session as 204', async () => {
    const { app, cookie, manager } = setup({ allowed: () => true });
    await auth(request(app).post('/api/ssh/sessions'), cookie).send({ host_name: 'alpha' });
    const res = await auth(request(app).post('/api/ssh/sessions/sess-1/resize'), cookie).send({
      cols: 100,
      rows: 40,
    });
    expect(res.status).toBe(204);
    expect(manager.resizes).toEqual([{ id: 'sess-1', cols: 100, rows: 40 }]);
  });

  it('returns 400 invalid_size for a bad resize', async () => {
    const { app, cookie } = setup({ allowed: () => true });
    await auth(request(app).post('/api/ssh/sessions'), cookie).send({ host_name: 'alpha' });
    const res = await auth(request(app).post('/api/ssh/sessions/sess-1/resize'), cookie).send({ cols: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_size' });
  });
});

describe('ssh terminal routes — DELETE', () => {
  it('closes an existing session as 204', async () => {
    const { app, cookie, manager } = setup({ allowed: () => true });
    await auth(request(app).post('/api/ssh/sessions'), cookie).send({ host_name: 'alpha' });
    const res = await auth(request(app).delete('/api/ssh/sessions/sess-1'), cookie);
    expect(res.status).toBe(204);
    expect(manager.getSession('sess-1')).toBe(false);
  });

  it('returns 404 session_not_found for an unknown session', async () => {
    const { app, cookie } = setup({ allowed: () => true });
    const res = await auth(request(app).delete('/api/ssh/sessions/nope'), cookie);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'session_not_found' });
  });
});

describe('ssh terminal routes — GET /:id/stream', () => {
  it('streams base64 SSE frames with keepalives', async () => {
    const { app, cookie, manager } = setup({ allowed: () => true });
    await auth(request(app).post('/api/ssh/sessions'), cookie).send({ host_name: 'alpha' });
    manager.chunks = [Buffer.from('hello'), '', Buffer.from('world')];

    const res = await request(app).get('/api/ssh/sessions/sess-1/stream').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(res.text).toContain(`data: ${Buffer.from('hello').toString('base64')}`);
    expect(res.text).toContain(': keepalive');
    expect(res.text).toContain(`data: ${Buffer.from('world').toString('base64')}`);
    expect(manager.getSession('sess-1')).toBe(false);
  });

  it('returns 404 session_not_found for an unknown session', async () => {
    const { app, cookie } = setup({ allowed: () => true });
    const res = await request(app).get('/api/ssh/sessions/nope/stream').set('Cookie', cookie);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'session_not_found' });
  });
});
