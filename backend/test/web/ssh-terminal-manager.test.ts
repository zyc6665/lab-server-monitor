/**
 * Integration tests wiring the real {@link SshTerminalManager} into the SSH
 * terminal routes. A fake in-memory ssh2 shell replaces the network, while the
 * audit hooks use the real SQLite `ssh_audit_sessions` table via
 * `recordSshSessionStart` / `recordSshSessionEnd`.
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
import { registerSshTerminalRoutes } from '../../src/web/routes/ssh-terminal';
import { setAdminPassword } from '../../src/web/routes/auth';
import { SshTerminalManager } from '../../src/ssh/session-manager';
import type { ShellChannel } from '../../src/collect/ssh-client';
import type { AppConfig, HostConfig } from '../../src/config/config';
import type { SessionManager } from '../../src/web/session';
import { recordSshSessionEnd, recordSshSessionStart } from '../../src/storage/runtime';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

afterEach(() => {
  cleanupStorageTests();
});

const CSRF_TOKEN = 'csrf-ssh-manager-token';

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
    dbPath: '/tmp/ssh-terminal-manager-test.db',
    host: '127.0.0.1',
    port: 0,
    dataDir: '',
    logDir: '',
    servers,
    appVersion: 'test',
  };
}

class FakeShellChannel implements ShellChannel {
  readonly written: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  closed = false;
  private readonly dataListeners: Array<(data: string) => void> = [];

  write(data: string): void {
    this.written.push(data);
  }
  onData(callback: (data: string) => void): void {
    this.dataListeners.push(callback);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  close(): void {
    this.closed = true;
  }
  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }
}

class FakeShellClient {
  readonly channel = new FakeShellChannel();
  opened: { cols: number; rows: number } | null = null;
  closed = false;
  async openShell(cols: number, rows: number): Promise<ShellChannel> {
    this.opened = { cols, rows };
    return this.channel;
  }
  close(): void {
    this.closed = true;
  }
}

interface Harness {
  fresh: FreshDb;
  app: Express;
  cookie: string;
  manager: SshTerminalManager;
  clients: FakeShellClient[];
}

function setup(): Harness {
  const fresh = freshDb();
  setAdminPassword(fresh.db, { newPassword: 'admin-password', username: 'admin' });
  const config = makeConfig([makeServer({ name: 'alpha', host: '10.0.0.1' })]);

  const clients: FakeShellClient[] = [];
  const manager = new SshTerminalManager({
    sweepIntervalMs: 0,
    clientFactory: () => {
      const client = new FakeShellClient();
      clients.push(client);
      return client;
    },
    audit: {
      recordStart: (input) => recordSshSessionStart(fresh.db, input),
      recordEnd: (auditId, status, error) => {
        recordSshSessionEnd(fresh.db, auditId, { status, error });
      },
    },
  });

  const app = createWebApp({
    db: fresh.db,
    config,
    mountStatic: false,
    registerRoutes: (instance) => {
      registerSshTerminalRoutes(instance, {
        db: fresh.db,
        config,
        appVersion: 'test',
        sshSessions: manager,
        isTerminalAllowed: () => true,
      });
    },
  });
  const cookie = (app.locals.session as SessionManager).createCookie({
    logged_in: true,
    username: 'admin',
    csrf_token: CSRF_TOKEN,
  });

  return { fresh, app, cookie, manager, clients };
}

function auth(res: request.Test, cookie: string): request.Test {
  return res.set('Cookie', cookie).set('X-CSRF-Token', CSRF_TOKEN);
}

interface AuditRow {
  status: string;
  error: string | null;
}

function auditRows(fresh: FreshDb): AuditRow[] {
  return fresh.db
    .prepare('SELECT status, error FROM ssh_audit_sessions ORDER BY id')
    .all() as AuditRow[];
}

describe('ssh terminal routes — real session manager', () => {
  it('creates, feeds and closes a session while recording audit start/end', async () => {
    const { fresh, app, cookie, manager, clients } = setup();

    const created = await auth(request(app).post('/api/ssh/sessions'), cookie).send({
      host_name: 'alpha',
    });
    expect(created.status).toBe(201);
    const sessionId = created.body.session_id as string;
    expect(typeof sessionId).toBe('string');
    expect(manager.getSession(sessionId)).toBe(true);
    expect(clients[0].opened).toEqual({ cols: 80, rows: 24 });
    expect(auditRows(fresh)).toEqual([{ status: 'active', error: null }]);
    // The audit row captured the logged-in username and loopback client.
    const row = fresh.db
      .prepare('SELECT username, server_username FROM ssh_audit_sessions WHERE id = 1')
      .get() as { username: string; server_username: string };
    expect(row).toEqual({ username: 'admin', server_username: 'root' });

    const input = await auth(
      request(app).post(`/api/ssh/sessions/${sessionId}/input`),
      cookie,
    ).send({ data: 'ls\\r' });
    expect(input.status).toBe(204);
    expect(clients[0].channel.written).toEqual(['ls\\r']);

    const resized = await auth(
      request(app).post(`/api/ssh/sessions/${sessionId}/resize`),
      cookie,
    ).send({ cols: 120, rows: 50 });
    expect(resized.status).toBe(204);
    expect(clients[0].channel.resizes).toEqual([{ cols: 120, rows: 50 }]);

    const closed = await auth(
      request(app).delete(`/api/ssh/sessions/${sessionId}`),
      cookie,
    );
    expect(closed.status).toBe(204);
    expect(clients[0].channel.closed).toBe(true);
    expect(clients[0].closed).toBe(true);
    expect(auditRows(fresh)).toEqual([{ status: 'closed', error: null }]);
  });

  it('streams base64 SSE frames from the manager', async () => {
    const { app, cookie, manager, clients } = setup();

    const created = await auth(request(app).post('/api/ssh/sessions'), cookie).send({
      host_name: 'alpha',
    });
    const sessionId = created.body.session_id as string;

    clients[0].channel.emitData('hello');
    const pending = request(app)
      .get(`/api/ssh/sessions/${sessionId}/stream`)
      .set('Cookie', cookie);

    // Let the route subscribe, then close so the stream terminates.
    setTimeout(() => {
      manager.close(sessionId);
    }, 25);

    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const frame = `data: ${Buffer.from('hello').toString('base64')}\n\n`;
    expect(response.text).toContain(frame);
  });

  it('returns 429 when the session limit is reached', async () => {
    const { fresh, app, cookie } = setup();
    // Drain the default manager's slots by creating 8 sessions.
    for (let i = 0; i < 8; i += 1) {
      const res = await auth(request(app).post('/api/ssh/sessions'), cookie).send({
        host_name: 'alpha',
      });
      expect(res.status).toBe(201);
    }
    const overflow = await auth(request(app).post('/api/ssh/sessions'), cookie).send({
      host_name: 'alpha',
    });
    expect(overflow.status).toBe(429);
    expect(overflow.body).toEqual({ error: 'terminal_limit' });
    expect(auditRows(fresh)).toHaveLength(8);
  });
});
