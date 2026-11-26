/**
 * Settings service: merge the stored `app_settings` rows over the defaults,
 * expose a redacted read view for `GET /api/settings`, and persist section
 * writes for `PUT /api/settings/<section>`.
 *
 * Behaviour mirrors the Python oracle:
 *   - `servermanage/settings/core.py::SettingsServiceBase.load` (base defaults
 *     overlaid section-by-section with the DB payloads)
 *   - `servermanage/settings/sections.py::public_settings` (the masked payload
 *     returned by `GET /api/settings`; secrets are reduced to booleans)
 *   - `servermanage/settings/sections.py::save_section` (validate + persist,
 *     `dashboard` requires a restart)
 *   - `servermanage/web/routes/settings_api.py` (404 for an unknown section,
 *     400 for an invalid payload, `{ok, restart_required}` on success)
 *
 * Pure logic over an injected `better-sqlite3` handle: no HTTP server, no
 * filesystem access. Secrets live in `app_secrets` (see `../storage/secrets`);
 * they are never written into `app_settings` and never echoed in clear text.
 */
import { ConfigError } from './errors';
import { defaultSection, isKnownSection, validateSection, SETTINGS_SCHEMA, SECTION_NAMES } from './schema';
import { deleteAppSettings, loadAppSettings, saveAppSettings } from '../storage/settings';
import { getSecret } from '../storage/secrets';
import { dpapiAvailable } from '../storage/dpapi';
import { APP_VERSION } from '../version';
import {
  assertReportSmtpReady,
  databaseSecretWriter,
  isSmtpReady,
  mergeSections,
  sanitizeSection,
  SectionsError,
  type SecretWriter,
} from './sections';
import { SECRET_ADMIN, SECRET_SMTP_PASSWORD, SECRET_WEBHOOK_URL } from './secrets';

export { SECRET_ADMIN, SECRET_SESSION, SECRET_SMTP_PASSWORD, SECRET_WEBHOOK_URL } from './secrets';

type SqliteDatabase = import('better-sqlite3').Database;

/** One section's effective payload (defaults overlaid with stored values). */
export type SectionPayload = Record<string, unknown>;

/** The full `{section: payload}` effective settings map. */
export type Settings = Record<string, SectionPayload>;

/** Error surface for {@link saveSection} / {@link deleteSection}. */
export interface SettingsServiceErrorOptions {
  /** HTTP status the route layer should map this error to (404 / 400). */
  status: number;
  /** Machine-readable reason (`unknown_section`, `invalid_payload`, `validation_failed`). */
  code: string;
  /** Human-readable validation messages, when the failure came from validation. */
  errors?: string[];
}

/** Thrown on an unknown section (404) or an invalid payload/values (400). */
export class SettingsServiceError extends ConfigError {
  readonly status: number;
  readonly code: string;
  readonly errors: string[];

  constructor(message: string, options: SettingsServiceErrorOptions) {
    super(message);
    this.name = 'SettingsServiceError';
    this.status = options.status;
    this.code = options.code;
    this.errors = options.errors ?? [];
  }
}

/**
 * The masked `GET /api/settings` response body.
 *
 * Section names and nesting mirror `public_settings()` exactly; secret values
 * are replaced by `<field>_configured` booleans.
 */
export interface PublicSettings {
  writable: boolean;
  version: string;
  desktop_mode: boolean;
  setup_required: boolean;
  monitoring: Record<string, unknown>;
  user_monitoring: Record<string, unknown>;
  dashboard: Record<string, unknown>;
  ssh: Record<string, unknown>;
  smtp: Record<string, unknown>;
  alerts: Record<string, unknown>;
  report: Record<string, unknown>;
  disk_health: Record<string, unknown>;
  hosts: unknown[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = cloneValue(item);
    }
    return out as T;
  }
  return value;
}

