/**
 * Authentication routes — the Express equivalent of
 * `servermanage/web/routes/auth.py` (P2 Task 9).
 *
 * Implements first-run setup, login/logout and the admin password-change API,
 * mirroring the Python oracle field names, error messages, redirect targets and
 * status codes:
 *
 *   GET/POST /setup                       first-run admin creation
 *   GET      /login                       login form
 *   POST     /login                       login submit (rate limited)
 *   POST     /logout                      destroy the session
 *   POST     /api/settings/password       change the admin password
 *
 * The session/CSRF/setup-gate middlewares are installed by `createWebApp`; this
 * module only registers route handlers and therefore reads the shared
 * `app.locals.session` / `app.locals.webSettings` at request time (they are
 * assigned after `registerRoutes` runs).
 *
 * The admin credential lives in the DPAPI-protected `SECRET_ADMIN` blob as the
 * JSON document `{username, hash, salt, iterations}`, byte-compatible with the
 * Python `_store_admin_password` / `set_admin_password`.
 */
import type { Express, Request, Response } from 'express';

import { createTemplating, type Templating } from '../templating';
import type { SessionManager } from '../session';
import { SECRET_ADMIN } from '../../config/secrets';
import { publicSettings } from '../../config/service';
import { getSecret, setSecret } from '../../storage/secrets';
import { dpapiAvailable, protect, unprotect } from '../../storage/dpapi';
import {
  PBKDF2_ITERATIONS,
  hashPassword,
  verifyPassword,
} from '../security/password';
import { LoginRateLimiter, clientIp, isLoopback } from '../security/ratelimit';

type SqliteDatabase = import('better-sqlite3').Database;

/** User-facing credential error; maps to HTTP 400 `{error: message}`. */
export class AuthSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthSettingsError';
  }
}

/** The stored admin credential document (`{username, hash, salt, iterations}`). */
export interface AdminCredential {
  /** Login name; absent when the stored document lacked it. */
  username?: string;
  /** Hex PBKDF2-SHA256 digest. */
  hash: string;
  /** Hex random salt. */
  salt: string;
  /** PBKDF2 iteration count. */
  iterations: number;
}

/** Options accepted by {@link registerAuthRoutes}. */
export interface AuthRouteDeps {
  /** Open SQLite handle (secrets + settings). */
  db: SqliteDatabase;
  /** Optional pre-built templating bundle (defaults to one bound to `appVersion`). */
  templating?: Templating;
  /** Optional shared login rate limiter (defaults to a fresh instance). */
  rateLimiter?: LoginRateLimiter;
  /** `APP_VERSION` for the default templating bundle. */
  appVersion?: string;
}

/** Decodes a stored secret blob (DPAPI on Windows, raw bytes elsewhere). */
function decodeSecret(blob: Buffer): Buffer {
  return dpapiAvailable() ? unprotect(blob) : Buffer.from(blob);
}

/** Encodes a secret for storage (DPAPI on Windows, raw bytes elsewhere). */
function encodeSecret(plain: Buffer): Buffer {
  return dpapiAvailable() ? protect(plain) : Buffer.from(plain);
}

/**
 * Reads and validates the stored admin credential.
 *
 * Returns `null` when no credential exists or the blob is malformed, matching
 * `verify_admin`'s "anything unusable simply fails verification" contract.
 */
