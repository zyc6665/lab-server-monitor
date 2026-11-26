import path from 'node:path';

import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';

// DPAPI identity stub so the admin credential round-trips without the key store.
vi.mock('../../src/storage/dpapi', () => ({
  dpapiAvailable: () => true,
  protect: (buffer: Buffer) => Buffer.from(buffer),
  unprotect: (buffer: Buffer) => Buffer.from(buffer),
  DpapiUnavailableError: class DpapiUnavailableError extends Error {},
}));

import { loadConfig } from '../../src/config/config';
import { upsertHost } from '../../src/config/hosts';
import { createServerApp } from '../../src/web/composition';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

function sessionCookieFrom(res: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = list
    .map((entry) => entry.split(';')[0])
    .filter((entry) => entry.startsWith('servermonitor_session='))
    .pop();
  if (!cookie) throw new Error('no session cookie');
  return cookie;
}

describe('hosts inventory from the database (not stale config.servers)', () => {
  let fresh: FreshDb;

  afterAll(() => cleanupStorageTests());

  it('hydrates config.servers from the DB and reflects host mutations without a restart', async () => {
    fresh = freshDb();
    // Seed the DB exactly like a UI import would (config file has no servers).
    upsertHost(fresh.db, { name: 'seed-a', host: '10.0.0.1', port: 22, username: 'u', auth_type: 'password', 'password': 'p' });
    upsertHost(fresh.db, { name: 'seed-b', host: '10.0.0.2', port: 22, username: 'u', auth_type: 'password', 'password': 'p' });

    const config = loadConfig({
      SERVERMONITOR_DATA_DIR: path.dirname(fresh.dbPath),
      SERVERMONITOR_APP_VERSION: 'test',
    });
    expect(config.servers).toEqual([]);

    const app = createServerApp({ db: fresh.db, config });
    // Hydrated from the DB at composition time.
    expect(config.servers.map((s) => s.name).sort()).toEqual(['seed-a', 'seed-b']);

    // First-run setup + login.
    await request(app).post('/setup').type('form').send({ 'password': 'Str0ngPass!23', confirm: 'Str0ngPass!23' });
    const login = await request(app).post('/login').type('form').send({ username: 'admin', 'password': 'Str0ngPass!23' });
    const cookie = sessionCookieFrom(login);
    const page0 = await request(app).get('/').set('Cookie', cookie);
    const cookie2 = page0.headers['set-cookie'] ? sessionCookieFrom(page0) : cookie;
    const tokenMatch = /name="csrf-token" content="([^"]+)"/.exec(page0.text);
    const csrf = tokenMatch ? tokenMatch[1] : '';
    expect(csrf).not.toBe('');

    const overview = await request(app).get('/api/overview').set('Cookie', cookie2);
    expect(overview.status).toBe(200);
    expect(overview.body.hosts.map((h: { name: string }) => h.name).sort()).toEqual(['seed-a', 'seed-b']);

    // Adding a host through the API must be visible immediately (refreshConfig).
    const put = await request(app)
      .put('/api/settings/hosts/late-host')
      .set('Cookie', cookie2)
      .set('X-CSRF-Token', csrf)
      .send({ name: 'late-host', host: '10.0.0.3', username: 'u', auth_type: 'password', 'password': 'p' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const after = await request(app).get('/api/overview').set('Cookie', cookie2);
    expect(after.body.hosts.map((h: { name: string }) => h.name)).toContain('late-host');
    expect(config.servers.map((s) => s.name)).toContain('late-host');

    // The server-rendered hosts page also shows the new host (was the "共 0 台" symptom).
    const page = await request(app).get('/hosts').set('Cookie', cookie2);
    expect(page.status).toBe(200);
    expect(page.text).toContain('late-host');
  });
});
