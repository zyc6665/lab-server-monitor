/**
 * Settings routes — the Express equivalent of
 * `servermanage/web/routes/settings_api.py` (P2 Task 12).
 *
 * Registers the settings surface with the same URL rules, HTTP methods, JSON
 * field names, status codes and template context keys as the Python oracle:
 *
 *   GET  /settings                      settings page (`settings.html` /
 *                                       `settings_user.html` in user mode)
 *   GET  /api/settings                  masked effective settings
 *   PUT  /api/settings/<section>        validate + persist one section
 *   POST /api/settings/test-ssh         ad-hoc SSH connectivity probe
 *   POST /api/settings/test-email       SMTP connect + login probe
 *   POST /api/settings/test-desktop     desktop notification probe
 *   POST /api/settings/test-webhook     outbound webhook probe
 *
 * Content/behaviour rules mirrored from the oracle:
 *   - unknown section -> 404 `{error:"unknown_section"}`
 *   - non-object payload -> 400 `{error:"invalid_payload"}`
 *   - settings not writable -> 409 `{error:"settings_not_writable"}`
 *   - user mode may only PUT section `monitoring` with keys
 *     `{mode, member_account}`; anything else -> 403
 *     `{error:"admin_only", message:"用户模式下只能修改使用模式与账号名"}`
 *   - `dashboard` saves report `restart_required:true`
 *   - test endpoints always return HTTP 200 with `{ok, detail}` (except the
 *     invalid-payload 400), exactly like the oracle.
 *
 * Outbound dial-outs (SSH / SMTP / desktop / webhook) are delegated to
 * injected collaborators in {@link SettingsRouteDeps} so tests never open a
 * real connection and the route module stays free of new dependencies.
 *
 * The middleware gate chain (setup / CSRF / auth / user-mode) is installed by
 * `createWebApp`; this module only registers handlers.
 */
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';

import type { AppConfig } from '../../config/config';
import {
  SettingsServiceError,
  loadEffectiveSettings,
  publicSettings,
  saveSection,
  type PublicSettings,
} from '../../config/service';
import { SECRET_SMTP_PASSWORD } from '../../config/secrets';
import { listConfigHistory } from '../../storage/config-history';
import { listHosts } from '../../config/hosts';
import { listSilences } from '../../config/silences';
import { dpapiAvailable, unprotect } from '../../storage/dpapi';
import { getSecret } from '../../storage/secrets';
import { assertSafeTarget, SSRFError } from '../security/ssrf';
import { createTemplating, type Templating } from '../templating';
import { ENDPOINTS } from './registry';

type SqliteDatabase = import('better-sqlite3').Database;
type Obj = Record<string, unknown>;

/** Sections writable through `PUT /api/settings/<section>` (hosts excluded). */
const ALLOWED_SETTINGS_SECTIONS: ReadonlySet<string> = new Set([
  'monitoring',
  'dashboard',
  'alerts',
  'smtp',
  'report',
  'disk_health',
  'ssh',
  'user_monitoring',
]);

/** Keys a user-mode operator may touch inside the `monitoring` section. */
const USER_MODE_SETTINGS_KEYS: ReadonlySet<string> = new Set(['mode', 'member_account']);

/** SMTP settings handed to the injected connect/login tester. */
export interface SmtpTestConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  use_ssl: boolean;
}

/** Webhook settings handed to the injected sender. */
export interface WebhookTestConfig {
  enabled: boolean;
  type: string;
  url: string;
}

/** Desktop notification payload for the injected sender. */
export interface DesktopTestConfig {
  title: string;
  message: string;
}

/** Injected settings collaborators. Only `db` + `config` are required. */
export interface SettingsRouteDeps {
  /** Open SQLite handle (settings + secrets). */
  db: SqliteDatabase;
  /** Resolved runtime config (host/port/servers/appVersion). */
  config: AppConfig;
  /** Pre-built templating bundle (defaults to a fresh one). */
  templating?: Templating;
  /** `APP_VERSION` used by the templating bundle when `templating` is absent. */
  appVersion?: string;
  /**
   * Whether settings are writable on this platform. Defaults to
   * `dpapiAvailable()`. A function is re-evaluated per request.
   */
  writable?: boolean | (() => boolean);
  /** SSH `echo ok` probe; resolves to stdout text, throws on failure. */
  testSsh?: (payload: Obj) => Promise<string> | string;
  /** SMTP connect + login probe; resolves on success, throws on failure. */
  testSmtp?: (config: SmtpTestConfig) => Promise<void> | void;
  /** Desktop notification sender; returns whether it was delivered. */
  sendDesktopNotification?: (config: DesktopTestConfig) => boolean;
  /** Webhook sender; returns whether it was delivered. */
  sendWebhook?: (config: WebhookTestConfig, event: Obj) => boolean;
}