export function readAdminCredential(db: SqliteDatabase): AdminCredential | null {
  const blob = getSecret(db, SECRET_ADMIN);
  if (!blob || blob.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeSecret(blob).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const doc = parsed as Record<string, unknown>;
  const hash = doc.hash;
  const salt = doc.salt;
  if (typeof hash !== 'string' || !hash || typeof salt !== 'string' || !salt) {
    return null;
  }
  const rawIterations = doc.iterations;
  const iterations =
    typeof rawIterations === 'number' && Number.isInteger(rawIterations) && rawIterations > 0
      ? rawIterations
      : PBKDF2_ITERATIONS;
  return {
    username: typeof doc.username === 'string' ? doc.username : undefined,
    hash,
    salt,
    iterations,
  };
}

/**
 * Verifies `username` / `password` against the stored credential.
 *
 * Mirrors `AdminMixin.verify_admin`: reject on missing/malformed blob, a
 * username mismatch, or a bad hash; the fallback to the YAML `dashboard.auth`
 * credential in the oracle is intentionally not replicated (the desktop build
 * writes a DPAPI credential on first run).
 */
export function verifyAdminCredential(
  db: SqliteDatabase,
  username: string,
  password: string,
): boolean {
  const credential = readAdminCredential(db);
  if (!credential) {
    return false;
  }
  const storedUser = credential.username ?? 'admin';
  if (String(storedUser) !== String(username)) {
    return false;
  }
  return verifyPassword(password, {
    hash: credential.hash,
    salt: credential.salt,
    iterations: credential.iterations,
  });
}

/** Options for {@link setAdminPassword}. */
export interface SetAdminPasswordOptions {
  /** Current password (required when rotating an existing credential). */
  current?: string | null;
  /** New clear-text password (must be ≥ 8 chars). */
  newPassword: unknown;
  /** Login name to store (defaults to the existing user or `admin`). */
  username?: string | null;
}

/**
 * Creates or rotates the admin credential in `SECRET_ADMIN`.
 *
 * Mirrors `AdminMixin.set_admin_password`'s validation and error
 * messages. The oracle additionally rotates `SECRET_SESSION` and rewrites the
 * `security` section; Task 9 only requires updating `SECRET_ADMIN`, so that
 * extra bookkeeping is omitted here.
 *
 * @throws {AuthSettingsError} when not writable, the new password is too short,
 *   or the supplied current password does not verify.
 */
export function setAdminPassword(
  db: SqliteDatabase,
  options: SetAdminPasswordOptions,
): void {
  if (!dpapiAvailable()) {
    throw new AuthSettingsError('settings are not writable on this platform');
  }
  const newPassword = options.newPassword;
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    throw new AuthSettingsError('新密码长度至少 8 位');
  }

  const existing = readAdminCredential(db);
  let existingUser: string | undefined;
  if (existing && existing.hash) {
    existingUser = existing.username || 'admin';
    if (!options.current || !verifyAdminCredential(db, existingUser, options.current)) {
      throw new AuthSettingsError('当前密码不正确');
    }
  }

  const targetUser =
    (options.username ? String(options.username) : '')
    || existingUser
    || 'admin';
  const hashed = hashPassword(newPassword);
  const document = {
    username: targetUser,
    hash: hashed.hash,
    salt: hashed.salt,
    iterations: hashed.iterations,
  };
  setSecret(db, SECRET_ADMIN, encodeSecret(Buffer.from(JSON.stringify(document), 'utf8')));
}

/** Best-effort direct peer address (used for the setup loopback check). */
function remoteAddress(req: Request): string {
  return req.ip || req.socket?.remoteAddress || '';
}

/** Reads a form/body field as a string (empty when absent or not a string). */
function field(body: unknown, name: string): string {
  if (typeof body !== 'object' || body === null) {
    return '';
  }
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
}

/**
 * Registers the auth routes on `app`.
 *
 * Called from `createWebApp`'s `registerRoutes` hook, so it must read dynamic
 * collaborators (`session`, `webSettings`) from `app.locals` at request time.
 */
