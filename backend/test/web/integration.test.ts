/**
 * End-to-end integration test for the P2 composition root (Task 17).
 *
 * Unlike the per-route tests, this wires the *whole* application through
 * `createServerApp` on a real temporary SQLite database and drives the full
 * first-run lifecycle over HTTP with supertest:
 *
 *   fresh DB → setup gate (428 / 302) → POST /setup → POST /login → all pages
 *   and key JSON APIs → anonymous 401 → JSON 404 → static asset.
 *
 * DPAPI is replaced by an identity stub (same approach as the auth/overview
 * tests) so the admin credential round-trips without touching the Windows key
 * store, and `dpapiAvailable()` reports the platform writable.
 */
import path from 'node:path';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// DPAPI identity stub (byte-copy protect/unprotect).
vi.mock('../../src/storage/dpapi', () => ({
  dpapiAvailable: () => true,
  protect: (buffer: Buffer) => Buffer.from(buffer),
  unprotect: (buffer: Buffer) => Buffer.from(buffer),
  DpapiUnavailableError: class DpapiUnavailableError extends Error {},
}));

import { loadConfig } from '../../src/config/config';
import { createServerApp } from '../../src/web/composition';
import { startServer } from '../../src/server';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'integration-pass-123';

/** Reads `set-cookie` and keeps only the session cookie pair. */
function sessionCookieFrom(res: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = list
    .map((entry) => entry.split(';')[0])
    .filter((entry) => entry.startsWith('servermonitor_session='))
    .pop();
  if (!cookie) {
    throw new Error('response did not set a servermonitor_session cookie');
  }
  return cookie;
}

describe('P2 composition root integration', () => {
  let fresh: FreshDb;
  let app: ReturnType<typeof createServerApp>;

  beforeAll(() => {
    fresh = freshDb();
    // dataDir is the parent of servermonitor.db, so loadConfig derives the same
    // dbPath / dataDir / logDir the app will use.
    const config = loadConfig({
      SERVERMONITOR_DATA_DIR: path.dirname(fresh.dbPath),
      SERVERMONITOR_APP_VERSION: 'test',
    });
    app = createServerApp({ db: fresh.db, config });
  });

  afterAll(() => {
    cleanupStorageTests();
  });

  it('gates an uninitialised instance behind first-run setup', async () => {
    const apiRes = await request(app).get('/api/overview');
    expect(apiRes.status).toBe(428);
    expect(apiRes.body).toEqual({ error: 'setup_required' });

    const pageRes = await request(app).get('/');
    expect(pageRes.status).toBe(302);
    expect(pageRes.headers.location).toBe('/setup');

    const setupRes = await request(app).get('/setup');
    expect(setupRes.status).toBe(200);
    expect(setupRes.text).toMatch(/<html[\s>]/i);
  });

  it('creates the admin, logs in, and serves every page', async () => {
    const agent = request.agent(app);

    const setupRes = await agent
      .post('/setup')
      .type('form')
      .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD, confirm: ADMIN_PASSWORD });
    expect(setupRes.status).toBe(302);
    expect(setupRes.headers.location).toBe('/login');

    // After setup the same app instance must stop gating (dynamic setup guard).
    const loginPage = await agent.get('/login');
    expect(loginPage.status).toBe(200);

    const loginRes = await agent
      .post('/login')
      .type('form')
      .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
    expect(loginRes.status).toBe(302);
    expect(loginRes.headers.location).toBe('/');
    // Session cookie was issued.
    expect(sessionCookieFrom(loginRes)).toMatch(/^servermonitor_session=/);

    const pages = ['/', '/hosts', '/alerts', '/users', '/settings', '/disk-health', '/compute', '/my', '/terminal'];
    for (const page of pages) {
      const res = await agent.get(page);
      expect(res.status, `GET ${page}`).toBe(200);
      expect(res.headers['content-type'], `GET ${page} content-type`).toContain('text/html');
      expect(res.text, `GET ${page} body`).toMatch(/<html[\s>]/i);
    }
  });

  it('serves the key JSON APIs to an authenticated session', async () => {
    const agent = request.agent(app);
    await agent
      .post('/login')
      .type('form')
      .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });

    const apiChecks: Array<{ url: string; check?: (body: Record<string, unknown>) => void }> = [
      { url: '/api/system/health', check: (body) => expect(body.version).toBe('test') },
      { url: '/api/overview', check: (body) => expect(body).toHaveProperty('summary') },
      { url: '/api/settings' },
      { url: '/api/alerts' },
      { url: '/api/users' },
      { url: '/api/compute' },
      { url: '/api/my/summary' },
    ];
    for (const { url, check } of apiChecks) {
      const res = await agent.get(url);
      expect(res.status, `GET ${url}`).toBe(200);
      expect(res.headers['content-type'], `GET ${url} content-type`).toContain('application/json');
      expect(res.body, `GET ${url} body`).toBeTypeOf('object');
      check?.(res.body as Record<string, unknown>);
    }
  });

  it('rejects anonymous API access and returns JSON 404 for unknown routes', async () => {
    const anon = await request(app).get('/api/overview');
    expect(anon.status).toBe(401);
    expect(anon.body).toEqual({ error: 'unauthorized' });

    const agent = request.agent(app);
    await agent
      .post('/login')
      .type('form')
      .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });

    const missing = await agent.get('/api/nope');
    expect(missing.status).toBe(404);
    expect(missing.headers['content-type']).toContain('application/json');
    expect(missing.body).toEqual({ error: 'not_found' });

    // Static asset is mounted from the repository copy of servermanage/web/static.
    const css = await agent.get('/static/style.css');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
  });

  it('startServer assembles the full app when db + config are injected', async () => {
    const fresh2 = freshDb();
    const config = loadConfig({
      SERVERMONITOR_DATA_DIR: path.dirname(fresh2.dbPath),
      SERVERMONITOR_APP_VERSION: 'test',
    });
    const server = await startServer({ port: 0, db: fresh2.db, config });
    try {
      // A health-only P0 app has no /setup route; a 200 proves the full
      // composition (all P2 routes) was mounted.
      const setup = await fetch(`${server.url}/setup`);
      expect(setup.status).toBe(200);
      const overview = await fetch(`${server.url}/api/overview`);
      // Fresh DB → setup gate → 428 (not 404), again proving the route exists.
      expect(overview.status).toBe(428);
    } finally {
      await server.close();
    }
  });
});
