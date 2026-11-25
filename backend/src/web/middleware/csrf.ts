/**
 * CSRF protection — step ② of the `before_request` chain.
 *
 * Mirrors `_require_csrf` / `_csrf_failure_response` in
 * `servermanage/web/routes/_core.py`: every state-changing request
 * (`POST`/`PUT`/`PATCH`/`DELETE`) must carry a token matching the one stored in
 * the session. `GET`/`HEAD`/`OPTIONS` are never checked.
 *
 * Token sources (in order): the hidden `csrf_token` form field used by the
 * existing templates, the legacy `_csrf` field, then the `X-CSRF-Token` header.
 * `/login` and `/setup` are exempt because the client has no session-backed
 * token yet.
 *
 * Failure semantics match the oracle's `_csrf_failure_response()`:
 *   - `/logout` always succeeds (clear session + 302 `/login`); logging out is
 *     not a sensitive action, so a stale page can still sign out.
 *   - `/api/*` -> `400 {error:"csrf_failed",message:"页面已过期，请刷新页面后重试"}`
 *   - pages    -> `400` (plain-text placeholder until the Task 7 template lands)
 *
 * A missing or empty expected token also takes the failure path.
 */
import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

import type { SessionManager } from '../session';
import { isApiRequest } from './paths';

/** Methods that mutate state and therefore require a CSRF token. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Paths that are always exempt from CSRF (login/setup bootstrap). */
export const CSRF_EXEMPT_PATHS: readonly string[] = ['/login', '/setup'];

/** Message shown to the user when a form/post is replayed with a stale token. */
export const CSRF_EXPIRED_MESSAGE = '页面已过期，请刷新页面后重试';

export interface CsrfOptions {
  /** Override the exempt path list (defaults to {@link CSRF_EXEMPT_PATHS}). */
  exempt?: readonly string[];
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Builds the CSRF middleware bound to one session manager. */
export function csrf(session: SessionManager, options: CsrfOptions = {}): RequestHandler {
  const exempt = new Set(options.exempt ?? CSRF_EXEMPT_PATHS);
  return (req, res, next) => {
    if (!UNSAFE_METHODS.has(req.method.toUpperCase())) {
      return next();
    }
    if (exempt.has(req.path)) {
      return next();
    }
    // Logging out must always succeed, even from a page with a stale token.
    if (req.path === '/logout') {
      session.clearSession(res);
      return res.redirect('/login');
    }

    const expected = session.getSession(req)?.csrf_token;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const formToken = typeof body.csrf_token === 'string' && body.csrf_token
      ? body.csrf_token
      : typeof body._csrf === 'string' && body._csrf
        ? body._csrf
        : undefined;
    const headerToken = req.headers['x-csrf-token'];
    const supplied = formToken ?? (typeof headerToken === 'string' ? headerToken : undefined);

    if (
      typeof expected !== 'string'
      || expected === ''
      || typeof supplied !== 'string'
      || supplied === ''
      || !safeEqual(expected, supplied)
    ) {
      if (isApiRequest(req.path)) {
        return res.status(400).json({ error: 'csrf_failed', message: CSRF_EXPIRED_MESSAGE });
      }
      const surface = req.path === '/login' ? '登录' : '当前';
      return res
        .status(400)
        .type('text/plain')
        .send(`${surface}页面的安全令牌已过期，请刷新页面后重试。`);
    }
    return next();
  };
}
