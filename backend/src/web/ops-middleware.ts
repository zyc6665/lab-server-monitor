/**
 * Operational middleware (P3-2): request audit, coarse rate limiting and slow
 * request logging. All three are best-effort and must never break a request.
 *
 * - audit: one row per mutating request (POST/PUT/PATCH/DELETE) with actor,
 *   action (`<METHOD> <path>`), target (path), ip and result — never the body.
 * - rate limit: 600 read requests/min and 60 write requests/min per client IP.
 * - slow log: requests slower than 500 ms are appended to `<logDir>/slow.log`.
 */
import type { Express, NextFunction, Request, Response } from 'express';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { AppConfig } from '../config/config';
type SqliteDatabase = import('better-sqlite3').Database;
import { recordAudit } from '../storage/audit';

export interface OpsMiddlewareOptions {
  db: SqliteDatabase;
  config: AppConfig;
  readLimitPerMinute?: number;
  writeLimitPerMinute?: number;
  slowMs?: number;
  /** Disable the limiter (tests build many requests against one IP). */
  disableRateLimit?: boolean;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function clientIp(req: Request): string {
  const remote = req.socket?.remoteAddress ?? '';
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  return remote;
}

function actorOf(req: Request): string | null {
  const locals = (req.app && (req.app.locals as Record<string, unknown>)) || {};
  const session = locals['session'] as { getSession?: (r: Request) => { username?: string | null } | null } | undefined;
  try {
    return session?.getSession?.(req)?.username ?? null;
  } catch {
    return null;
  }
}

export function registerOpsMiddleware(app: Express, options: OpsMiddlewareOptions): void {
  const readLimit = options.readLimitPerMinute ?? 600;
  const writeLimit = options.writeLimitPerMinute ?? 60;
  const slowMs = options.slowMs ?? 500;

  // --- coarse rate limiting (fixed 60s window, in-memory) --------------------
  const windows = new Map<string, { start: number; read: number; write: number }>();
  if (!options.disableRateLimit) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const now = Date.now();
      const ip = clientIp(req);
      let bucket = windows.get(ip);
      if (!bucket || now - bucket.start >= 60_000) {
        bucket = { start: now, read: 0, write: 0 };
        windows.set(ip, bucket);
      }
      const isWrite = UNSAFE.has(req.method);
      if (isWrite) bucket.write += 1;
      else bucket.read += 1;
      const over = isWrite ? bucket.write > writeLimit : bucket.read > readLimit;
      if (over) {
        res.status(429).json({ error: 'rate_limited', message: '请求过于频繁，请稍后再试' });
        return;
      }
      next();
    });
  }

  // --- audit + slow log -----------------------------------------------------
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    res.on('finish', () => {
      const elapsed = Date.now() - started;
      try {
        if (UNSAFE.has(req.method)) {
          recordAudit(options.db, {
            actor: actorOf(req),
            action: `${req.method} ${req.path}`,
            target: req.path,
            ip: clientIp(req),
            result: res.statusCode < 400 ? 'ok' : `error:${res.statusCode}`,
          });
        }
      } catch {
        /* audit must never break the response */
      }
      if (elapsed > slowMs && options.config.logDir) {
        try {
          const file = join(options.config.logDir, 'slow.log');
          mkdirSync(dirname(file), { recursive: true });
          appendFileSync(file, `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${elapsed}ms\n`);
        } catch {
          /* slow log is best-effort */
        }
      }
    });
    next();
  });
}
