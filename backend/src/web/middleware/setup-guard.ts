/**
 * First-run setup gate — step ① of the `before_request` chain.
 *
 * Mirrors `servermanage/web/routes/_core.py::_require_login` step 1: while the
 * admin credential has not been created (`setup_required`), every request is
 * funnelled to the setup flow:
 *   - `/api/*` -> `428 {error:"setup_required"}`
 *   - pages    -> `302 Location: /setup`
 *
 * Exemptions: `/setup` itself and read-only `/static/*` assets.
 *
 * This gate runs before CSRF and auth so an uninitialised instance never leaks
 * a misleading `403`/`401` (an explicit requirement of Task 6).
 */
import type { RequestHandler } from 'express';

import { isApiRequest, isStaticRequest } from './paths';

export interface SetupGuardOptions {
  /**
   * Whether first-run setup is still pending.
   *
   * May be a predicate: the Python oracle re-reads `setup_required` from the DB
   * on every request, so after the admin credential is created the same app
   * instance must stop gating. A function value is evaluated per-request.
   */
  required: boolean | (() => boolean);
}

/** Builds the setup-guard middleware. */
export function setupGuard(options: SetupGuardOptions): RequestHandler {
  const isRequired = typeof options.required === 'function'
    ? options.required
    : () => options.required as boolean;
  return (req, res, next) => {
    if (!isRequired()) {
      return next();
    }
    const path = req.path;
    if (path === '/setup' || isStaticRequest(path)) {
      return next();
    }
    if (isApiRequest(path)) {
      return res.status(428).json({ error: 'setup_required' });
    }
    return res.redirect('/setup');
  };
}
