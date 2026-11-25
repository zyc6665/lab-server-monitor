/**
 * Authentication gate — step ③ of the `before_request` chain.
 *
 * Mirrors `_require_login` step 3: when dashboard auth is enabled and the
 * session is not logged in,
 *   - `/api/*` -> `401 {error:"unauthorized"}`
 *   - pages    -> `302 Location: /login`
 *
 * `/login`, `/setup` and `/static/*` stay reachable so the bootstrap pages can
 * render. When auth is disabled the gate is a no-op (the oracle's legacy mode).
 */
import type { RequestHandler } from 'express';

import type { SessionManager } from '../session';
import { isApiRequest, isStaticRequest } from './paths';

export interface AuthOptions {
  /** Whether dashboard authentication is enabled (`dashboard.auth.enabled`). */
  enabled: boolean;
}

/** Paths that must remain reachable before login. */
export const AUTH_EXEMPT_PATHS: readonly string[] = ['/login', '/setup'];

/** Builds the auth middleware bound to one session manager. */
export function auth(session: SessionManager, options: AuthOptions): RequestHandler {
  const exempt = new Set(AUTH_EXEMPT_PATHS);
  return (req, res, next) => {
    if (!options.enabled) {
      return next();
    }
    const path = req.path;
    if (exempt.has(path) || isStaticRequest(path)) {
      return next();
    }
    if (session.getSession(req)?.logged_in !== true) {
      if (isApiRequest(path)) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      return res.redirect('/login');
    }
    return next();
  };
}
