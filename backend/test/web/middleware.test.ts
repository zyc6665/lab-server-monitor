/**
 * Integration tests for the Express web skeleton and its middleware chain.
 *
 * The chain mirrors `servermanage/web/routes/_core.py::_require_request`:
 *   ① setup -> ② csrf -> ③ auth -> ④ usermode
 *
 * Each test seeds a fresh SQLite database (via {@link freshDb}) so gate state
 * (setup pending, auth disabled, user mode) is fully controlled and never
 * leaks between cases. Route handlers are injected through `registerRoutes`.
 */
import type { Express, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createWebApp } from '../../src/web/app';
import { SessionManager } from '../../src/web/session';
import { SECRET_ADMIN } from '../../src/config/secrets';
import { saveAppSettings } from '../../src/storage/settings';
import { setSecret } from '../../src/storage/secrets';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

let current: FreshDb | undefined;

afterEach(() => {
  cleanupStorageTests();
  current = undefined;
});

function db(): FreshDb {
  current = freshDb();
  return current;
}

/** Marks first-run setup as complete (admin credential present). */
function completeSetup(fresh: FreshDb): void {
  setSecret(fresh.db, SECRET_ADMIN, Buffer.from('seeded-admin-secret'));
}

/** Disables dashboard auth so gate-isolation tests can reach routes. */
function disableAuth(fresh: FreshDb): void {
  saveAppSettings(fresh.db, 'dashboard', { auth: { enabled: false } });
}

/** Puts the app into restricted member (`user`) view mode. */
function setUserMode(fresh: FreshDb): void {
  saveAppSettings(fresh.db, 'monitoring', { mode: 'user' });
}

/** Registers the dummy routes the assertions drive. */
function registerRoutes(app: Express): void {
  const echo = (req: Request, res: Response): void => {
    res.status(200).json({ ok: true, body: req.body ?? null });
  };
  app.get('/api/echo', echo);
  app.post('/api/echo', echo);
  app.put('/api/echo', echo);
  app.patch('/api/echo', echo);
  app.delete('/api/echo', echo);
  app.get('/api/hosts', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/api/my/summary', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/api/runtime', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/api/settings/password', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/page', (_req, res) => res.status(200).type('text/plain').send('page'));
  app.get('/my', (_req, res) => res.status(200).type('text/plain').send('my'));
  app.get('/settings', (_req, res) => res.status(200).type('text/plain').send('settings'));
  app.post('/login', (_req, res) => res.status(200).json({ ok: true }));
  app.post('/setup', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/api/boom', () => {
    throw new Error('kaboom-secret-detail');
  });
  app.get('/boom', () => {
    throw new Error('kaboom-secret-detail');
  });
}

/** Builds an app over `fresh` with the dummy routes and no static mount. */
function build(fresh: FreshDb, opts: { mountStatic?: boolean } = {}): {
  app: Express;
  session: SessionManager;
} {
  const app = createWebApp({
    db: fresh.db,
    // Runtime config is not read beyond `appVersion`; a bare object is enough.
    config: {} as never,
    registerRoutes,
    mountStatic: opts.mountStatic ?? false,
  });
  return { app, session: app.locals.session as SessionManager };
}

/** A signed cookie for the given session payload. */
function cookieFor(session: SessionManager, data: Record<string, unknown>): string {
  return session.createCookie(data);
}

describe('session manager', () => {
  it('round-trips a payload through the signed cookie', () => {
    const session = new SessionManager({ secret: 'unit-secret' });
    const cookie = session.createCookie({ logged_in: true, username: 'admin', csrf_token: 't1' });
    const req = { headers: { cookie } } as unknown as Request;
    expect(session.getSession(req)).toMatchObject({ logged_in: true, username: 'admin', csrf_token: 't1' });
  });

  it('rejects a tampered signature', () => {
    const session = new SessionManager({ secret: 'unit-secret' });
    const cookie = session.createCookie({ logged_in: true });
    const tampered = `${cookie.slice(0, -2)}xx`;
    const req = { headers: { cookie: tampered } } as unknown as Request;
    expect(session.getSession(req)).toBeNull();
  });

  it('rejects an expired cookie', () => {
    let now = 1_000_000;
    const session = new SessionManager({ secret: 'unit-secret', lifetimeHours: 1, now: () => now });
    const cookie = session.createCookie({ logged_in: true });
    const req = { headers: { cookie } } as unknown as Request;
    expect(session.getSession(req)).not.toBeNull();
    now += 3_600_000 + 1;
    expect(session.getSession(req)).toBeNull();
  });

  it('returns null when the cookie is absent', () => {
    const session = new SessionManager({ secret: 'unit-secret' });
    expect(session.getSession({ headers: {} } as unknown as Request)).toBeNull();
  });

  it('getCsrfToken creates and persists a token while keeping existing data', () => {
    const session = new SessionManager({ secret: 'unit-secret' });
    const req = {
      headers: { cookie: session.createCookie({ logged_in: true, username: 'admin' }) },
    } as unknown as Request;
    const appended: string[] = [];
    const res = { append: (_name: string, value: string) => appended.push(value) } as unknown as Response;

    const token = session.getCsrfToken(req, res);
    expect(token.length).toBeGreaterThan(20);
    expect(appended).toHaveLength(1);

    const cookieHeader = appended[0].split('; ')[0];
    const next = { headers: { cookie: cookieHeader } } as unknown as Request;
    expect(session.getSession(next)).toMatchObject({
      logged_in: true,
      username: 'admin',
      csrf_token: token,
    });
  });
});

