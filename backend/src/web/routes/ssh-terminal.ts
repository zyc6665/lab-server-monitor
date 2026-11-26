/**
 * SSH terminal routes — the Express equivalent of
 * `servermanage/web/routes/ssh_terminal.py` (P2 Task 16).
 *
 * Five endpoints, all gated to the local desktop client first (matching
 * `terminal_denied()` → 403 `forbidden` when not allowed):
 *
 *   POST   /api/ssh/sessions                    create a session → 201 `{session_id}`
 *   POST   /api/ssh/sessions/:id/input          forward keystrokes → 204
 *   POST   /api/ssh/sessions/:id/resize         resize the PTY     → 204
 *   DELETE /api/ssh/sessions/:id                close the session  → 204
 *   GET    /api/ssh/sessions/:id/stream         SSE byte stream (`data: <base64>`)
 *
 * The PTY/session manager is injected through
 * {@link SshTerminalRouteDeps.sshSessions}; the composition root supplies the
 * real {@link SshTerminalManager}. When no manager is injected (unit tests that
 * only exercise the gate) `POST /api/ssh/sessions` answers 502
 * `{error:'ssh_failed',message:'SSH 终端功能尚未迁移'}` and every per-session
 * endpoint answers 404 `session_not_found`.
 *
 * The middleware chain (setup / CSRF / auth / user-mode) is installed by
 * `createWebApp`; this module only registers handlers.
 */
import type { Express, Request, Response } from 'express';

import type { AppConfig } from '../../config/config';
import {
  SessionNotFoundError,
  TerminalLimitError,
  type SshSessionManager,
} from '../../ssh/session-manager';
import type { SessionManager } from '../session';
import { ENDPOINTS } from './registry';

export { SessionNotFoundError, TerminalLimitError } from '../../ssh/session-manager';
export type { SshSessionManager } from '../../ssh/session-manager';

type SqliteDatabase = import('better-sqlite3').Database;
type Obj = Record<string, unknown>;

/** Default terminal columns / rows when the client omits them (oracle values). */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * The injectable SSH session manager contract.
 *
 * The concrete interface lives in `../../ssh/session-manager`; it is re-exported
 * above for backwards compatibility with the route skeleton.
 */

/** Injected dependencies. Only `config` is required for the routes to mount. */
export interface SshTerminalRouteDeps {
  /** Open SQLite handle (unused today; kept for `register*Routes` parity). */
  db?: SqliteDatabase;
  /** Resolved runtime config (servers list). */
  config: AppConfig;
  /** `APP_VERSION` (unused; kept for `register*Routes` parity). */
  appVersion?: string;
  /** Injected SSH session manager. When absent the endpoints are inert. */
  sshSessions?: SshSessionManager;
  /**
   * Terminal access gate. Defaults to "desktop mode AND loopback request".
   * Returning `false` yields the oracle's 403 `forbidden` response.
   */
  isTerminalAllowed?: (req: Request) => boolean;
}

/** Converts an `ENDPOINTS` template (`/x/{id}`) into an Express path. */
function routePath(template: string): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ':$1');
}

/** Narrow an unknown value to a plain object. */
function asObj(value: unknown): Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Obj)
    : {};
}

/** `request.get_json(silent=True) or {}`. */
function readPayload(req: Request): Obj {
  return asObj((req as Request & { body?: unknown }).body);
}

/** Reads a single path parameter as a string. */
function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** True when the process is the local desktop client (`SERVERMONITOR_DESKTOP`). */
function isDesktopMode(): boolean {
  return process.env.SERVERMONITOR_DESKTOP === '1';
}

/** Whether the request originated from the loopback interface (`_is_loopback`). */
function isLoopback(req: Request): boolean {
  const candidates = [req.socket?.remoteAddress, req.ip];
  return candidates.some((address) => {
    if (!address) {
      return false;
    }
    const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
    return normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.');
  });
}

/**
 * Parse and clamp a terminal dimension like the oracle:
 * `max(min, min(max, int(value)))`, defaulting only when the key is absent.
 * Returns `null` when the value cannot be coerced to an integer (→ 400).
 */
function parseSize(value: unknown, fallback: number, min: number, max: number): number | null {
  const raw = value === undefined ? fallback : value;
  let parsed: number;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      return null;
    }
    parsed = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      return null;
    }
    parsed = Number.parseInt(trimmed, 10);
  } else {
    return null;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

/** Whether a session id currently exists (a missing manager → nothing exists). */
function sessionExists(manager: SshSessionManager | undefined, sessionId: string): boolean {
  if (!manager) {
    return false;
  }
  try {
    return manager.getSession(sessionId);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return false;
    }
    throw error;
  }
}

/** The logged-in username from the signed session cookie, or "" (mirrors users.ts). */
function sessionUsername(req: Request): string {
  const locals = req.app?.locals as { session?: SessionManager } | undefined;
  const manager = locals?.session;
  if (!manager || typeof manager.getSession !== 'function') {
    return '';
  }
  const username = manager.getSession(req)?.username;
  return typeof username === 'string' ? username : '';
}

/** The client address, normalised like the oracle's `request.remote_addr`. */
function remoteAddress(req: Request): string {
  const raw = req.ip || req.socket?.remoteAddress || '';
  if (!raw) {
    return '127.0.0.1';
  }
  const normalized = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  return normalized === '::1' ? '127.0.0.1' : normalized;
}