/**
 * Recursively merge `override` on top of `base`.
 *
 * Plain objects are merged key by key (so a partial nested save keeps the
 * untouched siblings) while arrays and scalars are replaced wholesale — the
 * same "bottom layer + section overlay" semantics as `core.load`.
 */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out = cloneValue(base);
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isPlainObject(value) && isPlainObject(current)
      ? deepMerge(current, value)
      : cloneValue(value);
  }
  return out;
}

/**
 * The effective settings: {@link DEFAULT_SETTINGS} as the bottom layer with
 * each stored section deep-merged in. Unknown sections and non-object payloads
 * are ignored (mirrors `load`'s `_ALLOWED_SECTIONS` / dict checks).
 */
export function loadEffectiveSettings(db: SqliteDatabase): Settings {
  const stored = loadAppSettings(db);
  const settings: Settings = {};
  for (const name of SECTION_NAMES) {
    const base = defaultSection(name);
    const override = stored[name];
    settings[name] = isPlainObject(override) ? deepMerge(base, override) : base;
  }
  return settings;
}

/** Options controlling how {@link saveSection} stores credentials. */
export interface SaveSectionOptions {
  /** DPAPI protector for secret values (defaults to {@link protect}). */
  protect?: (plain: Buffer) => Buffer;
  /** Whether secrets may be written on this platform (defaults to dpapiAvailable()). */
  writable?: boolean;
  /** Secret sink for stripped credentials (defaults to a DB-backed writer). */
  secrets?: SecretWriter;
}

/**
 * Validate one section payload and persist it.
 *
 * - Unknown section -> {@link SettingsServiceError} with `status: 404`.
 * - Non-object payload -> `status: 400`, `code: 'invalid_payload'`.
 * - Invalid values -> `status: 400`, `code: 'validation_failed'` + `errors`.
 *
 * The new values are merged over the *effective* section (defaults + whatever
 * is already stored) before validation, so a partial save never resets fields
 * it did not mention. Credential fields are stripped from the persisted row and
 * written to `app_secrets` (DPAPI-protected) instead.
 *
 * @returns `{restartRequired}` — true only for sections flagged in the schema
 *   (`dashboard`), matching `settings_api.py`'s `restart_required` response.
 */
export function saveSection(
  db: SqliteDatabase,
  section: string,
  payload: unknown,
  options: SaveSectionOptions = {},
): { restartRequired: boolean } {
  if (!isKnownSection(section)) {
    throw new SettingsServiceError(`unknown settings section: ${section}`, {
      status: 404,
      code: 'unknown_section',
    });
  }
  if (!isPlainObject(payload)) {
    throw new SettingsServiceError('settings payload must be an object', {
      status: 400,
      code: 'invalid_payload',
    });
  }

  const current = loadEffectiveSettings(db)[section] ?? defaultSection(section);
  const merged = mergeSections(current, payload);
  const { value, errors } = validateSection(section, merged);
  if (errors.length > 0) {
    throw new SettingsServiceError(errors.join('; '), {
      status: 400,
      code: 'validation_failed',
      errors,
    });
  }

  const secrets = options.secrets ?? databaseSecretWriter(db, { protect: options.protect });
  const writable = options.writable ?? dpapiAvailable();

  let persisted: SectionPayload;
  try {
    // Persist only the submitted fields (servermanage/settings/sections.py:71-110
    // save_section): validation uses the merged value, storage does not merge
    // defaults/stored values — except user_monitoring (merged over raw stored)
    // and report (merged over raw stored so a partial save such as
    // `{executive: {enabled: X}}` keeps the saved subject_prefix/to_addrs).
    // Keep validated/coerced values, but only for keys the payload submitted.
    let toStore: Record<string, unknown> = projectSubmitted(value, payload);
    if (section === 'user_monitoring') {
      const stored = loadAppSettings(db)[section];
      if (isPlainObject(stored)) toStore = { ...stored, ...payload };
    } else if (section === 'report') {
      const stored = loadAppSettings(db)[section];
      if (isPlainObject(stored)) toStore = mergeSections(stored, toStore);
    }
    persisted = sanitizeSection(section, toStore, { secrets, writable });
  } catch (err) {
    if (err instanceof SectionsError) {
      throw new SettingsServiceError(err.message, { status: err.status, code: 'validation_failed' });
    }
    throw err;
  }

  if (section === 'report') {
    const smtp = loadEffectiveSettings(db).smtp;
    try {
      assertReportSmtpReady(current, value, isSmtpReady(smtp, secrets));
    } catch (err) {
      if (err instanceof SectionsError) {
        throw new SettingsServiceError(err.message, { status: err.status, code: 'validation_failed' });
      }
      throw err;
    }
  }

  saveAppSettings(db, section, persisted);
  return { restartRequired: SETTINGS_SCHEMA[section].restartRequired };
}

