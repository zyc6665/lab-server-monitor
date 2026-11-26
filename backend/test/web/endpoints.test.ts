/** Endpoint registry listing (P3-2): GET /api/system/endpoints. */
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
import { registerSystemRoutes } from '../../src/web/routes/system';
import { setAdminPassword } from '../../src/web/routes/auth';
import type { AppConfig } from '../../src/config/config';
import type { SessionManager } from '../../src/web/session';
import { cleanupStorageTests, freshDb } from '../storage-helpers';

afterEach(() => cleanupStorageTests());

function makeConfig(): AppConfig {
  return { dbPath: '/tmp/endpoints.db', host: '0.0.0.0', port: 8080, dataDir: '', logDir: '', servers: [], appVersion: 'test' };
}

function cookieFor(app: Express): string {
  return (app.locals.session as SessionManager).createCookie({ logged_in: true, username: 'admin', csrf_token: 'csrf-endpoints' });
}

describe('GET /api/system/endpoints', () => {
  it('returns the endpoint registry as name/path pairs', async () => {
    const fresh = freshDb();
    setAdminPassword(fresh.db, { newPassword: '{{SECRET_q4yzlx7m}}', username: 'admin' });
    const config = makeConfig();
    const app = createWebApp({
      db: fresh.db,
      config,
      mountStatic: false,
      registerRoutes: (instance) => {
        registerSystemRoutes(instance, { db: fresh.db, config, appVersion: 'test' });
      },
    });
    const cookie = cookieFor(app);
    const res = await request(app).get('/api/system/endpoints').set('Cookie', cookie).expect(200);
    expect(Array.isArray(res.body.endpoints)).toBe(true);
    const paths = res.body.endpoints.map((e: { path: string }) => e.path);
    expect(paths).toContain('/api/system/health');
    expect(paths).toContain('/api/system/endpoints');
  });
});
