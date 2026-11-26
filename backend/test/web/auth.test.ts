/**
 * Integration tests for the auth routes (P2 Task 9).
 *
 * Every case builds the full middleware chain through {@link createWebApp} on a
 * fresh temp SQLite database. DPAPI is replaced by an identity stub so the
 * credential round-trip exercises the real storage code without touching the
 * Windows key store (matches the plan's "inject a DPAPI stub" requirement).
 */
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

// DPAPI identity stub: protect/unprotect are byte copies so SECRET_ADMIN blobs
// round-trip as raw JSON and `dpapiAvailable()` reports the platform writable.
vi.mock('../../src/storage/dpapi', () => ({
  dpapiAvailable: () => true,
  protect: (buffer: Buffer) => Buffer.from(buffer),
  unprotect: (buffer: Buffer) => Buffer.from(buffer),
  DpapiUnavailableError: class DpapiUnavailableError extends Error {},
}));

import { createWebApp } from '../../src/web/app';
import { registerAuthRoutes, setAdminPassword } from '../../src/web/routes/auth';
import { verifyPassword } from '../../src/web/security/password';
import type { SessionManager } from '../../src/web/session';
import { SECRET_ADMIN } from '../../src/config/secrets';
import { getSecret, setSecret } from '../../src/storage/secrets';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

const CORRECT = 'correcthorse';
const NEW_PASSWORD = 'newsecret123';

afterEach(() => {
  cleanupStorageTests();
});

/** Builds a web app wired with the auth routes for one fresh database. */
function makeApp(fresh: FreshDb): Express {
  return createWebApp({
    db: fresh.db,
    config: {} as never,
    mountStatic: false,
    registerRoutes: (app) => {
      registerAuthRoutes(app, { db: fresh.db, appVersion: 'test' });
      // Protected probe proving a login cookie carries `logged_in`.
      app.get('/api/whoami', (req, res) => {
        const data = (req.app.locals.session as SessionManager).getSession(req);
        res.json({ username: data?.username ?? null });
      });
    },
  });
}

/** Seeds an admin credential directly through the production write path. */
function seedAdmin(fresh: FreshDb, username: string, password: string): void {
  setAdminPassword(fresh.db, { newPassword: password, username });
}

/** Reads the raw stored admin document (DPAPI stub keeps it as plain JSON). */
function storedCredential(fresh: FreshDb): Record<string, unknown> {
  const blob = getSecret(fresh.db, SECRET_ADMIN);
  expect(blob).not.toBeNull();
  return JSON.parse((blob as Buffer).toString('utf8')) as Record<string, unknown>;
}

