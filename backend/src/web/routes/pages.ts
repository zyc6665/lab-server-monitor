/**
 * Lightweight pages — the Express equivalent of
 * `servermanage/web/routes/pages.py` (P2 Task 16).
 *
 * Registers the same five GET endpoints with the same template context keys:
 *
 *   GET /compute            compute summary page (`compute.html`)
 *   GET /api/compute        the same summary as JSON
 *   GET /my                 "my account" page (`my.html`)
 *   GET /api/my/summary     my-account summary as JSON
 *   GET /terminal           SSH terminal shell (`terminal.html`)
 *
 * The Python oracle builds its payloads with `compute_mod.build_compute_summary`
 * and `_core._build_my_summary`. The compute builder is ported
 * (`collect/compute.ts`) and {@link defaultBuildComputeSummary} delegates to it,
 * so the fallback matches the composition-root builder field for field. The
 * my-account builder is still injectable through {@link PagesRouteDeps} and its
 * default stays the documented empty structure (never fabricated).
 *
 * The middleware chain (setup / CSRF / auth / user-mode) is installed by
 * `createWebApp`; this module only registers handlers.
 */
import type { Express } from 'express';

import { buildComputeSummary } from '../../collect/compute';
import type { AppConfig } from '../../config/config';
import { loadEffectiveSettings } from '../../config/service';
import { getAllHostSnapshots } from '../../storage/hosts';
import { createTemplating, type Templating } from '../templating';
import { buildMyAccountsPayload } from './users';
import { ENDPOINTS } from './registry';

type SqliteDatabase = import('better-sqlite3').Database;
type Obj = Record<string, unknown>;

/** `_view_mode`: the effective dashboard mode (`admin` unless explicitly `user`). */
function readViewMode(db: SqliteDatabase): string {
  const settings = loadEffectiveSettings(db);
  const monitoring = asObj(settings.monitoring);
  return monitoring.mode === 'user' ? 'user' : 'admin';
}

/** `_member_account`: the configured member account (empty when unset). */
function readMemberAccount(db: SqliteDatabase): string {
  const settings = loadEffectiveSettings(db);
  const monitoring = asObj(settings.monitoring);
  const member = monitoring.member_account;
  return typeof member === 'string' ? member : '';
}

/** True when the process is the local desktop client (`SERVERMONITOR_DESKTOP`). */
function isDesktopMode(): boolean {
  return process.env.SERVERMONITOR_DESKTOP === '1';
}

/** Narrow an unknown value to a plain object. */
function asObj(value: unknown): Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Obj)
    : {};
}

/**
 * Default compute summary builder.
 *
 * Delegates to the migrated `collect/compute.ts` builder (the same one the
 * composition root injects), so the A100/H100 spec table, tiers and totals are
 * identical whether the route runs with injected deps or these defaults. Server
 * labels are mapped like `composition.ts` (`host` → `address`).
 */
export function defaultBuildComputeSummary(
  db: SqliteDatabase,
  config: AppConfig,
): unknown {
  return buildComputeSummary(getAllHostSnapshots(db), {
    servers: config.servers.map((server) => ({
      name: server.name,
      address: server.host,
      group: server.group,
    })),
  });
}

/**
 * Default my-account summary builder.
 *
 * Delegates to {@link buildMyAccountsPayload}, the Node port of
 * `_build_my_summary` (`servermanage/web/routes/_core.py:1669`): it filters the
 * user-monitoring payload down to the signed-in member's accounts.
 */
export function defaultBuildMySummary(db: SqliteDatabase, config: AppConfig): Obj {
  return buildMyAccountsPayload({ db, config });
}

/** Injected dependencies. Only `db` + `config` are required. */
export interface PagesRouteDeps {
  /** Open SQLite handle (snapshots + settings). */
  db: SqliteDatabase;
  /** Resolved runtime config (servers, app version, paths). */
  config: AppConfig;
  /** Pre-built templating bundle (defaults to a fresh one). */
  templating?: Templating;
  /** `APP_VERSION` used by the templating bundle when `templating` is absent. */
  appVersion?: string;
  /**
   * Compute-summary builder. Defaults to {@link defaultBuildComputeSummary},
   * which delegates to the migrated `collect/compute.ts` module.
   */
  buildComputeSummary?: (db: SqliteDatabase, config: AppConfig) => unknown;
  /**
   * My-account summary builder. Defaults to {@link defaultBuildMySummary}.
   * The Python `_core._build_my_summary` is not ported yet.
   */
  buildMySummary?: (db: SqliteDatabase, config: AppConfig) => unknown;
}

/**
 * Registers the compute / my / terminal pages and their JSON APIs on `app`.
 *
 * @param app  Express application (middleware chain already installed).
 * @param deps Open DB handle, resolved config and optional builder/templating
 *             overrides.
 */
export function registerPagesRoutes(app: Express, deps: PagesRouteDeps): void {
  const { db, config } = deps;
  const templating = deps.templating ?? createTemplating({ appVersion: deps.appVersion });
  const buildCompute = deps.buildComputeSummary ?? defaultBuildComputeSummary;
  const buildMy = deps.buildMySummary ?? defaultBuildMySummary;

  const computeSummary = (): unknown => buildCompute(db, config);

  app.get(ENDPOINTS.compute_page, (_req, res) => {
    templating.renderPage(res, 'compute.html', {
      active_page: 'compute',
      summary: computeSummary(),
    });
  });

  app.get(ENDPOINTS.api_compute, (_req, res) => {
    res.json(computeSummary());
  });

  app.get(ENDPOINTS.my_page, (_req, res) => {
    templating.renderPage(res, 'my.html', {
      active_page: 'my',
      member: readMemberAccount(db),
      mode: readViewMode(db),
    });
  });

  app.get(ENDPOINTS.api_my_summary, (_req, res) => {
    res.json(buildMy(db, config));
  });

  app.get(ENDPOINTS.terminal_page, (_req, res) => {
    const hosts = config.servers.map((server) => ({
      name: server.name,
      host: server.host,
      group: server.group,
    }));
    templating.renderPage(res, 'terminal.html', {
      active_page: 'terminal',
      hosts,
      desktop_mode: isDesktopMode(),
    });
  });
}