export function registerAuthRoutes(app: Express, deps: AuthRouteDeps): void {
  const db = deps.db;
  const templating = deps.templating ?? createTemplating({ appVersion: deps.appVersion });
  const rateLimiter = deps.rateLimiter ?? new LoginRateLimiter();

  const sessionOf = (req: Request): SessionManager =>
    req.app.locals.session as SessionManager;

  const authEnabled = (req: Request): boolean => {
    const settings = req.app.locals.webSettings as { authEnabled?: boolean } | undefined;
    return settings?.authEnabled !== false;
  };

  const setupRequired = (): boolean => publicSettings(db).setup_required === true;

  // --- GET /setup ---------------------------------------------------------
  const setupGet = (req: Request, res: Response): void => {
    if (!isLoopback(remoteAddress(req))) {
      templating.renderPage(res, 'setup.html', { error: '首次设置只允许本机访问' }, 403);
      return;
    }
    if (!setupRequired()) {
      res.redirect('/login');
      return;
    }
    templating.renderPage(res, 'setup.html', {});
  };

  // --- POST /setup --------------------------------------------------------
  const setupPost = (req: Request, res: Response): void => {
    if (!isLoopback(remoteAddress(req))) {
      templating.renderPage(res, 'setup.html', { error: '首次设置只允许本机访问' }, 403);
      return;
    }
    const body = req.body ?? {};
    const username = field(body, 'username').trim() || 'admin';
    const password = field(body, 'password');
    const confirm = field(body, 'confirm');

    let error: string | null = null;
    if (password.length < 8) {
      error = '密码长度至少 8 位';
    } else if (password !== confirm) {
      error = '两次输入的密码不一致';
    }
    if (error !== null) {
      templating.renderPage(res, 'setup.html', { error, username }, 400);
      return;
    }

    try {
      setAdminPassword(db, { current: null, newPassword: password, username });
    } catch (err) {
      if (err instanceof AuthSettingsError) {
        templating.renderPage(res, 'setup.html', { error: err.message, username }, 400);
        return;
      }
      throw err;
    }
    res.redirect('/login');
  };

  // --- GET /login ---------------------------------------------------------
  const loginGet = (req: Request, res: Response): void => {
    const session = sessionOf(req);
    if (session.getSession(req)?.logged_in === true) {
      res.redirect('/');
      return;
    }
    templating.renderPage(res, 'login.html', {});
  };

  // --- POST /login --------------------------------------------------------
  const loginPost = (req: Request, res: Response): void => {
    const session = sessionOf(req);
    const ip = clientIp(req);
    if (rateLimiter.isLimited(ip)) {
      templating.renderPage(res, 'login.html', { error: '尝试过于频繁，请稍后再试' }, 429);
      return;
    }

    const body = req.body ?? {};
    const username = field(body, 'username');
    const password = field(body, 'password');

    const credentialsOk = authEnabled(req) && verifyAdminCredential(db, username, password);
    if (credentialsOk) {
      rateLimiter.clear(ip);
      session.setSession(res, { logged_in: true, username });
      res.redirect('/');
      return;
    }

    rateLimiter.recordFailure(ip);
    templating.renderPage(res, 'login.html', { error: '用户名或密码错误' }, 401);
  };

  // --- POST /logout -------------------------------------------------------
  const logoutPost = (req: Request, res: Response): void => {
    sessionOf(req).clearSession(res);
    res.redirect('/login');
  };

  // --- POST /api/settings/password (change password) -----------------------
  const changePassword = (req: Request, res: Response): void => {
    if (!publicSettings(db).writable) {
      res.status(409).json({ error: 'settings_not_writable' });
      return;
    }
    const body: unknown = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const record = body as Record<string, unknown>;
    const current = record['current_password'];
    const newPassword = record['new_password'];
    const newUsername = record['new_username'];
    try {
      setAdminPassword(db, {
        current: typeof current === 'string' ? current : undefined,
        newPassword,
        username: typeof newUsername === 'string' ? newUsername : undefined,
      });
    } catch (err) {
      if (err instanceof AuthSettingsError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
    res.json({ ok: true });
  };

  app.get('/setup', setupGet);
  app.post('/setup', setupPost);
  app.get('/login', loginGet);
  app.post('/login', loginPost);
  app.post('/logout', logoutPost);
  app.post('/api/settings/password', changePassword);
}
