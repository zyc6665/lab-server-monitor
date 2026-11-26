/**
 * Shared request-classification helpers for the middleware chain.
 *
 * The oracle keys every gate on `request.path.startswith("/api/")` and
 * `request.path.startswith("/static/")`; these helpers centralise that logic so
 * the setup / CSRF / auth / user-mode gates cannot drift apart.
 */

/** True for JSON API routes (`/api` or `/api/...`). */
export function isApiRequest(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/** True for read-only static assets (`/static` or `/static/...`). */
export function isStaticRequest(path: string): boolean {
  return path === '/static' || path.startsWith('/static/');
}
