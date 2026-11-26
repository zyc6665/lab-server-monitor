/**
 * User-mode (member view) allow-list — step ④ of the `before_request` chain.
 *
 * Mirrors `_require_request` step 4: when the desktop client runs in the
 * restricted `user` mode, only a fixed subset of routes is reachable. Anything
 * else is refused:
 *   - `/api/*` -> `403 {error:"admin_only",message:"该功能仅在管理员模式下可用"}`
 *   - pages    -> `302 Location: /my`
 *
 * The allow-list is copied verbatim from `_core.py::_USER_MODE_ALLOWED`
 * (including the `/api/settings/password` entry) plus the `/static/`
 * prefix. In `admin` mode the gate is a no-op.
 */
import type { RequestHandler } from 'express';

import { isApiRequest, isStaticRequest } from './paths';

/** View modes understood by the gate (anything else is treated as `admin`). */
export type ViewMode = 'admin' | 'user';

/** Routes reachable in restricted `user` mode (verbatim from the oracle). */
export const USER_MODE_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  '/',
  '/my',
  '/api/my/summary',
  '/settings',
  '/api/settings',
  '/api/settings/monitoring',
  '/api/settings/password',
  '/api/runtime',
  '/login',
  '/setup',
  '/logout',
]);

/** True when `mode` is recognised as a restricted mode. */
export function isUserMode(mode: string | undefined): boolean {
  return mode === 'user';
}

/** True when a path is reachable in restricted `user` mode. */
export function userModeAllows(path: string): boolean {
  if (isStaticRequest(path)) {
    return true;
  }
  return USER_MODE_ALLOWED_PATHS.has(path);
}

export interface UserModeOptions {
  /** Active view mode; only `'user'` restricts requests. */
  mode: ViewMode | string;
}

/** Builds the user-mode gate. */
export function usermode(options: UserModeOptions): RequestHandler {
  return (req, res, next) => {
    if (!isUserMode(options.mode)) {
      return next();
    }
    const path = req.path;
    if (userModeAllows(path)) {
      return next();
    }
    if (isApiRequest(path)) {
      return res.status(403).json({ error: 'admin_only', message: '该功能仅在管理员模式下可用' });
    }
    return res.redirect('/my');
  };
}
