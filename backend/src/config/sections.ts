/**
 * Section merge / assembly helpers shared by `publicSettings` and `saveSection`.
 *
 * Mirrors the Python oracle's section handling in
 * `servermanage/settings/sections.py`:
 *   - `_sanitize_smtp` / `_sanitize_alerts` / `_sanitize_dashboard`: credential
 *     fields are pulled out of the payload, handed to the secret store, and
 *     stripped from the persisted section.
 *   - `_store_secret`: refuses to write when the platform is not writable.
 *   - the report SMTP gate (`启用日报/周报前需要先配置 SMTP 邮件服务器`).
 *
 * Pure logic over an injected `better-sqlite3` handle plus an injectable
 * {@link SecretWriter}: no HTTP, no direct DPAPI calls (the default writer wraps
 * `protect`, but callers may pass an in-memory writer or a stub in tests).
 */
import { protect } from '../storage/dpapi';
import { getSecret, setSecret } from '../storage/secrets';

import { ConfigError } from './errors';
import { SETTINGS_SCHEMA } from './schema';
import { SECRET_SMTP_PASSWORD, SECRET_WEBHOOK_URL } from './secrets';

type SqliteDatabase = import('better-sqlite3').Database;

/** A section's raw payload (`{field: value}`). */
export type SectionPayload = Record<string, unknown>;

/** Destination for credentials stripped out of a section payload. */
export interface SecretWriter {
  has(name: string): boolean;
  write(name: string, value: string): void;
}

/** Thrown when a payload cannot be assembled (non-writable platform, bad value). */
export class SectionsError extends ConfigError {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SectionsError';
    this.status = status;
  }
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
 * Recursively merge `override` on top of `base` (plain objects merged key by
 * key, arrays/scalars replaced wholesale), returning a fresh object.
 */
export function mergeSections(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out = cloneValue(base);
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isPlainObject(value) && isPlainObject(current)
      ? mergeSections(current, value)
      : cloneValue(value);
  }
  return out;
}

/**
 * Build a {@link SecretWriter} backed by `app_secrets`: values are encrypted
 * through `options.protect` (DPAPI by default) before being stored.
 */
export function databaseSecretWriter(
  db: SqliteDatabase,
  options: { protect?: (plain: Buffer) => Buffer } = {},
): SecretWriter {
  const protector = options.protect ?? protect;
  return {
    has: (name) => getSecret(db, name) !== null,
    write: (name, value) => {
      setSecret(db, name, protector(Buffer.from(value, 'utf8')));
    },
  };
}

/** Set of a section spec's non-secret field names. */
function publicFieldNames(section: string, excludeAuth = false): Set<string> {
  const spec = SETTINGS_SCHEMA[section];
  const names = new Set<string>();
  for (const [name, field] of Object.entries(spec.fields)) {
    if (field.secret) continue;
    if (excludeAuth && name === 'auth') continue;
    names.add(name);
  }
  return names;
}

function pickFields(payload: Record<string, unknown>, allowed: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (allowed.has(key)) out[key] = cloneValue(value);
  }
  return out;
}

function requireWritable(writable: boolean): void {
  if (!writable) throw new SectionsError('settings are not writable on this platform');
}

function requireSecrets(secrets: SecretWriter | undefined): SecretWriter {
  if (!secrets) throw new SectionsError('secret storage is not configured');
  return secrets;
}

function normalizeToAddrs(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .split(/[;,]/)
      .map((part) => part.trim())
      .filter((part) => part !== '');
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === 'string' ? part.trim() : String(part)))
      .filter((part) => part !== '');
  }
  return value;
}

function sanitizeSmtp(
  payload: Record<string, unknown>,
  secrets: SecretWriter | undefined,
  writable: boolean,
): Record<string, unknown> {
  const out = pickFields(payload, publicFieldNames('smtp'));
  const password = payload['password'];
  if (typeof password === 'string' && password !== '') {
    requireWritable(writable);
    requireSecrets(secrets).write(SECRET_SMTP_PASSWORD, password);
  }
  if ('to_addrs' in payload) {
    out.to_addrs = normalizeToAddrs(payload.to_addrs);
  }
  return out;
}

