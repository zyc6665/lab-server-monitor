/** Settings change-history route (P2-3): GET /api/settings/history. */
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
import { registerSettingsRoutes } from '../../src/web/routes/settings';
import { setAdminPassword } from '../../src/web/routes/auth';
import type { AppConfig } from '../../src/config/config';
import type { SessionManager } from '../../src/web/session';
import { cleanupStorageTests, freshDb } from '../storage-helpers';

afterEach(() => {
  cleanupStorageTests();
});

const CSRF = '{{SECRET_pgp2h4hf}}';

function makeConfig(): AppConfig {
  return { dbPath: '/tmp/settings-history.db', host: '0.0.0.0', port: 8080, dataDir: '', logDir: '', servers: [], appVersion: 'test' };
}

function setup(): { app: Express; cookie: string } {
  const fresh = freshDb();
  setAdminPassword(fresh.db, { newPassword: 'secret-password', username: 'admin' });
  const config = makeConfig();
  const app = createWebApp({
    db: fresh.db,
    config,
    mountStatic: false,
    registerRoutes: (instance) => {
      registerSettingsRoutes(instance, { db: fresh.db, config, appVersion: 'test' });
    },
  });
  const cookie = (app.locals.session as SessionManager).createCookie({
    logged_in: true,
    username: 'admin',
    csrf_token: CSRF,
  });
  return { app, cookie };
}

describe('GET /api/settings/history', () => {
  it('records changed key names after a save and never leaks values', async () => {
    const { app, cookie } = setup();
    const put = await request(app)
      .put('/api/settings/ssh')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', CSRF)
      .send({ connect_timeout: 15, command_timeout: 30 });
    expect(put.status).toBe(200);

    const res = await request(app).get('/api/settings/history?limit=10').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.history)).toBe(true);
    const entry = res.body.history.find((row: { section: string }) => row.section === 'ssh');
    expect(entry).toBeTruthy();
    const keys: string[] = entry.changed_keys;
    expect(keys).toContain('command_timeout');
    expect(keys).toContain('connect_timeout');
    // key names only — the raw body must not contain the numeric values
    expect(JSON.stringify(entry)).not.toContain('15');
    expect(JSON.stringify(entry)).not.toContain('30');
  });

  it('requires authentication', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/settings/history');
    expect(res.status).toBe(401);
  });
});