/** Converts an `ENDPOINTS` template (`/x/{name}`) into an Express path. */
function routePath(template: string): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ':$1');
}

/** Wraps an async handler so rejected promises reach the Express error handler. */
function wrap(fn: (req: Request, res: Response) => unknown): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

/** Plain-object check (matches Python's `isinstance(payload, dict)`). */
function isPlainObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `_as_int(value, default)` with a bounded integer result. */
function asInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/** Python `bool()` semantics for the payload fragments the oracle coerces. */
function asBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    return !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}

/** Reads the active view mode from the middleware-resolved locals. */
function sessionUsername(req: Request): string | null {
  const locals = (req.app && (req.app.locals as Record<string, unknown>)) || {};
  const session = locals['session'] as { getSession?: (r: Request) => { username?: string | null } | null } | undefined;
  try {
    return session?.getSession?.(req)?.username ?? null;
  } catch {
    return null;
  }
}

function viewMode(req: Request): string {
  const settings = req.app.locals.webSettings as { mode?: string } | undefined;
  return settings?.mode === 'user' ? 'user' : 'admin';
}

/** Builds the config view the `settings.html` template expects. */
function templateConfig(config: AppConfig): Obj {
  return {
    ...config,
    dashboard: { host: config.host, port: config.port },
  };
}

/** The masked settings payload plus the host inventory the page/API expects. */
function buildSettings(db: SqliteDatabase, config: AppConfig, writable: boolean): PublicSettings {
  const payload = publicSettings(db);
  payload.version = config.appVersion || payload.version;
  try {
    payload.hosts = listHosts(db, { writable, baseServers: config.servers });
  } catch {
    // A corrupt host section must not take the whole settings page down.
    payload.hosts = [];
  }
  return payload;
}

