/**
 * Terminal error handling for the web app.
 *
 * Mirrors the oracle's `@app.errorhandler(Exception)` split: JSON APIs get a
 * structured `500`, page requests get a plain-text fallback until a template
 * engine lands. The stack trace is logged (when a logger is provided) but never
 * sent to the client.
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';

import { isApiRequest } from './paths';

/** Minimal logger shape (avoids a hard dependency on a logging library). */
export interface ErrorLogger {
  error: (message: string, error?: unknown) => void;
}

export interface ErrorHandlerOptions {
  /** Optional sink for the underlying error (server-side only). */
  logger?: ErrorLogger;
}

/**
 * Builds the terminal error middleware. Must be installed after every route so
 * Express routes thrown/rejected errors here.
 */
export function errorHandler(options: ErrorHandlerOptions = {}): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const message = err instanceof Error ? err.message : String(err);
    options.logger?.error(`[web] unhandled error on ${req.method} ${req.path}: ${message}`, err);

    if (res.headersSent) {
      return;
    }
    if (isApiRequest(req.path)) {
      res.status(500).json({ error: 'internal_error' });
      return;
    }
    res.status(500).type('text/plain').send('Internal Server Error');
  };
}

/** Simple 404 handler for unmatched routes (JSON for `/api/*`, text otherwise). */
export function notFoundHandler(): RequestHandler {
  return (req, res) => {
    if (isApiRequest(req.path)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(404).type('text/plain').send('Not Found');
  };
}