describe('① setup gate', () => {
  it('returns 428 setup_required for /api/* while setup is pending', async () => {
    const { app } = build(db());
    const res = await request(app).get('/api/echo');
    expect(res.status).toBe(428);
    expect(res.body).toEqual({ error: 'setup_required' });
  });

  it('redirects pages to /setup while setup is pending', async () => {
    const { app } = build(db());
    const res = await request(app).get('/page');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/setup');
  });

  it('exempts /setup and /static/* while setup is pending', async () => {
    const { app } = build(db());
    const setup = await request(app).post('/setup');
    expect(setup.status).toBe(200);

    const staticRes = await request(app).get('/static/app.css');
    expect(staticRes.status).toBe(404);
  });

  it('runs before CSRF and auth (uninitialised POST is 428, not 403/401)', async () => {
    const { app } = build(db());
    const res = await request(app).post('/api/echo').send({});
    expect(res.status).toBe(428);
    expect(res.body.error).toBe('setup_required');
  });
});

describe('② csrf gate', () => {
  it('rejects a POST without a token with 400 csrf_failed + message', async () => {
    const fresh = db();
    completeSetup(fresh);
    const { app } = build(fresh);
    const res = await request(app).post('/api/echo').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'csrf_failed', message: '页面已过期，请刷新页面后重试' });
  });

  it('rejects a mismatched token', async () => {
    const fresh = db();
    completeSetup(fresh);
    const { app, session } = build(fresh);
    const cookie = cookieFor(session, { logged_in: true, csrf_token: 'right' });
    const res = await request(app)
      .post('/api/echo')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 'wrong')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('csrf_failed');
    expect(res.body.message).toBe('页面已过期，请刷新页面后重试');
  });

  it('returns a 400 text page for a failed page-form CSRF check', async () => {
    const fresh = db();
    completeSetup(fresh);
    const { app } = build(fresh);
    const res = await request(app).post('/page').send({});
    expect(res.status).toBe(400);
    expect(res.text).toContain('安全令牌已过期');
  });

  it('accepts a matching X-CSRF-Token header', async () => {
    const fresh = db();
    completeSetup(fresh);
    const { app, session } = build(fresh);
    const cookie = cookieFor(session, { logged_in: true, csrf_token: 'tok-1' });
    const res = await request(app)
      .post('/api/echo')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 'tok-1')
      .send({});
    expect(res.status).toBe(200);
  });

  it('accepts a matching csrf_token form field (template hidden input)', async () => {
    const fresh = db();
    completeSetup(fresh);
    const { app, session } = build(fresh);
    const cookie = cookieFor(session, { logged_in: true, csrf_token: 'tok-2' });
    const res = await request(app)
      .post('/api/echo')
      .set('Cookie', cookie)
      .type('form')
      .send({ csrf_token: 'tok-2' });
    expect(res.status).toBe(200);
  });

  it('accepts the legacy _csrf form field as a fallback', async () => {
    const fresh = db();
    completeSetup(fresh);
    const { app, session } = build(fresh);
    const cookie = cookieFor(session, { logged_in: true, csrf_token: 'tok-3' });
    const res = await request(app)
      .post('/api/echo')
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: 'tok-3' });
    expect(res.status).toBe(200);
  });

  it('protects PATCH/PUT/DELETE as well as POST', async () => {
    const fresh = db();
    completeSetup(fresh);
    const { app } = build(fresh);
    for (const method of ['put', 'patch', 'delete'] as const) {
      const res = await request(app)[method]('/api/echo').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('csrf_failed');
    }
  });

  it('always lets /logout through, clearing the session and redirecting to /login', async () => {
    const fresh = db();
    completeSetup(fresh);
    const { app, session } = build(fresh);
    const cookie = cookieFor(session, { logged_in: true, csrf_token: 'stale' });
    const res = await request(app).post('/logout').set('Cookie', cookie).send({});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
    const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).join(';');
    expect(setCookie).toContain('servermonitor_session=');
    expect(setCookie).toContain('Max-Age=0');
  });

  it('does not check GET requests', async () => {
    const fresh = db();
    completeSetup(fresh);
    disableAuth(fresh);
    const { app } = build(fresh);
    const res = await request(app).get('/api/echo');
    expect(res.status).toBe(200);
  });

  it('exempts /login and /setup', async () => {
    const fresh = db();
    completeSetup(fresh);
    const { app } = build(fresh);
    const login = await request(app).post('/login').send({});
    expect(login.status).toBe(200);
    const setup = await request(app).post('/setup').send({});
    expect(setup.status).toBe(200);
  });
});