/** Registers the settings page + API routes on `app`. */
export function registerSettingsRoutes(app: Express, deps: SettingsRouteDeps): void {
  const { db, config } = deps;
  const templating = deps.templating ?? createTemplating({ appVersion: deps.appVersion });

  const isWritable = (): boolean => {
    if (deps.writable === undefined) return dpapiAvailable();
    return typeof deps.writable === 'function' ? deps.writable() : deps.writable;
  };

  /** Runs the SSRF guard; returns a rejection detail string or `null`. */
  const rejectUnsafe = async (target: string): Promise<string | null> => {
    const allowlist = new Set<string>();
    for (const server of config.servers) {
      allowlist.add(server.host);
      allowlist.add(server.name);
    }
    try {
      for (const host of listHosts(db, { writable: isWritable(), baseServers: config.servers })) {
        allowlist.add(host.host);
        allowlist.add(host.name);
      }
    } catch {
      // A missing/corrupt host section simply yields a smaller allow-list.
    }
    try {
      await assertSafeTarget(target, { allowlist });
      return null;
    } catch (err) {
      if (err instanceof SSRFError) return err.message;
      throw err;
    }
  };

  // =========================================================================
  // Pages
  // =========================================================================

  app.get(ENDPOINTS.settings_page, (req: Request, res: Response) => {
    if (viewMode(req) === 'user') {
      const settings = loadEffectiveSettings(db);
      const member = String(settings.monitoring?.member_account ?? '');
      templating.renderPage(res, 'settings_user.html', {
        active_page: 'settings',
        member,
        version: config.appVersion,
        desktop_mode: process.env.SERVERMONITOR_DESKTOP === '1',
      });
      return;
    }
    const settings = buildSettings(db, config, isWritable());
    const silences = listSilences(db, { activeOnly: true });
    templating.renderPage(res, 'settings.html', {
      active_page: 'settings',
      config: templateConfig(config),
      settings,
      runtime: {},
      silences,
    });
  });

  // =========================================================================
  // Settings read / write
  // =========================================================================

  app.get(ENDPOINTS.api_get_settings, (_req: Request, res: Response) => {
    res.json(buildSettings(db, config, isWritable()));
  });

  app.put(routePath(ENDPOINTS.api_put_settings_section), (req: Request, res: Response) => {
    if (!isWritable()) {
      res.status(409).json({ error: 'settings_not_writable' });
      return;
    }
    const section = String(req.params['section'] ?? '');
    if (!ALLOWED_SETTINGS_SECTIONS.has(section)) {
      res.status(404).json({ error: 'unknown_section' });
      return;
    }
    const payload = req.body as unknown;
    if (!isPlainObject(payload)) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (viewMode(req) === 'user') {
      const extra = Object.keys(payload).filter((key) => !USER_MODE_SETTINGS_KEYS.has(key));
      if (section !== 'monitoring' || extra.length > 0) {
        res.status(403).json({
          error: 'admin_only',
          message: '用户模式下只能修改使用模式与账号名',
        });
        return;
      }
    }
    try {
      const changedBy = sessionUsername(req) ?? 'admin';
      const { restartRequired } = saveSection(db, section, payload, { changedBy });
      res.json({ ok: true, restart_required: section === 'dashboard' && restartRequired });
    } catch (err) {
      if (err instanceof SettingsServiceError) {
        res.status(err.status).json({
          error: err.message,
          ...(err.errors.length > 0 ? { errors: err.errors } : {}),
        });
        return;
      }
      throw err;
    }
  });

  app.get(ENDPOINTS.api_settings_history, (req: Request, res: Response) => {
    const raw = Number.parseInt(String(req.query['limit'] ?? '20'), 10);
    const limit = Number.isFinite(raw) ? Math.max(1, Math.min(50, raw)) : 20;
    res.json({ history: listConfigHistory(db, { limit }) });
  });

  // =========================================================================
  // Connectivity tests
  // =========================================================================

  app.post(
    ENDPOINTS.api_test_ssh,
    wrap(async (req: Request, res: Response) => {
      const payload = req.body as unknown;
      if (!isPlainObject(payload)) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const host = String(payload.host ?? '').trim();
      if (host === '') {
        res.json({ ok: false, detail: 'host 不能为空' });
        return;
      }
      const blocked = await rejectUnsafe(host);
      if (blocked !== null) {
        res.json({ ok: false, detail: blocked });
        return;
      }
      try {
        if (deps.testSsh === undefined) {
          throw new Error('SSH 连接测试不可用');
        }
        const stdout = await deps.testSsh(payload);
        res.json({ ok: true, detail: String(stdout ?? '') });
      } catch (err) {
        res.json({ ok: false, detail: errorMessage(err) });
      }
    }),
  );

  app.post(
    ENDPOINTS.api_test_email,
    wrap(async (req: Request, res: Response) => {
      const payload = req.body as unknown;
      if (!isPlainObject(payload)) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const host = String(payload.host ?? '').trim();
      if (host === '') {
        res.json({ ok: false, detail: 'host 不能为空' });
        return;
      }
      const blocked = await rejectUnsafe(host);
      if (blocked !== null) {
        res.json({ ok: false, detail: blocked });
        return;
      }
      let password = String(payload.password ?? '');
      if (password === '') {
        password = readSecretText(db, SECRET_SMTP_PASSWORD);
      }
      try {
        if (deps.testSmtp === undefined) {
          throw new Error('SMTP 连接测试不可用');
        }
        await deps.testSmtp({
          host,
          port: asInt(payload.port, 25),
          username: String(payload.username ?? ''),
          password,
          use_ssl: asBool(payload.use_ssl),
        });
        res.json({ ok: true, detail: 'SMTP 连接与登录成功' });
      } catch (err) {
        res.json({ ok: false, detail: errorMessage(err) });
      }
    }),
  );

  app.post(ENDPOINTS.api_test_desktop, (_req: Request, res: Response) => {
    const sent = deps.sendDesktopNotification
      ? deps.sendDesktopNotification({
          title: '服务器监控 · 测试通知',
          message: '这是一条来自设置页的桌面通知测试',
        })
      : false;
    res.json({
      ok: Boolean(sent),
      detail: sent ? '已发送桌面通知' : '桌面通知发送失败（可能当前不在 Windows 桌面会话中）',
    });
  });

  app.post(
    ENDPOINTS.api_test_webhook,
    wrap(async (req: Request, res: Response) => {
      const payload = req.body as unknown;
      if (!isPlainObject(payload)) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const url = String(payload.url ?? '').trim();
      if (url === '') {
        res.json({ ok: false, detail: 'url 不能为空' });
        return;
      }
      const blocked = await rejectUnsafe(url);
      if (blocked !== null) {
        res.json({ ok: false, detail: blocked });
        return;
      }
      const type = String(payload.type ?? 'generic');
      try {
        if (deps.sendWebhook === undefined) {
          throw new Error('Webhook 发送不可用');
        }
        const sent = deps.sendWebhook(
          { enabled: true, type, url },
          {
            host_name: 'test',
            category: 'test',
            severity: 'info',
            title: 'Webhook 测试',
            message: '这是一条来自设置页的测试通知',
            fingerprint: 'settings:test-webhook',
          },
        );
        res.json({ ok: Boolean(sent), detail: sent ? '已发送' : '发送失败' });
      } catch (err) {
        res.json({ ok: false, detail: errorMessage(err) });
      }
    }),
  );
}

/** Reads and unprotects a stored secret as UTF-8 text (`''` when absent). */
function readSecretText(db: SqliteDatabase, name: string): string {
  const ciphertext = getSecret(db, name);
  if (ciphertext === null) return '';
  try {
    return unprotect(ciphertext).toString('utf8');
  } catch {
    return '';
  }
}

/** Extracts a user-facing message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
