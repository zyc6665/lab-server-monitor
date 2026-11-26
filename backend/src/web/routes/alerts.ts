/**
 * Alerts routes — the Express equivalent of
 * `servermanage/web/routes/alerts.py` (P2 Task 13).
 *
 * Registers the alert surface with the same URL rules, HTTP methods, JSON
 * field names, status codes and template context keys as the Python oracle:
 *
 *   GET    /alerts                                alerts page (`alerts.html`)
 *   GET    /api/alerts                            filtered alert list + counts
 *   POST   /api/alerts/{alert_id}/ack             acknowledge one alert
 *   GET    /api/settings/silences                 list silences
 *   POST   /api/settings/silences                 create one silence
 *   DELETE /api/settings/silences/{silence_id}    delete one silence
 *
 * Behaviour mirrored from the oracle:
 *   - alert status filter defaults to `active`; only
 *     `{active, acknowledged, resolved, all}` are accepted (else `active`)
 *   - alert range filter is one of `{24h, 7d, 30d}`; an unknown non-empty
 *     range on the JSON API -> 400 `{error:"invalid range"}`
 *   - acknowledging a missing alert id is a no-op success (`{ok:true}`),
 *     matching `storage.update_alert`'s silent update
 *   - silences are only writable when `dpapiAvailable()` (or an injected
 *     `writable`); otherwise 409 `{error:"settings_not_writable"}`
 *   - a non-object silence payload -> 400 `{error:"invalid_payload"}`;
 *     invalid silence values -> 400 `{error:<message>}` (SilencesError)
 *   - deleting a missing silence -> 404 `{error:"not_found"}`
 *
 * The middleware gate chain (setup / CSRF / auth / user-mode) is installed by
 * `createWebApp`; this module only registers handlers.
 */
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';

import type { AppConfig } from '../../config/config';
import { loadEffectiveSettings } from '../../config/service';
import {
  addSilence,
  deleteSilence,
  listSilences,
  SilencesError,
  type SilenceHost,
} from '../../config/silences';
import {
  countAlertsByStatus,
  listAlerts,
  updateAlert,
  type AlertRow,
} from '../../storage/alerts';
import { dpapiAvailable } from '../../storage/dpapi';
import { nowIsoUtc } from '../../storage/time';
import { createTemplating, type Templating } from '../templating';
import { ENDPOINTS } from './registry';
import { toLocalIso as sharedToLocalIso } from '../local-iso';

type SqliteDatabase = import('better-sqlite3').Database;
type Obj = Record<string, unknown>;

/** Alert time-range presets (mirrors `_ALERT_RANGE_HOURS`). */
const ALERT_RANGE_HOURS: Readonly<Record<string, number>> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

/** Accepted alert status filters (mirrors `_ALERT_STATUS_FILTERS`). */
const ALERT_STATUS_FILTERS: ReadonlySet<string> = new Set([
  'active',
  'acknowledged',
  'resolved',
  'all',
]);

/** Injected dependencies. Only `db` + `config` are required. */
export interface AlertsRouteDeps {
  /** Open SQLite handle (alerts + silences). */
  db: SqliteDatabase;
  /** Resolved runtime config (host/port/servers/appVersion). */
  config: AppConfig;
  /** Pre-built templating bundle (defaults to a fresh one). */
  templating?: Templating;
  /** `APP_VERSION` used by the templating bundle when `templating` is absent. */
  appVersion?: string;
  /**
   * Whether settings (silences) are writable on this platform. Defaults to
   * `dpapiAvailable()`. A function is re-evaluated per request.
   */
  writable?: boolean | (() => boolean);
}

/** Converts an `ENDPOINTS` template (`/x/{name}`) into an Express path. */
function routePath(template: string): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ':$1');
}

/** Wraps a handler so rejected promises reach the Express error handler. */
function wrap(fn: (req: Request, res: Response) => unknown): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

/** Plain-object check (matches Python's `isinstance(payload, dict)`). */
function isPlainObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerces a settings fragment to a plain object (`_as_obj`). */
function asObj(value: unknown): Obj {
  return isPlainObject(value) ? value : {};
}

/** Reads the first value of a possibly-repeated query parameter. */
function firstQuery(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const first = value[0];
    return first === undefined || first === null ? undefined : String(first);
  }
  return value === undefined || value === null ? undefined : String(value);
}

/** Python `_truthy_arg`: `None`→default; bool→itself; else trimmed string not in the falsy set. */
function truthyArg(value: unknown, defaultValue = false): boolean {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  return !['0', 'false', 'no', 'off', ''].includes(text);
}

/** `_alert_status_filter`: strip and keep only known filters, else `active`. */
function alertStatusFilter(value: unknown): string {
  const status = String(value ?? '').trim();
  return ALERT_STATUS_FILTERS.has(status) ? status : 'active';
}

/** `_alert_range_since`: the earliest timestamp for a preset, or `null`. */
function alertRangeSince(rangeKey: string): Date | null {
  const key = String(rangeKey ?? '').trim();
  if (!Object.prototype.hasOwnProperty.call(ALERT_RANGE_HOURS, key)) return null;
  return new Date(Date.now() - ALERT_RANGE_HOURS[key] * 60 * 60 * 1000);
}

/** Formats an instant as an offset-qualified ISO string in `timeZone`. */
function toLocalIso(value: unknown, timeZone: string): string | null {
  return sharedToLocalIso(value, timeZone) as string | null;
}