/** Remove a section's stored overrides (defaults apply again). */
export function deleteSection(db: SqliteDatabase, section: string): void {
  if (!isKnownSection(section)) {
    throw new SettingsServiceError(`unknown settings section: ${section}`, {
      status: 404,
      code: 'unknown_section',
    });
  }
  deleteAppSettings(db, section);
}

/** Whether first-run admin setup still has to happen (mirrors `setup_required`). */
function setupRequired(db: SqliteDatabase, writable: boolean): boolean {
  if (!writable) {
    return false;
  }
  const security = loadAppSettings(db).security;
  if (isPlainObject(security) && security.force_setup === true) {
    return true;
  }
  return getSecret(db, SECRET_ADMIN) === null;
}

/**
 * Restrict the validated `value` to the key shape of the submitted `payload`
 * (recursing into nested objects). Keys absent from `value` (e.g. secrets the
 * validator drops) fall back to the raw submitted value so sanitize still sees them.
 */
function projectSubmitted(
  value: Record<string, unknown>,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(payload)) {
    if (!(key in value)) {
      out[key] = raw;
      continue;
    }
    const coerced = value[key];
    out[key] = isPlainObject(raw) && isPlainObject(coerced) ? projectSubmitted(coerced, raw) : coerced;
  }
  return out;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

/**
 * The masked `GET /api/settings` payload.
 *
 * Shape mirrors `sections.py::public_settings` (key names, nesting and the
 * `*_configured` secret redaction); `hosts` is a placeholder that Task 4 owns.
 */