/** Extracts the `servermonitor_session` cookie from a response. */
function sessionCookieFrom(res: { headers: Record<string, string | string[] | undefined> }): string {
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

describe('auth routes', () => {
  it('renders the setup form on a fresh database', async () => {
    const fresh = freshDb();
    const app = makeApp(fresh);
    const res = await request(app).get('/setup');
    expect(res.status).toBe(200);
    expect(res.text).toContain('首次设置');
  });

  it('completes first-run setup and stores a verifiable admin credential', async () => {
    const fresh = freshDb();
    const app = makeApp(fresh);
    const res = await request(app)
      .post('/setup')
      .type('form')
      .send({ username: 'admin', 'password': CORRECT, confirm: CORRECT });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');

    const doc = storedCredential(fresh);
    expect(doc.username).toBe('admin');
    expect(typeof doc.hash).toBe('string');
    expect(typeof doc.salt).toBe('string');
    expect(doc.iterations).toBeGreaterThan(0);
    expect(verifyPassword(CORRECT, doc as never)).toBe(true);
    expect(verifyPassword('wrong-password', doc as never)).toBe(false);
  });

  it('rejects short and mismatched setup passwords with 400', async () => {
    const fresh = freshDb();
    const app = makeApp(fresh);

    const short = await request(app)
      .post('/setup')
      .type('form')
      .send({ username: 'admin', 'password': 'short', confirm: 'short' });
    expect(short.status).toBe(400);
    expect(short.text).toContain('密码长度至少 8 位');

    const mismatch = await request(app)
      .post('/setup')
      .type('form')
      .send({ username: 'admin', 'password': CORRECT, confirm: 'different-pass' });
    expect(mismatch.status).toBe(400);
    expect(mismatch.text).toContain('两次输入的密码不一致');
  });

  it('redirects GET /setup to /login once the credential exists', async () => {
    const fresh = freshDb();
    seedAdmin(fresh, 'admin', CORRECT);
    const app = makeApp(fresh);
    const res = await request(app).get('/setup');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('logs in with the correct password and sets a session cookie', async () => {
    const fresh = freshDb();
    seedAdmin(fresh, 'admin', CORRECT);
    const app = makeApp(fresh);

    const form = await request(app).get('/login');
    expect(form.status).toBe(200);
    expect(form.text).toContain('登录控制台');

    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ username: 'admin', 'password': CORRECT });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');

    const cookie = sessionCookieFrom(res);
    const who = await request(app).get('/api/whoami').set('Cookie', cookie);
    expect(who.status).toBe(200);
    expect(who.body).toEqual({ username: 'admin' });
  });

  it('rejects a wrong password with 401 and the oracle error message', async () => {
    const fresh = freshDb();
    seedAdmin(fresh, 'admin', CORRECT);
    const app = makeApp(fresh);
    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ username: 'admin', 'password': 'not-the-password' });
    expect(res.status).toBe(401);
    expect(res.text).toContain('用户名或密码错误');
  });

  it('rate-limits the sixth failed login attempt with 429', async () => {
    const fresh = freshDb();
    seedAdmin(fresh, 'admin', CORRECT);
    const app = makeApp(fresh);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await request(app)
        .post('/login')
        .type('form')
        .send({ username: 'admin', 'password': 'nope' });
      expect(res.status).toBe(401);
    }

    const sixth = await request(app)
      .post('/login')
      .type('form')
      .send({ username: 'admin', 'password': CORRECT });
    expect(sixth.status).toBe(429);
    expect(sixth.text).toContain('尝试过于频繁');
  });

  it('changes the password and enforces current-password / length / payload rules', async () => {
    const fresh = freshDb();
    seedAdmin(fresh, 'admin', CORRECT);
    const app = makeApp(fresh);
    const session = app.locals.session as SessionManager;
    const cookie = session.createCookie({ logged_in: true, username: 'admin', csrf_token: 'csrf-test' });

    const ok = await request(app)
      .post('/api/settings/password')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ current_password: CORRECT, new_password: NEW_PASSWORD, new_username: 'admin' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    const changed = storedCredential(fresh);
    expect(verifyPassword(NEW_PASSWORD, changed as never)).toBe(true);
    expect(verifyPassword(CORRECT, changed as never)).toBe(false);

    const wrongCurrent = await request(app)
      .post('/api/settings/password')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ current_password: 'wrong', new_password: NEW_PASSWORD });
    expect(wrongCurrent.status).toBe(400);
    expect(wrongCurrent.body).toEqual({ error: '当前密码不正确' });

    const tooShort = await request(app)
      .post('/api/settings/password')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ current_password: NEW_PASSWORD, new_password: 'short' });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body).toEqual({ error: '新密码长度至少 8 位' });

    const invalidPayload = await request(app)
      .post('/api/settings/password')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send([]);
    expect(invalidPayload.status).toBe(400);
    expect(invalidPayload.body).toEqual({ error: 'invalid_payload' });
  });

  it('rejects a password change without a matching CSRF token', async () => {
    const fresh = freshDb();
    seedAdmin(fresh, 'admin', CORRECT);
    const app = makeApp(fresh);
    const session = app.locals.session as SessionManager;
    const cookie = session.createCookie({ logged_in: true, username: 'admin', csrf_token: 'csrf-test' });

    const res = await request(app)
      .post('/api/settings/password')
      .set('Cookie', cookie)
      .send({ current_password: CORRECT, new_password: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect((res.body as { error?: string }).error).toBe('csrf_failed');
  });

  it('logout clears the session cookie and redirects to /login', async () => {
    const fresh = freshDb();
    seedAdmin(fresh, 'admin', CORRECT);
    const app = makeApp(fresh);
    const session = app.locals.session as SessionManager;
    const cookie = session.createCookie({ logged_in: true, username: 'admin' });

    const res = await request(app).post('/logout').set('Cookie', cookie);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
    const raw = res.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    expect(list.some((entry) => entry.includes('Max-Age=0'))).toBe(true);
  });

  it('redirects an already-logged-in user from /login to /', async () => {
    const fresh = freshDb();
    seedAdmin(fresh, 'admin', CORRECT);
    const app = makeApp(fresh);
    const session = app.locals.session as SessionManager;
    const cookie = session.createCookie({ logged_in: true, username: 'admin' });

    const res = await request(app).get('/login').set('Cookie', cookie);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });
});
