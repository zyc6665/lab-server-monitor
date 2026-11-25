/**
 * Signed-cookie session store mirroring the Flask session configuration of the
 * Python oracle (`servermanage/web/__init__.py`).
 *
 * The oracle uses Flask's server-signed cookie session with:
 *   - cookie name `servermonitor_session` (optionally suffixed),
 *   - `HttpOnly`, `SameSite=Lax`,
 *   - `Secure` default OFF (the desktop build talks HTTP over loopback),
 *   - `permanent_session_lifetime = dashboard.session_lifetime_hours` (12h).
 *
 * Express has no built-in signed session cookie, so this module implements one
 * with `node:crypto` HMAC-SHA256 over a base64url JSON payload. The signing key
 * comes from the `dashboard:session_secret` secret (`SECRET_SESSION`); when it
 * is missing a random 32-byte key is generated once and persisted through
 * `setSecret`, matching the "generate and store a per-install secret" rule.
 *
 * A tampered or expired cookie decodes to `null` (never throws), so callers can
 * treat it exactly like an absent session.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

import { SECRET_SESSION } from '../config/secrets';
import { dpapiAvailable, protect, unprotect } from '../storage/dpapi';
import { getSecret, setSecret } from '../storage/secrets';

type SqliteDatabase = import('better-sqlite3').Database;

/** The cookie name used by the oracle (`app.config["SESSION_COOKIE_NAME"]`). */
export const SESSION_COOKIE = 'servermonitor_session';

/** Default session lifetime in hours (`dashboard.session_lifetime_hours` default). */
export const DEFAULT_SESSION_LIFETIME_HOURS = 12;

/** Decoded session payload. All values are caller-defined JSON. */
export interface SessionData {
  logged_in?: boolean;
  username?: string;
  csrf_token?: string;
  [key: string]: unknown;
}

/** Options for {@link SessionManager}. */
export interface SessionManagerOptions {
  /** HMAC signing key (the resolved `SECRET_SESSION` bytes). */
  secret: string | Buffer;
  /** Cookie lifetime in hours (`dashboard.session_lifetime_hours`, default 12). */
  lifetimeHours?: number;
  /** Cookie name override (default {@link SESSION_COOKIE}). */
  cookieName?: string;
  /** Add the `Secure` attribute (default false, as in the loopback oracle). */
  secure?: boolean;
  /** Injectable clock (milliseconds) for deterministic expiry tests. */
  now?: () => number;
}

/** Internal envelope written inside the signed cookie. */
interface SessionEnvelope {
  /** Session payload. */
  v: SessionData;
  /** Absolute expiry, milliseconds since epoch. */
  e: number;
}

function toSecretBuffer(secret: string | Buffer): Buffer {
  return Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(secret, 'utf8');
}

/** Parses a `Cookie` header into a name→value map (last value wins). */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    if (!name) {
      continue;
    }
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // Leave the raw value when it is not valid percent-encoding.
    }
    cookies[name] = value;
  }
  return cookies;
}

/** Constant-time string comparison (length differences short-circuit false). */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Signs and verifies the session cookie.
 *
 * Each instance owns one signing key; the app builds exactly one and shares it
 * with the CSRF/auth/user-mode middlewares.
 */
export class SessionManager {
  readonly cookieName: string;
  readonly lifetimeSeconds: number;
  private readonly secret: Buffer;
  private readonly secure: boolean;
  private readonly now: () => number;

  constructor(options: SessionManagerOptions) {
    this.secret = toSecretBuffer(options.secret);
    const hours = Number(options.lifetimeHours ?? DEFAULT_SESSION_LIFETIME_HOURS);
    this.lifetimeSeconds = Math.max(0, Math.floor((Number.isFinite(hours) ? hours : DEFAULT_SESSION_LIFETIME_HOURS) * 3600));
    this.cookieName = options.cookieName ?? SESSION_COOKIE;
    this.secure = options.secure === true;
    this.now = options.now ?? Date.now;
  }

  /** Signs `data` into a cookie value (payload + `.` + HMAC). */
  private sign(data: SessionData): string {
    const envelope: SessionEnvelope = {
      v: data,
      e: this.now() + this.lifetimeSeconds * 1000,
    };
    const payload = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  /** Verifies a cookie value, returning its payload or `null`. */
  private verify(value: string): SessionData | null {
    const dot = value.lastIndexOf('.');
    if (dot <= 0 || dot === value.length - 1) {
      return null;
    }
    const payload = value.slice(0, dot);
    const signature = value.slice(dot + 1);
    const expected = createHmac('sha256', this.secret).update(payload).digest('base64url');
    if (!safeEqual(signature, expected)) {
      return null;
    }
    let envelope: SessionEnvelope;
    try {
      envelope = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionEnvelope;
    } catch {
      return null;
    }
    if (
      typeof envelope !== 'object'
      || envelope === null
      || typeof envelope.e !== 'number'
      || typeof envelope.v !== 'object'
      || envelope.v === null
    ) {
      return null;
    }
    if (envelope.e <= this.now()) {
      return null;
    }
    return envelope.v;
  }

  /** Serialises a `Set-Cookie` attribute string for a signed value. */
  private serialize(value: string, maxAgeSeconds: number): string {
    const parts = [
      `${this.cookieName}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (this.secure) {
      parts.push('Secure');
    }
    return parts.join('; ');
  }

  /** Convenience accessor for logging: the logged-in username, if any. */
  sessionId(req: Request): string | undefined {
    const username = this.getSession(req)?.username;
    return typeof username === 'string' && username ? username : undefined;
  }

  /** Reads and verifies the session from the request cookie, or `null`. */
  getSession(req: Request): SessionData | null {
    const raw = parseCookieHeader(req.headers.cookie)[this.cookieName];
    if (!raw) {
      return null;
    }
    return this.verify(raw);
  }

  /** Writes `data` as a fresh signed session cookie on the response. */
  setSession(res: Response, data: SessionData): void {
    res.append('Set-Cookie', this.serialize(this.sign(data), this.lifetimeSeconds));
  }

  /** Expires the session cookie. */
  clearSession(res: Response): void {
    res.append('Set-Cookie', this.serialize('', 0));
  }

  /**
   * Returns the session CSRF token, creating (and persisting) one when absent.
   * Mirrors `_csrf_token`: a fresh `token_urlsafe(32)`-equivalent per session.
   */
  getCsrfToken(req: Request, res: Response): string {
    const data = this.getSession(req) ?? {};
    if (typeof data.csrf_token === 'string' && data.csrf_token) {
      return data.csrf_token;
    }
    const token = randomBytes(32).toString('base64url');
    this.setSession(res, { ...data, csrf_token: token });
    return token;
  }

  /** Builds a `Cookie` header value for tests / internal callers. */
  createCookie(data: SessionData): string {
    return `${this.cookieName}=${this.sign(data)}`;
  }
}

/**
 * Resolves the session signing key from the `dashboard:session_secret` store.
 *
 * Mirrors the oracle's "use configured secret, else generate a per-install
 * random one". The blob is DPAPI-protected on Windows; on platforms without
 * DPAPI the raw bytes are stored (tests only — the production build is Windows).
 */
export function resolveSessionSecret(db: SqliteDatabase): Buffer {
  const stored = getSecret(db, SECRET_SESSION);
  const dpapi = dpapiAvailable();
  if (stored) {
    return dpapi ? unprotect(stored) : Buffer.from(stored);
  }
  const generated = randomBytes(32);
  setSecret(db, SECRET_SESSION, dpapi ? protect(generated) : generated);
  return generated;
}
