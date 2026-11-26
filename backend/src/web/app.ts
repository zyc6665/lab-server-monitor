/**
 * Express application factory for the desktop rewrite web layer.
 *
 * Mirrors the Flask `create_app` + `before_request` architecture of the Python
 * oracle (`servermanage/web/__init__.py` and
 * `servermanage/web/routes/_core.py::_require_request`), but in Express:
 *
 *   request -> body parser -> ①setup -> ②csrf -> ③auth -> ④usermode
 *           -> routes (registerRoutes) -> 404 -> error handler
 *
 * Configuration is derived from the injected database (settings + secrets), so
 * the same `db` used by the rest of the backend drives session lifetime, auth
 * enabled, first-run setup state and the active view mode.
 */
import { assetPath } from '../assets';
import express, { type Express, type RequestHandler } from 'express';

import type { AppConfig } from '../config/config';
import { loadEffectiveSettings, publicSettings } from '../config/service';
import { DEFAULT_SESSION_LIFETIME_HOURS, SessionManager, resolveSessionSecret } from './session';
import { setupGuard } from './middleware/setup-guard';
import { csrf } from './middleware/csrf';
import { auth } from './middleware/auth';
import { usermode, type ViewMode } from './middleware/usermode';
import { errorHandler, notFoundHandler, type ErrorLogger } from './middleware/errors';

type SqliteDatabase = import('better-sqlite3').Database;

/** Optional collaborators supplied by the caller / tests. */
export interface WebServices {
  /** Server-side error sink (defaults to no logging). */
  logger?: ErrorLogger;
}

/** Options accepted by {@link createWebApp}. */
export interface CreateWebAppOptions {
  /** Open SQLite handle (settings + secrets + session secret store). */
  db: SqliteDatabase;
  /** Resolved runtime config (only `appVersion` is read here). */
  config: AppConfig;
  /** Optional services (logger). */
  services?: WebServices;
  /** Route registration hook; called after the gate chain is installed. */
  registerRoutes?: (app: Express) => void;
  /** Static root override (defaults to `servermanage/web/static`). */
  staticDir?: string;
  /** Disable the static mount (tests that do not need it). */
  mountStatic?: boolean;
}

/** Values resolved from the DB that drive the gate chain. */
export interface ResolvedWebSettings {
  setupRequired: boolean;
  authEnabled: boolean;
  sessionLifetimeHours: number;
  mode: ViewMode | string;
}

/** Reads the gate-relevant settings from the injected database. */
export function resolveWebSettings(db: SqliteDatabase): ResolvedWebSettings {
  const pub = publicSettings(db);
  const settings = loadEffectiveSettings(db);

  const dashboard = settings.dashboard ?? {};
  const authSection = (dashboard.auth ?? {}) as Record<string, unknown>;
  const monitoring = settings.monitoring ?? {};

  const rawLifetime = Number(dashboard.session_lifetime_hours);
  const sessionLifetimeHours = Number.isFinite(rawLifetime) && rawLifetime > 0
    ? rawLifetime
    : DEFAULT_SESSION_LIFETIME_HOURS;

  const rawMode = monitoring.mode;

  return {
    setupRequired: pub.setup_required === true,
    authEnabled: authSection.enabled !== false,
    sessionLifetimeHours,
    mode: rawMode === 'user' ? 'user' : 'admin',
  };
}

/** Default location of the read-only static assets reused from the oracle. */
function defaultStaticDir(): string {
  return assetPath('web', 'static');
}

/**
 * Builds the fully wired Express application.
 *
 * The returned app has no listening socket; the caller owns `app.listen`.
 */
export function createWebApp(options: CreateWebAppOptions): Express {
  const { db, config, services, registerRoutes } = options;
  const resolved = resolveWebSettings(db);

  const session = new SessionManager({
    secret: resolveSessionSecret(db),
    lifetimeHours: resolved.sessionLifetimeHours,
  });

  const app = express();
  app.disable('x-powered-by');

  // Body parsing must precede CSRF (it reads the `_csrf` form field).
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // ① setup -> ② csrf -> ③ auth -> ④ usermode
  // Re-read the setup state per request so a freshly created admin credential
  // unblocks the same app instance (the Python oracle reads it dynamically too).
  app.use(setupGuard({ required: () => publicSettings(db).setup_required === true }));
  app.use(csrf(session));
  app.use(auth(session, { enabled: resolved.authEnabled }));
  app.use(usermode({ mode: resolved.mode }));

  // Read-only static assets (reused from the Flask app).
  if (options.mountStatic !== false) {
    app.use('/static', express.static(options.staticDir ?? defaultStaticDir(), { fallthrough: true }));
  }

  // Route injection point for downstream tasks.
  if (registerRoutes) {
    registerRoutes(app);
  } else {
    const version = config?.appVersion ?? '0.0.0';
    const health: RequestHandler = (_req, res) => {
      res.status(200).json({ status: 'ok', version });
    };
    app.get('/api/system/health', health);
  }

  app.use(notFoundHandler());
  app.use(errorHandler({ logger: services?.logger }));

  // Expose collaborators for later tasks / tests.
  app.locals.session = session;
  app.locals.webSettings = resolved;

  return app;
}

/**
 * Public factory name used by the plan / downstream tasks.
 *
 * Alias of {@link createWebApp} (`createWebApp` is the descriptive internal
 * name; `createApp` is the interface the plan and route tasks import).
 */
export const createApp = createWebApp;
