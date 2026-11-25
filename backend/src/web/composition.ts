/**
 * Composition root for the desktop rewrite web layer (P2 Task 17).
 *
 * `createWebApp` (see `./app.ts`) installs the middleware gate chain and then
 * hands the Express instance to a `registerRoutes` hook. This module is that
 * hook: it wires every route module implemented during P2 into a single
 * application, injecting cross-module collaborators where one module needs
 * another's builders (notably `hosts` reusing the `overview` builders instead
 * of its local fallback stubs).
 *
 * Registration order mirrors the Python oracle's blueprint registration and the
 * order listed in the P2 plan:
 *
 *   auth → overview → hosts → settings → alerts → users → system
 *        → pages → disk-health → ssh-terminal
 *
 * Anything still unmigrated (the SSH session manager, the users monitor/admin
 * APIs, real compute/my summaries) stays `undefined` so the corresponding
 * routes keep their documented placeholder behaviour (e.g. terminal `create`
 * returns `502 ssh_failed`).
 */
import type { Express } from 'express';

import type { AppConfig } from '../config/config';
import { createWebApp } from './app';
import { registerAuthRoutes, type AuthRouteDeps } from './routes/auth';
import {
  createOverviewBuilders,
  registerOverviewRoutes,
  type OverviewRouteDeps,
} from './routes/overview';
import { registerHostsRoutes, type HostsRouteDeps } from './routes/hosts';
import { registerSettingsRoutes, type SettingsRouteDeps } from './routes/settings';
import { registerAlertsRoutes, type AlertsRouteDeps } from './routes/alerts';
import { registerUsersRoutes, type UsersRouteDeps } from './routes/users';
import { registerSystemRoutes, type SystemRouteDeps } from './routes/system';
import { registerPagesRoutes, type PagesRouteDeps } from './routes/pages';
import { registerDiskHealthRoutes, type DiskHealthRouteDeps } from './routes/disk-health';
import { registerSshTerminalRoutes, type SshTerminalRouteDeps } from './routes/ssh-terminal';

type SqliteDatabase = import('better-sqlite3').Database;

/**
 * Optional per-module dependency overrides accepted by {@link createServerApp}.
 *
 * Every module shares the root `db` + `config`; these partials only replace the
 * remaining collaborators (services, builders, feature flags). Omitted entries
 * fall back to the module defaults.
 */
export interface CompositionDeps {
  auth?: Partial<AuthRouteDeps>;
  overview?: Partial<OverviewRouteDeps>;
  hosts?: Partial<HostsRouteDeps>;
  settings?: Partial<SettingsRouteDeps>;
  alerts?: Partial<AlertsRouteDeps>;
  users?: Partial<UsersRouteDeps>;
  system?: Partial<SystemRouteDeps>;
  pages?: Partial<PagesRouteDeps>;
  diskHealth?: Partial<DiskHealthRouteDeps>;
  sshTerminal?: Partial<SshTerminalRouteDeps>;
}

/** Options accepted by {@link createServerApp}. */
export interface CreateServerAppOptions {
  /** Open SQLite handle shared by every route module. */
  db: SqliteDatabase;
  /** Resolved runtime config (servers, paths, app version). */
  config: AppConfig;
  /** Optional per-module collaborator overrides. */
  deps?: CompositionDeps;
  /** Static-asset root override (defaults to `servermanage/web/static`). */
  staticDir?: string;
  /** Disable the static mount (tests that do not need it). */
  mountStatic?: boolean;
}

/**
 * Builds a {@link CompositionDeps} value with the cross-module wiring that can
 * be derived purely from `db` + `config`.
 *
 * Today that is the `hosts` module reusing the `overview` builders; the factory
 * exists so callers can inspect / extend the derived wiring before passing it to
 * {@link createServerApp}.
 */
export function buildDefaultDeps(db: SqliteDatabase, config: AppConfig): CompositionDeps {
  const overviewBuilders = createOverviewBuilders(db, config);
  return {
    hosts: {
      buildOverview: overviewBuilders.buildOverview,
      buildHostDetail: overviewBuilders.buildHostDetail,
      buildHostReport: overviewBuilders.buildHostReport,
    },
  };
}

/**
 * Builds the fully assembled server application (all P2 routes) without
 * opening a listening socket; the caller owns `app.listen`.
 *
 * @param opts db + config, optional per-module deps and static-mount options.
 */
export function createServerApp(opts: CreateServerAppOptions): Express {
  const { db, config } = opts;
  const appVersion = config.appVersion;
  const overrides = opts.deps ?? {};
  const defaults = buildDefaultDeps(db, config);

  return createWebApp({
    db,
    config,
    staticDir: opts.staticDir,
    mountStatic: opts.mountStatic,
    registerRoutes: (app: Express): void => {
      registerAuthRoutes(app, { ...overrides.auth, db, appVersion });
      registerOverviewRoutes(app, { ...overrides.overview, db, config, appVersion });
      registerHostsRoutes(app, {
        ...defaults.hosts,
        ...overrides.hosts,
        db,
        config,
        appVersion,
      });
      registerSettingsRoutes(app, { ...overrides.settings, db, config, appVersion });
      registerAlertsRoutes(app, { ...overrides.alerts, db, config, appVersion });
      registerUsersRoutes(app, { ...overrides.users, db, config, appVersion });
      registerSystemRoutes(app, { ...overrides.system, db, config, appVersion });
      registerPagesRoutes(app, { ...overrides.pages, db, config, appVersion });
      registerDiskHealthRoutes(app, { ...overrides.diskHealth, db, config, appVersion });
      registerSshTerminalRoutes(app, { ...overrides.sshTerminal, db, config, appVersion });
    },
  });
}