/** Registers the SSH terminal endpoints on `app`. */
export function registerSshTerminalRoutes(app: Express, deps: SshTerminalRouteDeps): void {
  const { config } = deps;

  const allowed = (req: Request): boolean =>
    deps.isTerminalAllowed ? deps.isTerminalAllowed(req) : isDesktopMode() && isLoopback(req);

  /** Runs the terminal gate; writes the 403 and returns `false` when denied. */
  const passGate = (req: Request, res: Response): boolean => {
    if (!allowed(req)) {
      res.status(403).json({ error: 'forbidden', message: 'SSH 终端仅限本机桌面客户端' });
      return false;
    }
    return true;
  };

  // --- POST /api/ssh/sessions ---------------------------------------------
  app.post(ENDPOINTS.create_ssh_session, async (req, res) => {
    if (!passGate(req, res)) {
      return;
    }
    const payload = readPayload(req);
    const hostName = String(payload.host_name ?? '').trim();
    const host = config.servers.find((server) => server.name === hostName);
    if (!host) {
      res.status(404).json({ error: 'host_not_found' });
      return;
    }

    const cols = parseSize(payload.cols, DEFAULT_COLS, 20, 400);
    const rows = parseSize(payload.rows, DEFAULT_ROWS, 5, 200);
    if (cols === null || rows === null) {
      res.status(400).json({ error: 'invalid_size' });
      return;
    }

    const manager = deps.sshSessions;
    if (!manager) {
      res.status(502).json({ error: 'ssh_failed', message: 'SSH 终端功能尚未迁移' });
      return;
    }

    try {
      // `await` keeps both the real (async) manager and the legacy sync fakes
      // structurally compatible.
      const sessionId = await manager.create(host, cols, rows, {
        username: sessionUsername(req) || 'admin',
        remoteAddr: remoteAddress(req),
      });
      res.status(201).json({ session_id: sessionId });
    } catch (error) {
      if (error instanceof TerminalLimitError) {
        res.status(429).json({ error: 'terminal_limit' });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(502).json({ error: 'ssh_failed', message });
    }
  });

  // --- POST /api/ssh/sessions/:id/input -----------------------------------
  app.post(routePath(ENDPOINTS.ssh_terminal_input), (req, res) => {
    if (!passGate(req, res)) {
      return;
    }
    const sessionId = param(req, 'session_id');
    if (!sessionExists(deps.sshSessions, sessionId)) {
      res.status(404).json({ error: 'session_not_found' });
      return;
    }
    const payload = readPayload(req);
    const data = payload.data === undefined ? '' : payload.data;
    if (typeof data !== 'string') {
      res.status(400).json({ error: 'invalid_data' });
      return;
    }
    try {
      deps.sshSessions?.sendInput(sessionId, data);
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        res.status(404).json({ error: 'session_not_found' });
        return;
      }
      throw error;
    }
    res.status(204).end();
  });

  // --- POST /api/ssh/sessions/:id/resize ----------------------------------
  app.post(routePath(ENDPOINTS.ssh_terminal_resize), (req, res) => {
    if (!passGate(req, res)) {
      return;
    }
    const sessionId = param(req, 'session_id');
    if (!sessionExists(deps.sshSessions, sessionId)) {
      res.status(404).json({ error: 'session_not_found' });
      return;
    }
    const payload = readPayload(req);
    const cols = parseSize(payload.cols, DEFAULT_COLS, 20, 400);
    const rows = parseSize(payload.rows, DEFAULT_ROWS, 5, 200);
    if (cols === null || rows === null) {
      res.status(400).json({ error: 'invalid_size' });
      return;
    }
    try {
      deps.sshSessions?.resize(sessionId, cols, rows);
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        res.status(404).json({ error: 'session_not_found' });
        return;
      }
      throw error;
    }
    res.status(204).end();
  });

  // --- DELETE /api/ssh/sessions/:id ---------------------------------------
  app.delete(routePath(ENDPOINTS.ssh_terminal_close), (req, res) => {
    if (!passGate(req, res)) {
      return;
    }
    const sessionId = param(req, 'session_id');
    const manager = deps.sshSessions;
    if (!sessionExists(manager, sessionId)) {
      res.status(404).json({ error: 'session_not_found' });
      return;
    }
    try {
      manager?.close(sessionId);
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        res.status(404).json({ error: 'session_not_found' });
        return;
      }
      throw error;
    }
    res.status(204).end();
  });

  // --- GET /api/ssh/sessions/:id/stream (SSE) -----------------------------
  app.get(routePath(ENDPOINTS.ssh_terminal_stream), (req, res) => {
    if (!passGate(req, res)) {
      return;
    }
    const sessionId = param(req, 'session_id');
    const manager = deps.sshSessions;
    if (!sessionExists(manager, sessionId)) {
      res.status(404).json({ error: 'session_not_found' });
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    void (async () => {
      try {
        for await (const chunk of manager!.stream(sessionId)) {
          const empty =
            typeof chunk === 'string' ? chunk.length === 0 : chunk.byteLength === 0;
          if (empty) {
            res.write(': keepalive\n\n');
          } else {
            res.write(`data: ${Buffer.from(chunk).toString('base64')}\n\n`);
          }
        }
      } catch {
        // The oracle records an `error` outcome and still closes the session.
      } finally {
        try {
          manager?.close(sessionId);
        } catch {
          // ignore close failures on an already-terminated stream
        }
        res.end();
      }
    })();
  });
}