describe('③ auth gate', () => {
  it('returns 401 unauthorized for /api/* without a session', async () => {
    const fresh = db();
    completeSetup(fresh);
    const { app } = build(fresh);
    const res = await request(app).get('/api/echo');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  it('redirects pages to /login without a session', async () => {
    const fresh = db();
    completeSetup(fresh);
    const { app } = build(fresh);
    const res = await request(app).get('/page');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('exempts /login, /setup and /static/*', async () => {
    const fresh = db();
    completeSetup(fresh);
    const { app } = build(fresh);
    expect((await request(app).post('/login').send({})).status).toBe(200);
    expect((await request(app).post('/setup').send({})).status).toBe(200);
    expect((await request(app).get('/static/app.css')).status).toBe(404);
  });

  it('lets a logged-in session through', async () => {
    const fresh = db();
    completeSetup(fresh);
    const { app, session } = build(fresh);
    const cookie = cookieFor(session, { logged_in: true, username: 'admin' });
    const res = await request(app).get('/api/echo').set('Cookie', cookie);
    expect(res.status).toBe(200);
  });

  it('is a no-op when dashboard.auth.enabled is false', async () => {
    const fresh = db();
    completeSetup(fresh);
    disableAuth(fresh);
    const { app } = build(fresh);
    expect((await request(app).get('/api/echo')).status).toBe(200);
    expect((await request(app).get('/page')).status).toBe(200);
  });
});

describe('④ user-mode gate', () => {
  it('returns 403 admin_only for non-allow-listed /api/* in user mode', async () => {
    const fresh = db();
    completeSetup(fresh);
    disableAuth(fresh);
    setUserMode(fresh);
    const { app } = build(fresh);
    const res = await request(app).get('/api/hosts');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'admin_only', message: '该功能仅在管理员模式下可用' });
  });

  it('redirects non-allow-listed pages to /my in user mode', async () => {
    const fresh = db();
    completeSetup(fresh);
    disableAuth(fresh);
    setUserMode(fresh);
    const { app } = build(fresh);
    const res = await request(app).get('/page');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/my');
  });

  it('allows the user-mode allow-list and /static/*', async () => {
    const fresh = db();
    completeSetup(fresh);
    disableAuth(fresh);
    setUserMode(fresh);
    const { app } = build(fresh);
    expect((await request(app).get('/my')).status).toBe(200);
    expect((await request(app).get('/settings')).status).toBe(200);
    expect((await request(app).get('/api/my/summary')).status).toBe(200);
    expect((await request(app).get('/api/runtime')).status).toBe(200);
    expect((await request(app).get('/static/app.css')).status).toBe(404);
  });
});

describe('error handling', () => {
  it('returns 500 JSON without leaking the stack for /api/*', async () => {
    const fresh = db();
    completeSetup(fresh);
    disableAuth(fresh);
    const { app } = build(fresh);
    const res = await request(app).get('/api/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
    expect(JSON.stringify(res.body)).not.toContain('kaboom');
  });

  it('returns a plain-text 500 for page requests without leaking the stack', async () => {
    const fresh = db();
    completeSetup(fresh);
    disableAuth(fresh);
    const { app } = build(fresh);
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.text).toBe('Internal Server Error');
    expect(res.text).not.toContain('kaboom');
  });

  it('returns 404 not_found for unmatched /api/* routes', async () => {
    const fresh = db();
    completeSetup(fresh);
    disableAuth(fresh);
    const { app } = build(fresh);
    const res = await request(app).get('/api/missing');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});
