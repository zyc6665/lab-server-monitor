/**
 * Integration tests for the my-account summary (`_build_my_summary`).
 *
 * Seeds user snapshots for a member and a non-member account, then checks that
 * `/api/my/summary` only reports the member's rows grouped by host.
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
import { registerPagesRoutes } from '../../src/web/routes/pages';
import { setAdminPassword } from '../../src/web/routes/auth';
import { saveSection } from '../../src/config/service';
import type { AppConfig, HostConfig } from '../../src/config/config';
import type { SessionManager } from '../../src/web/session';
import { saveHostUserSnapshot } from '../../src/storage/users';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

afterEach(() => {
  cleanupStorageTests();
});

function makeServer(name: string, host: string): HostConfig {
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
    allow_user_write: false,
  };
}

function makeConfig(servers: HostConfig[]): AppConfig {
  return {
    dbPath: '/tmp/pages-my-test.db',
    host: '127.0.0.1',
    port: 0,
    dataDir: '',
    logDir: '',
    servers,
    appVersion: 'test',
  };
}

interface Harness {
  fresh: FreshDb;
  app: Express;
  cookie: string;
}

function setup(options: { member?: string; mode?: 'user' | 'admin' } = {}): Harness {
  const fresh = freshDb();
  setAdminPassword(fresh.db, { newPassword: 'admin-password', username: 'admin' });
  saveSection(
    fresh.db,
    'monitoring',
    options.mode === 'admin' ? { mode: 'admin' } : { mode: 'user', member_account: options.member ?? 'zhangsan' },
  );
  saveHostUserSnapshot(fresh.db, 'host-a', [
    { username: 'zhangsan', uid: 1001, gid: 1001, home_size_bytes: 100, data_size_bytes: 200, groups: [] },
    { username: 'lisi', uid: 1002, gid: 1002, home_size_bytes: 9, data_size_bytes: 9, groups: [] },
  ]);
  saveHostUserSnapshot(fresh.db, 'host-b', [
    { username: 'lisi', uid: 1002, gid: 1002, home_size_bytes: 5, data_size_bytes: 0, groups: [] },
  ]);
  const config = makeConfig([makeServer('host-a', '10.0.0.5'), makeServer('host-b', '10.0.0.6')]);
  const app = createWebApp({
    db: fresh.db,
    config,
    mountStatic: false,
    registerRoutes: (instance) => {
      registerPagesRoutes(instance, { db: fresh.db, config, appVersion: 'test' });
    },
  });
  const cookie = (app.locals.session as SessionManager).createCookie({
    logged_in: true,
    username: 'admin',
  });
  return { fresh, app, cookie };
}

describe('pages routes — GET /api/my/summary', () => {
  it('returns only the member account, grouped by host', async () => {
    const { app, cookie } = setup();
    const res = await request(app).get('/api/my/summary').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.member).toBe('zhangsan');
    expect(res.body.mode).toBe('user');
    expect(res.body.hosts).toHaveLength(1);
    expect(res.body.hosts[0].name).toBe('host-a');
    expect(res.body.hosts[0].address).toBe('10.0.0.5');
    expect(res.body.hosts[0].account.username).toBe('zhangsan');
    expect(res.body.summary).toMatchObject({
      hosts: 1,
      present: 1,
      missing: 0,
      host_errors: 0,
      home_bytes: 100,
      data_bytes: 200,
    });
  });

  it('returns no hosts when the member account is not configured', async () => {
    const { app, cookie } = setup({ mode: 'admin' });
    const res = await request(app).get('/api/my/summary').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.member).toBe('');
    expect(res.body.mode).toBe('admin');
    expect(res.body.hosts).toEqual([]);
    expect(res.body.summary.hosts).toBe(0);
  });

  it('renders the my page for the member', async () => {
    const { app, cookie } = setup();
    const res = await request(app).get('/my').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('我的服务器账号');
  });
});