export function publicSettings(db: SqliteDatabase): PublicSettings {
  const settings = loadEffectiveSettings(db);
  const writable = dpapiAvailable();

  const monitoring = settings.monitoring;
  const userMonitoring = settings.user_monitoring;
  const dashboard = settings.dashboard;
  const ssh = settings.ssh;
  const smtp = settings.smtp;
  const alerts = settings.alerts;
  const report = settings.report;
  const diskHealth = settings.disk_health;

  const auth = objectOrEmpty(dashboard.auth);
  const webhook = objectOrEmpty(alerts.webhook);
  const thresholds = objectOrEmpty(alerts.thresholds);
  const weekly = objectOrEmpty(report.weekly);
  const executive = objectOrEmpty(report.executive);
  const rules = objectOrEmpty(diskHealth.rules);

  const smtpConfigured = typeof smtp.host === 'string' && smtp.host.trim() !== '';
  const smtpPasswordConfigured = getSecret(db, SECRET_SMTP_PASSWORD) !== null;
  const webhookUrlConfigured = getSecret(db, SECRET_WEBHOOK_URL) !== null;

  return {
    writable,
    version: APP_VERSION,
    desktop_mode: process.env.SERVERMONITOR_DESKTOP === '1',
    setup_required: setupRequired(db, writable),
    monitoring: {
      timezone: monitoring.timezone,
      poll_interval_seconds: monitoring.poll_interval_seconds,
      disk_poll_interval_seconds: monitoring.disk_poll_interval_seconds,
      concurrency: monitoring.concurrency,
      retention_days: monitoring.retention_days,
      host_metrics_max_points: monitoring.host_metrics_max_points,
      disk_health_retention_days: monitoring.disk_health_retention_days,
      disk_health_max_batches: monitoring.disk_health_max_batches,
      host_daily_summary_retention_days: monitoring.host_daily_summary_retention_days,
      alert_history_retention_days: monitoring.alert_history_retention_days,
      ssh_audit_retention_days: monitoring.ssh_audit_retention_days,
      auto_port_fallback: monitoring.auto_port_fallback,
      tray_enabled: monitoring.tray_enabled,
      open_browser_on_start: monitoring.open_browser_on_start,
      mode: monitoring.mode,
      member_account: monitoring.member_account,
    },
    user_monitoring: {
      enabled: userMonitoring.enabled,
      scan_interval_seconds: userMonitoring.scan_interval_seconds,
      usage_interval_seconds: userMonitoring.usage_interval_seconds,
      usage_timeout_seconds: userMonitoring.usage_timeout_seconds,
      command_timeout: userMonitoring.command_timeout,
      write_enabled: userMonitoring.write_enabled,
    },
    dashboard: {
      host: dashboard.host,
      port: dashboard.port,
      username: auth.username,
      session_lifetime_hours: dashboard.session_lifetime_hours,
    },
    ssh: {
      connect_timeout: ssh.connect_timeout,
      command_timeout: ssh.command_timeout,
      host_key_policy: ssh.host_key_policy,
    },
    smtp: {
      host: smtp.host,
      port: smtp.port,
      username: smtp.username,
      use_ssl: smtp.use_ssl,
      from_addr: smtp.from_addr,
      to_addrs: Array.isArray(smtp.to_addrs) ? [...smtp.to_addrs] : [],
      password_configured: smtpPasswordConfigured,
    },
    alerts: {
      enabled: alerts.enabled,
      desktop_notification: alerts.desktop_notification,
      email: Boolean(smtpConfigured && alerts.email),
      webhook: {
        enabled: webhook.enabled,
        type: webhook.type,
        url_configured: webhookUrlConfigured,
      },
      thresholds: {
        cpu_percent: thresholds.cpu_percent,
        memory_percent: thresholds.memory_percent,
        disk_percent: thresholds.disk_percent,
        gpu_memory_percent: thresholds.gpu_memory_percent,
        disk_temperature_c: thresholds.disk_temperature_c,
      },
      cooldown_minutes: alerts.cooldown_minutes,
      repeat_while_active: alerts.repeat_while_active,
      offline_failures: alerts.offline_failures,
      aggregate_by_host: alerts.aggregate_by_host,
      notify_on_recovery: alerts.notify_on_recovery,
      consecutive_periods: alerts.consecutive_periods,
    },
    report: {
      daily_enabled: report.daily_enabled,
      daily_time: report.daily_time,
      weekly: {
        enabled: weekly.enabled,
        subject_prefix: weekly.subject_prefix,
        busy_threshold: weekly.busy_threshold,
        idle_threshold: weekly.idle_threshold,
        time: weekly.time,
        weekday: weekly.weekday,
      },
      executive: {
        enabled: executive.enabled,
        subject_prefix: executive.subject_prefix,
        to_addrs: Array.isArray(executive.to_addrs) ? [...executive.to_addrs] : [],
      },
    },
    disk_health: {
      enabled: diskHealth.enabled,
      use_sudo: diskHealth.use_sudo,
      storcli_candidates: Array.isArray(diskHealth.storcli_candidates)
        ? [...diskHealth.storcli_candidates]
        : [],
      rules: {
        alert_on_media_errors: rules.alert_on_media_errors,
        alert_on_other_errors: rules.alert_on_other_errors,
        alert_on_predictive_failure: rules.alert_on_predictive_failure,
        alert_on_smart_flag: rules.alert_on_smart_flag,
        alert_on_state_not_optimal: rules.alert_on_state_not_optimal,
        alert_on_error_increase: rules.alert_on_error_increase,
      },
    },
    // Hosts live in their own storage (Task 4); the route layer fills this in.
    hosts: [],
  };
}