function validateConsecutivePeriods(value: unknown): void {
  if (typeof value === 'boolean' || typeof value !== 'number' || !Number.isInteger(value)) {
    throw new SectionsError('alerts.consecutive_periods 必须是整数');
  }
  if (value < 1 || value > 10) {
    throw new SectionsError('alerts.consecutive_periods 必须在 1 到 10 之间');
  }
}

function sanitizeAlerts(
  payload: Record<string, unknown>,
  secrets: SecretWriter | undefined,
  writable: boolean,
): Record<string, unknown> {
  const out = cloneValue(payload);
  if ('consecutive_periods' in out) {
    validateConsecutivePeriods(out.consecutive_periods);
  }
  if (isPlainObject(out.webhook)) {
    const webhook = cloneValue(out.webhook);
    const url = webhook.url;
    delete webhook.url;
    delete webhook.url_env;
    if (typeof url === 'string' && url !== '') {
      requireWritable(writable);
      requireSecrets(secrets).write(SECRET_WEBHOOK_URL, url);
    }
    out.webhook = webhook;
  }
  return out;
}

function dashboardAuthFieldNames(): Set<string> {
  const names = new Set<string>();
  const authSpec = SETTINGS_SCHEMA.dashboard.fields.auth;
  const fields = authSpec && authSpec.fields ? authSpec.fields : {};
  for (const [name, field] of Object.entries(fields)) {
    if (!field.secret) names.add(name);
  }
  return names;
}

function sanitizeDashboard(payload: Record<string, unknown>): Record<string, unknown> {
  const out = pickFields(payload, publicFieldNames('dashboard', true));
  const auth = payload.auth;
  if (isPlainObject(auth)) {
    out.auth = pickFields(auth, dashboardAuthFieldNames());
  }
  return out;
}

/**
 * Strip credential fields out of a validated section payload, routing them to
 * the secret store. Sections without secrets are returned as a deep clone.
 */
export function sanitizeSection(
  section: string,
  payload: Record<string, unknown>,
  options: { secrets?: SecretWriter; writable?: boolean } = {},
): Record<string, unknown> {
  const writable = options.writable ?? true;
  switch (section) {
    case 'smtp':
      return sanitizeSmtp(payload, options.secrets, writable);
    case 'alerts':
      return sanitizeAlerts(payload, options.secrets, writable);
    case 'dashboard':
      return sanitizeDashboard(payload);
    default:
      return cloneValue(payload);
  }
}

/** Whether SMTP is usable for reports: a host, and a secret when auth is set. */
export function isSmtpReady(smtp: Record<string, unknown>, secrets: SecretWriter): boolean {
  const host = typeof smtp.host === 'string' ? smtp.host.trim() : '';
  if (host === '') return false;
  const username = typeof smtp.username === 'string' ? smtp.username.trim() : '';
  if (username === '') return true;
  return secrets.has(SECRET_SMTP_PASSWORD);
}

function reportFlagEnabled(payload: Record<string, unknown>): boolean {
  return payload.daily_enabled === true;
}

function weeklyEnabled(payload: Record<string, unknown>): boolean {
  return isPlainObject(payload.weekly) && payload.weekly.enabled === true;
}

/**
 * Reject turning reports on for the first time until SMTP is configured,
 * matching `save_section`'s report gate (checked per-field, like the oracle).
 */
export function assertReportSmtpReady(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
  smtpReady: boolean,
): void {
  const newlyEnabled =
    (reportFlagEnabled(next) && !reportFlagEnabled(current)) ||
    (weeklyEnabled(next) && !weeklyEnabled(current));
  if (newlyEnabled && !smtpReady) {
    throw new SectionsError('启用日报/周报前需要先配置 SMTP 邮件服务器');
  }
}