/** Resolves the configured display timezone (defaults to `Asia/Shanghai`). */
function readTimezone(db: SqliteDatabase): string {
  const settings = loadEffectiveSettings(db);
  const monitoring = asObj(settings.monitoring);
  const rawTz = monitoring.timezone;
  return typeof rawTz === 'string' && rawTz ? rawTz : 'Asia/Shanghai';
}

/** `_localize_alerts`: copy each row with `created_at` in the display timezone. */
function localizeAlerts(rows: AlertRow[], timeZone: string): AlertRow[] {
  return rows.map((row) => ({ ...row, created_at: toLocalIso(row.created_at, timeZone) as string }));
}

/** Registers the alerts page + API routes on `app`. */
export function registerAlertsRoutes(app: Express, deps: AlertsRouteDeps): void {
  const { db, config } = deps;
  const templating = deps.templating ?? createTemplating({ appVersion: deps.appVersion });

  const isWritable = (): boolean => {
    if (deps.writable === undefined) return dpapiAvailable();
    return typeof deps.writable === 'function' ? deps.writable() : deps.writable;
  };

  /** JSON body when the request is JSON, else `null` (matches `get_json(silent=True)`). */
  const jsonBody = (req: Request): unknown => (req.is('application/json') ? req.body : null);

  /** Parses an `<int:...>` route segment; returns `null` for non-integers. */
  const intParam = (value: string | string[] | undefined): number | null => {
    const text = String(Array.isArray(value) ? (value[0] ?? '') : (value ?? '')).trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  };

  /** The current session username, or `null` (matches `session.get("username")`). */
  const currentUser = (req: Request): string | null => {
    const session = req.app.locals.session as
      | { getSession?: (req: Request) => { username?: string | null } | null }
      | undefined;
    return session?.getSession?.(req)?.username ?? null;
  };

  const hosts = (): SilenceHost[] =>
    config.servers.map((server) => ({ name: server.name, group: server.group }));

  // --- Alerts page -------------------------------------------------------

  app.get(
    ENDPOINTS.alerts_page,
    wrap((req, res) => {
      let rangeKey = String(firstQuery(req.query.range) ?? '').trim();
      if (!Object.prototype.hasOwnProperty.call(ALERT_RANGE_HOURS, rangeKey)) rangeKey = '';
      const alertStatus = alertStatusFilter(firstQuery(req.query.status));
      const since = alertRangeSince(rangeKey);
      const timeZone = readTimezone(db);
      const alerts = localizeAlerts(
        listAlerts(db, { status: alertStatus === 'all' ? null : alertStatus, since }),
        timeZone,
      );
      templating.renderPage(res, 'alerts.html', {
        active_page: 'alerts',
        alerts,
        hosts: config.servers.map((server) => server.name),
        alert_range: rangeKey,
        alert_status: alertStatus,
        alert_counts: countAlertsByStatus(db, { since }),
      });
    }),
  );

  // --- Alerts API --------------------------------------------------------

  app.get(
    ENDPOINTS.api_alerts,
    wrap((req, res) => {
      const statusFilter = alertStatusFilter(firstQuery(req.query.status));
      const status = statusFilter === 'all' ? null : statusFilter;
      const rangeKey = String(firstQuery(req.query.range) ?? '').trim();
      if (rangeKey && !Object.prototype.hasOwnProperty.call(ALERT_RANGE_HOURS, rangeKey)) {
        res.status(400).json({ error: 'invalid range' });
        return;
      }
      const since = alertRangeSince(rangeKey);
      const timeZone = readTimezone(db);
      const alerts = localizeAlerts(listAlerts(db, { status, since }), timeZone);
      res.json({ alerts, counts: countAlertsByStatus(db, { since }) });
    }),
  );

  app.post(
    routePath(ENDPOINTS.api_ack_alert),
    wrap((req, res) => {
      const alertId = intParam(req.params.alert_id);
      if (alertId !== null) {
        updateAlert(db, alertId, { status: 'acknowledged', ackAt: nowIsoUtc() });
      }
      res.json({ ok: true });
    }),
  );

  // --- Silences API ------------------------------------------------------

  app.get(
    ENDPOINTS.api_list_silences,
    wrap((req, res) => {
      const activeOnly = truthyArg(firstQuery(req.query.active_only), true);
      res.json({ silences: listSilences(db, { activeOnly }) });
    }),
  );

  app.post(
    ENDPOINTS.api_add_silence,
    wrap((req, res) => {
      if (!isWritable()) {
        res.status(409).json({ error: 'settings_not_writable' });
        return;
      }
      const payload = jsonBody(req);
      if (!isPlainObject(payload)) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      try {
        const reason = payload.reason ? String(payload.reason) : '';
        const id = addSilence(
          db,
          payload.scope_type as string,
          payload.scope as string | null | undefined,
          reason,
          payload.starts_at as string,
          payload.ends_at as string,
          currentUser(req),
          { writable: true, hosts: hosts() },
        );
        res.json({ ok: true, id });
      } catch (err) {
        if (err instanceof SilencesError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    }),
  );

  app.delete(
    routePath(ENDPOINTS.api_delete_silence),
    wrap((req, res) => {
      if (!isWritable()) {
        res.status(409).json({ error: 'settings_not_writable' });
        return;
      }
      const silenceId = intParam(req.params.silence_id);
      if (silenceId === null || !deleteSilence(db, silenceId)) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ ok: true });
    }),
  );
}
