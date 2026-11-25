/**
 * Host settings: CRUD, import previews, `~/.ssh/config` parsing and batch
 * connectivity tests.
 *
 * Behaviour mirrors the Python oracle:
 *   - `servermanage/settings/hosts.py::HostsMixin` (host inventory stored in the
 *     `app_settings` section `hosts` as `{"hosts": [entry, ...]}`, secrets kept
 *     write-only in `app_secrets`)
 *   - `servermanage/host_import.py` (pure SSH-config / CSV / YAML import parsers)
 *   - `servermanage/availability.py::validate_check_target` (synthetic check
 *     target validation)
 *
 * Pure logic over an injected `better-sqlite3` handle and an injected secret
 * store / connectivity runner: no HTTP server, no real SSH connection. The
 * storage location matches the oracle (section `hosts`), so the route layer in
 * Task 11 can consume this module directly.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';

import type {
  AuthConfig,
  HostAlertRules,
  HostCheckConfig,
  HostConfig,
  HostDiskHealthOverride,
} from './config';
import { ConfigError } from './errors';
import { coercePort } from './schema';
import { loadAppSettings, saveAppSettings } from '../storage/settings';
import { deleteSecret, getSecret, setSecret } from '../storage/secrets';
import { dpapiAvailable, protect, unprotect } from '../storage/dpapi';

type SqliteDatabase = import('better-sqlite3').Database;

/** Error surface for host settings operations (extends {@link ConfigError}). */
export interface HostSettingsErrorOptions {
  /** Machine-readable reason (`invalid_payload`, `unsupported_format`, ...). */
  code?: string;
  /** HTTP status the route layer should map this error to. */
  status?: number;
}

/** Thrown for any invalid host payload / import configuration. */
export class HostSettingsError extends ConfigError {
  readonly code: string;
  readonly status: number;

  constructor(message: string, options: HostSettingsErrorOptions = {}) {
    super(message);
    this.name = 'HostSettingsError';
    this.code = options.code ?? 'invalid';
    this.status = options.status ?? 400;
  }
}

/** One synthetic check as exposed in a host view. */
export interface HostCheckView {
  name: string;
  type: string;
  target: string;
  timeout_seconds: number;
  expected: string | null;
  enabled: boolean;
}

/** The masked host entry returned by {@link listHosts}. */
export interface HostEntryView {
  name: string;
  host: string;
  port: number;
  username: string;
  tags: string[];
  disk_mounts: string[];
  auth_type: string;
  key_path: string | null;
  disk_health: Record<string, unknown> | null;
  group: string;
  owner: string;
  location: string;
  notes: string;
  user_monitoring: boolean | null;
  allow_user_write: boolean;
  checks: HostCheckView[];
  alert_rules: Record<string, unknown> | null;
}

/** A masked host entry plus the write-only secret booleans (oracle parity). */
export interface PublicHostEntry extends HostEntryView {
  password_configured: boolean;
  key_configured: boolean;
  passphrase_configured: boolean;
  sudo_configured: boolean;
}

/** Abstract secret store so tests never touch the real DPAPI. */
export interface HostSecretStore {
  has(name: string): boolean;
  read(name: string): string | null;
  write(name: string, value: string): void;
  delete(name: string): void;
}

/** Shared options for every host settings operation. */
export interface HostsOptions {
  /** Injected secret backend; defaults to the real `app_secrets` store. */
  secrets?: HostSecretStore;
  /** Whether settings are writable; defaults to the platform capability. */
  writable?: boolean;
  /** Base `HostConfig[]` used when the DB has no `hosts` section yet. */
  baseServers?: HostConfig[];
}

export interface UpsertHostOptions extends HostsOptions {
  /** The URL name; when present it must match `payload.name`. */
  name?: string;
  /** Skip credential requirements for key auth without key material. */
  allowMissingCredentials?: boolean;
}

export interface ImportHostsOptions extends HostsOptions {
  overwrite?: boolean;
  allowMissingCredentials?: boolean;
}

/** Outcome of {@link importHosts}. */
export interface ImportResult {
  created: string[];
  updated: string[];
  skipped: string[];
  failed: { name: string; error: string }[];
}

/** A parsed import candidate (mirrors `host_import.HostCandidate`). */
export interface HostCandidate {
  name: string;
  host: string;
  port: number;
  port_explicit: boolean;
  username: string;
  auth_type: string;
  key_path: string | null;
  tags: string[];
  disk_mounts: string[];
  group: string;
  owner: string;
  location: string;
  notes: string;
  warnings: string[];
  valid: boolean;
  error: string | null;
}

/** A single parse error (`row` is 1-based or null for whole-document errors). */
export interface ParseError {
  row: number | null;
  error: string;
}

/** Result of a pure import parser (mirrors `host_import.ParseResult`). */
export interface ParseResult {
  candidates: HostCandidate[];
  errors: ParseError[];
  warnings: string[];
}

/** Result shape returned by {@link previewHostImport} / {@link previewSshConfigImport}. */
export interface ImportPreview {
  candidates: HostCandidate[];
  errors: ParseError[];
  warnings: string[];
}

/** A `~/.ssh/config` preview, including the resolved path and whether it exists. */
export interface SshConfigPreview extends ImportPreview {
  path: string;
  exists: boolean;
  default_username: string;
}

/** Result of one host connectivity check. */
export interface HostRunnerResult {
  exitStatus: number;
  stdout?: string;
  stderr?: string;
}

/** Injected connectivity runner (never a real SSH connection in tests). */
export type HostRunner = (server: HostConfig) => HostRunnerResult | Promise<HostRunnerResult>;

export interface HostBatchResultRow {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HostBatchResult {
  results: HostBatchResultRow[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOST_SECRET_PASSWORD = 'host:{name}:ssh_password';
const HOST_SECRET_KEY = 'host:{name}:ssh_key';
const HOST_SECRET_PASSPHRASE = 'host:{name}:ssh_passphrase';
const HOST_SECRET_SUDO_PASSWORD = 'host:{name}:sudo_password';

const HOST_AUTH_TYPES = ['password', 'key'];
const DEFAULT_DISK_MOUNTS = ['/', '/data'];
const DEFAULT_GROUP = '未分组';
const MAX_HOST_CHECKS = 20;
const PROXY_ERROR = '需要代理跳转，工具暂不支持';

const ALERT_RULE_RANGES: [string, number, number][] = [
  ['cpu_percent', 1, 100],
  ['memory_percent', 1, 100],
  ['disk_percent', 1, 100],
  ['gpu_memory_percent', 1, 100],
  ['disk_temperature_c', 1, 120],
];

const HTTP_FORBIDDEN_TOKENS = ['`', '$(', ';', '|', '&'];
const TCP_HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
const PROCESS_RE = /^[A-Za-z0-9._+\-]{1,64}$/;
const SERVICE_RE = /^[A-Za-z0-9@._:\-]{1,128}$/;
const BRACKET_V6_RE = /^\[([0-9A-Fa-f:.]+)\]:([0-9]{1,5})$/;
const EXPECTED_STATUS_RE = /^\d{3}(-\d{3})?$/;

const HEADER_ALIASES: Record<string, string> = {
  name: 'name',
  名称: 'name',
  主机名: 'name',
  host: 'host',
  地址: 'host',
  主机: 'host',
  主机地址: 'host',
  port: 'port',
  端口: 'port',
  username: 'username',
  user: 'username',
  用户名: 'username',
  auth_type: 'auth_type',
  auth: 'auth_type',
  认证: 'auth_type',
  认证方式: 'auth_type',
  key_path: 'key_path',
  私钥: 'key_path',
  密钥: 'key_path',
  tags: 'tags',
  标签: 'tags',
  disk_mounts: 'disk_mounts',
  磁盘目录: 'disk_mounts',
  挂载点: 'disk_mounts',
  group: 'group',
  分组: 'group',
  owner: 'owner',
  负责人: 'owner',
  location: 'location',
  位置: 'location',
  notes: 'notes',
  备注: 'notes',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type StoredHostEntry = Record<string, unknown>;

interface HostContext {
  secrets: HostSecretStore;
  writable: boolean;
  baseServers: HostConfig[];
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function asPort(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || !numeric) return 22;
  return Math.trunc(numeric);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function secretName(template: string, name: string): string {
  return template.replace('{name}', name);
}

function defaultSecretStore(db: SqliteDatabase): HostSecretStore {
  return {
    has: (name) => getSecret(db, name) !== null,
    read: (name) => {
      const blob = getSecret(db, name);
      return blob === null ? null : unprotect(blob).toString('utf8');
    },
    write: (name, value) => setSecret(db, name, protect(Buffer.from(value, 'utf8'))),
    delete: (name) => deleteSecret(db, name),
  };
}

function makeContext(db: SqliteDatabase, options: HostsOptions): HostContext {
  return {
    secrets: options.secrets ?? defaultSecretStore(db),
    writable: options.writable ?? dpapiAvailable(),
    baseServers: options.baseServers ?? [],
  };
}

function requireWritable(context: HostContext): void {
  if (!context.writable) {
    throw new HostSettingsError('settings are not writable on this platform', { code: 'not_writable' });
  }
}

// ---------------------------------------------------------------------------
// Python schema.py helpers re-implemented
// ---------------------------------------------------------------------------

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HostSettingsError(`${field} 不能为空`);
  }
  return value.trim();
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text ? text : null;
}

function triStateBool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (['', 'inherit', 'none', 'null', 'default'].includes(lower)) return null;
    if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
    if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  }
  throw new HostSettingsError(`user_monitoring 必须是 true/false 或留空: '${String(value)}'`);
}

function triStateBoolLenient(value: unknown): boolean | null {
  try {
    return triStateBool(value);
  } catch {
    return null;
  }
}

function requireBool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new HostSettingsError(`${label}必须是 true 或 false`);
  }
  return value;
}

function stringList(value: unknown, fallback: string[] = []): string[] {
  if (value === null || value === undefined) return [...fallback];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [...fallback];
}

function sanitizeHostDiskHealth(value: unknown): StoredHostEntry | null {
  if (!isMapping(value)) return null;
  const result: StoredHostEntry = {};
  if (value['enabled'] !== null && value['enabled'] !== undefined) result.enabled = Boolean(value['enabled']);
  if (value['use_sudo'] !== null && value['use_sudo'] !== undefined) result.use_sudo = Boolean(value['use_sudo']);
  if (value['storcli_path']) result.storcli_path = String(value['storcli_path']);
  return Object.keys(result).length > 0 ? result : null;
}

function validateAlertRules(value: unknown): StoredHostEntry | null {
  if (value === null || value === undefined) return null;
  if (!isMapping(value)) throw new HostSettingsError('alert_rules 必须是对象');
  const result: StoredHostEntry = {};
  for (const [key, min, max] of ALERT_RULE_RANGES) {
    const raw = value[key];
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'boolean') throw new HostSettingsError(`alert_rules.${key} 必须是数字`);
    const numeric = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(numeric)) throw new HostSettingsError(`alert_rules.${key} 必须是数字`);
    if (!(numeric >= min && numeric <= max)) {
      throw new HostSettingsError(`alert_rules.${key} 必须在 ${min} 到 ${max} 之间`);
    }
    result[key] = numeric;
  }
  const consecutive = value['consecutive_periods'];
  if (consecutive !== null && consecutive !== undefined) {
    if (typeof consecutive === 'boolean' || !Number.isInteger(consecutive)) {
      throw new HostSettingsError('alert_rules.consecutive_periods 必须是整数');
    }
    const consecutiveValue = consecutive as number;
    if (!(consecutiveValue >= 1 && consecutiveValue <= 10)) {
      throw new HostSettingsError('alert_rules.consecutive_periods 必须在 1 到 10 之间');
    }
    result.consecutive_periods = consecutiveValue;
  }
  return result;
}

// --- validate_check_target (servermanage/availability.py) --------------------

function hasControlOrSpace(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (ch.trim() === '' || code < 32 || code === 127) return true;
  }
  return false;
}

function parseTcpPortText(text: string): number {
  if (!/^[0-9]+$/.test(text)) throw new Error(`TCP 端口非法: '${text}'`);
  const port = Number(text);
  if (!(port >= 1 && port <= 65535)) throw new Error('TCP 端口必须在 1..65535 之间');
  return port;
}

function validateTcpHost(host: string): void {
  if (host === '') throw new Error('TCP 主机为空');
  if (net.isIP(host) !== 0) return;
  if (!TCP_HOST_RE.test(host) || !/[A-Za-z0-9]/.test(host)) {
    throw new Error(`TCP 主机名非法: '${host}'`);
  }
}

function validateTcpTarget(target: string): void {
  if (!target) throw new Error('TCP 目标为空');
  if (target.length > 256) throw new Error('TCP 目标过长');
  if (hasControlOrSpace(target)) throw new Error('TCP 目标包含空白或控制字符');
  if (target.startsWith('[')) {
    const match = BRACKET_V6_RE.exec(target);
    if (!match) throw new Error(`TCP IPv6 目标非法: '${target}'`);
    if (net.isIP(match[1]) !== 6) throw new Error(`TCP IPv6 主机非法: '${match[1]}'`);
    parseTcpPortText(match[2]);
    return;
  }
  const colon = target.lastIndexOf(':');
  const host = colon >= 0 ? target.slice(0, colon) : '127.0.0.1';
  const portText = colon >= 0 ? target.slice(colon + 1) : target;
  validateTcpHost(host);
  parseTcpPortText(portText);
}

function validateHttpTarget(target: string): void {
  if (!target) throw new Error('HTTP 目标为空');
  if (target.length > 256) throw new Error('HTTP 目标过长');
  if (hasControlOrSpace(target)) throw new Error('HTTP 目标包含空白或控制字符');
  for (const token of HTTP_FORBIDDEN_TOKENS) {
    if (target.includes(token)) throw new Error(`HTTP 目标包含非法字符: '${token}'`);
  }
  if (target.includes('?') || target.includes('#')) throw new Error('HTTP 目标不允许查询串或片段');
  let url: URL;
  try {
    url = new URL(target);
  } catch (err) {
    throw new Error(`HTTP 目标无法解析: ${(err as Error).message}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('HTTP 目标只允许 http/https');
  if (!url.hostname) throw new Error('HTTP 目标缺少主机');
  if (url.username || url.password) throw new Error('HTTP 目标不允许携带 userinfo/凭据');
  if (url.search || url.hash) throw new Error('HTTP 目标不允许查询串或片段');
}

function validateProcessTarget(target: string): void {
  if (typeof target !== 'string' || target.length > 256) throw new Error('进程目标非法');
  if (!PROCESS_RE.test(target)) throw new Error(`进程名非法: '${target}'`);
}

function validateServiceTarget(target: string): void {
  if (typeof target !== 'string' || target.length > 256) throw new Error('服务目标非法');
  if (!SERVICE_RE.test(target)) throw new Error(`systemd unit 非法: '${target}'`);
}

function validateCheckTarget(checkType: string, target: string): void {
  switch (checkType) {
    case 'tcp':
      validateTcpTarget(target);
      return;
    case 'http':
      validateHttpTarget(target);
      return;
    case 'process':
      validateProcessTarget(target);
      return;
    case 'service':
      validateServiceTarget(target);
      return;
    default:
      throw new Error(`不支持的检查类型: '${checkType}'`);
  }
}

function sanitizeHostChecks(value: unknown): StoredHostEntry[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new HostSettingsError('checks 必须是列表');
  if (value.length > MAX_HOST_CHECKS) throw new HostSettingsError(`checks 最多支持 ${MAX_HOST_CHECKS} 项`);
  const result: StoredHostEntry[] = [];
  const seenNames = new Set<string>();
  value.forEach((item, index) => {
    if (!isMapping(item)) throw new HostSettingsError(`checks[${index}] 必须是对象`);
    const name = String(item['name'] ?? '').trim();
    if (!name) throw new HostSettingsError(`checks[${index}].name 不能为空`);
    if (name.length > 64) throw new HostSettingsError(`checks[${index}].name 最多 64 个字符`);
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) throw new HostSettingsError(`check 名称重复: ${name}`);
    seenNames.add(nameKey);

    const type = String(item['type'] ?? '').trim().toLowerCase();
    if (!['tcp', 'http', 'process', 'service'].includes(type)) {
      throw new HostSettingsError(`checks[${index}].type 必须是 tcp/http/process/service 之一`);
    }
    const target = String(item['target'] ?? '').trim();
    if (!target) throw new HostSettingsError(`checks[${index}].target 不能为空`);
    if (target.length > 256) throw new HostSettingsError(`checks[${index}].target 最多 256 个字符`);
    try {
      validateCheckTarget(type, target);
    } catch (err) {
      throw new HostSettingsError(`checks[${index}].target 非法: ${(err as Error).message}`);
    }

    const timeoutRaw = item['timeout_seconds'] === undefined ? 5 : item['timeout_seconds'];
    if (typeof timeoutRaw === 'boolean' || !Number.isInteger(timeoutRaw)) {
      throw new HostSettingsError(`checks[${index}].timeout_seconds 必须是整数`);
    }
    const timeout = timeoutRaw as number;
    if (!(timeout >= 1 && timeout <= 30)) {
      throw new HostSettingsError(`checks[${index}].timeout_seconds 必须在 1 到 30 之间`);
    }

    let expected: string | null = null;
    if (item['expected'] !== null && item['expected'] !== undefined) {
      const text = String(item['expected']).trim();
      if (text) {
        if (!EXPECTED_STATUS_RE.test(text)) {
          throw new HostSettingsError(`checks[${index}].expected 必须是 200 或 200-299 这样的状态码`);
        }
        expected = text;
      }
    }

    const enabled = item['enabled'] === undefined ? true : Boolean(item['enabled']);
    result.push({ name, type, target, timeout_seconds: timeout, expected, enabled });
  });
  return result;
}

function buildHostCheck(value: StoredHostEntry): HostCheckConfig {
  const timeout = Number.isInteger(value['timeout_seconds']) ? (value['timeout_seconds'] as number) : 5;
  const check: HostCheckConfig = {
    name: asString(value['name']),
    type: asString(value['type']),
    target: asString(value['target']),
    timeout_seconds: timeout,
    enabled: value['enabled'] === undefined ? true : Boolean(value['enabled']),
  };
  if (value['expected'] !== null && value['expected'] !== undefined) {
    const expected = String(value['expected']);
    if (expected) check.expected = expected;
  }
  return check;
}

function buildHostDiskHealth(value: unknown): HostDiskHealthOverride | undefined {
  if (!isMapping(value)) return undefined;
  const result: HostDiskHealthOverride = {};
  let touched = false;
  if (value['enabled'] !== null && value['enabled'] !== undefined) {
    result.enabled = Boolean(value['enabled']);
    touched = true;
  }
  if (value['use_sudo'] !== null && value['use_sudo'] !== undefined) {
    result.use_sudo = Boolean(value['use_sudo']);
    touched = true;
  }
  if (value['storcli_path']) {
    result.storcli_path = String(value['storcli_path']);
    touched = true;
  }
  return touched ? result : undefined;
}

function buildHostAlertRules(value: unknown): HostAlertRules | undefined {
  if (!isMapping(value)) return undefined;
  const result: HostAlertRules = {};
  let touched = false;
  for (const [key] of ALERT_RULE_RANGES) {
    const raw = value[key];
    if (raw === null || raw === undefined) continue;
    const numeric = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(numeric)) {
      (result as Record<string, number>)[key] = numeric;
      touched = true;
    }
  }
  const consecutive = value['consecutive_periods'];
  if (consecutive !== null && consecutive !== undefined) {
    const numeric = typeof consecutive === 'number' ? consecutive : Number(consecutive);
    if (Number.isInteger(numeric)) {
      result.consecutive_periods = numeric;
      touched = true;
    }
  }
  return touched ? result : undefined;
}

// ---------------------------------------------------------------------------
// Entry storage (section `hosts`)
// ---------------------------------------------------------------------------

function readHostEntries(db: SqliteDatabase): StoredHostEntry[] | null {
  const sections = loadAppSettings(db);
  const payload = sections['hosts'];
  if (!isMapping(payload)) return null;
  const entries = payload['hosts'];
  if (!Array.isArray(entries)) return null;
  return entries.filter(isMapping).map((entry) => entry as StoredHostEntry);
}

function entryFromConfig(host: HostConfig): StoredHostEntry {
  const checks = host.checks.map((check) => ({
    name: check.name,
    type: check.type,
    target: check.target,
    timeout_seconds: check.timeout_seconds,
    expected: check.expected ?? null,
    enabled: Boolean(check.enabled),
  }));
  return {
    name: host.name,
    host: host.host,
    port: host.port,
    username: host.username,
    tags: [...host.tags],
    disk_mounts: [...host.disk_mounts],
    auth_type: host.auth.type,
    key_path: host.auth.key_path ?? null,
    disk_health: host.disk_health ? { ...host.disk_health } : null,
    group: host.group,
    owner: host.owner,
    location: host.location,
    notes: host.notes,
    user_monitoring: host.user_monitoring ?? null,
    allow_user_write: Boolean(host.allow_user_write),
    checks,
    alert_rules: host.alert_rules ? { ...host.alert_rules } : null,
  };
}

function entriesForUpdate(db: SqliteDatabase, options: HostsOptions): StoredHostEntry[] {
  const stored = readHostEntries(db);
  if (stored !== null) return clone(stored);
  return (options.baseServers ?? []).map(entryFromConfig);
}

function saveHostEntries(db: SqliteDatabase, entries: StoredHostEntry[]): void {
  saveAppSettings(db, 'hosts', { hosts: entries });
}

// ---------------------------------------------------------------------------
// Host view
// ---------------------------------------------------------------------------

function publicHostEntry(entry: StoredHostEntry, context: HostContext, baseHost?: HostConfig): PublicHostEntry {
  const name = asString(entry['name']);
  const keyPathRaw = entry['key_path'];
  const keyPath = keyPathRaw === null || keyPathRaw === undefined || keyPathRaw === '' ? null : String(keyPathRaw);
  const checks: HostCheckView[] = Array.isArray(entry['checks'])
    ? entry['checks'].filter(isMapping).map((check) => ({
        name: asString(check['name']),
        type: asString(check['type']),
        target: asString(check['target']),
        timeout_seconds: typeof check['timeout_seconds'] === 'number' ? (check['timeout_seconds'] as number) : 5,
        expected:
          check['expected'] === null || check['expected'] === undefined ? null : String(check['expected']),
        enabled: Boolean(check['enabled']),
      }))
    : [];
  return {
    name,
    host: asString(entry['host']),
    port: asPort(entry['port']),
    username: asString(entry['username']),
    tags: Array.isArray(entry['tags']) ? entry['tags'].map((tag) => String(tag)) : [],
    disk_mounts: Array.isArray(entry['disk_mounts']) ? entry['disk_mounts'].map((mount) => String(mount)) : [],
    auth_type: asString(entry['auth_type']),
    key_path: keyPath,
    disk_health: isMapping(entry['disk_health']) ? clone(entry['disk_health']) : null,
    group: asString(entry['group']).trim() || DEFAULT_GROUP,
    owner: asString(entry['owner']).trim(),
    location: asString(entry['location']).trim(),
    notes: asString(entry['notes']).trim(),
    user_monitoring: triStateBoolLenient(entry['user_monitoring']),
    allow_user_write: Boolean(entry['allow_user_write']),
    checks,
    alert_rules: isMapping(entry['alert_rules']) ? clone(entry['alert_rules']) : null,
    password_configured: context.secrets.has(secretName(HOST_SECRET_PASSWORD, name)),
    key_configured: context.secrets.has(secretName(HOST_SECRET_KEY, name)) || Boolean(keyPath),
    passphrase_configured: context.secrets.has(secretName(HOST_SECRET_PASSPHRASE, name)),
    sudo_configured:
      context.secrets.has(secretName(HOST_SECRET_SUDO_PASSWORD, name)) ||
      (!context.writable && Boolean(baseHost?.sudo_password)),
  };
}

// ---------------------------------------------------------------------------
// Secret application
// ---------------------------------------------------------------------------

interface ApplySecretsInput {
  password: string | null;
  private_key: string | null;
  passphrase: string | null;
  key_path: string | null;
  clear_secrets: string[];
}

function applyHostSecrets(context: HostContext, name: string, authType: string, input: ApplySecretsInput): void {
  const clear = new Set(input.clear_secrets);
  const passwordSecret = secretName(HOST_SECRET_PASSWORD, name);
  const keySecret = secretName(HOST_SECRET_KEY, name);
  const passphraseSecret = secretName(HOST_SECRET_PASSPHRASE, name);

  if (authType === 'password') {
    const existing = context.secrets.has(passwordSecret);
    const usable = Boolean(input.password) || (existing && !clear.has('password'));
    if (!usable) throw new HostSettingsError('SSH 密码未设置');
    if (clear.has('password')) context.secrets.delete(passwordSecret);
    if (input.password) context.secrets.write(passwordSecret, input.password);
    context.secrets.delete(keySecret);
    context.secrets.delete(passphraseSecret);
    return;
  }

  const existingKey = context.secrets.has(keySecret);
  const usable = Boolean(input.private_key) || input.key_path !== null || (existingKey && !clear.has('key'));
  if (!usable) throw new HostSettingsError('SSH 私钥未设置');
  if (clear.has('key')) context.secrets.delete(keySecret);
  if (input.private_key) context.secrets.write(keySecret, input.private_key);
  if (clear.has('passphrase')) context.secrets.delete(passphraseSecret);
  if (input.passphrase) context.secrets.write(passphraseSecret, input.passphrase);
  context.secrets.delete(passwordSecret);
}

function validatedSudoPassword(payload: Record<string, unknown>): string | null {
  const raw = payload['sudo_password'];
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  if (text === '') return null;
  if (text.includes('\n') || text.includes('\r')) throw new HostSettingsError('sudo 密码不能包含换行符');
  if (Buffer.byteLength(text, 'utf8') > 256) throw new HostSettingsError('sudo 密码最多 256 字节');
  return text;
}

function applyHostSudoPassword(
  context: HostContext,
  name: string,
  sudoPassword: string | null,
  clearSecrets: string[],
): void {
  const secret = secretName(HOST_SECRET_SUDO_PASSWORD, name);
  if (clearSecrets.includes('sudo_password')) context.secrets.delete(secret);
  if (sudoPassword === null) return;
  context.secrets.write(secret, sudoPassword);
}

// ---------------------------------------------------------------------------
// Public CRUD API
// ---------------------------------------------------------------------------

/** Masked host inventory (empty when nothing has been stored yet). */
export function listHosts(db: SqliteDatabase, options: HostsOptions = {}): PublicHostEntry[] {
  const context = makeContext(db, options);
  const baseByName = new Map<string, HostConfig>();
  for (const host of options.baseServers ?? []) baseByName.set(host.name, host);
  return entriesForUpdate(db, options).map((entry) =>
    publicHostEntry(entry, context, baseByName.get(asString(entry['name']))),
  );
}

/** One masked host by name, or `null` when it does not exist. */
export function getHost(db: SqliteDatabase, name: string, options: HostsOptions = {}): PublicHostEntry | null {
  return listHosts(db, options).find((host) => host.name === name) ?? null;
}

/** Create or replace a host (mirrors `HostsMixin.upsert_host`). */
export function upsertHost(
  db: SqliteDatabase,
  payload: unknown,
  options: UpsertHostOptions = {},
): PublicHostEntry[] {
  const context = makeContext(db, options);
  requireWritable(context);
  if (!isMapping(payload)) throw new HostSettingsError('host payload must be an object', { code: 'invalid_payload' });

  const name = requireText(payload['name'], 'name');
  if (options.name !== undefined) {
    const urlName = requireText(options.name, 'name');
    if (urlName !== name) {
      throw new HostSettingsError('host name in payload does not match the URL name', { code: 'invalid_payload' });
    }
  }
  const host = requireText(payload['host'], 'host');
  const username = requireText(payload['username'], 'username');
  const authType = requireText(payload['auth_type'], 'auth_type');
  if (!HOST_AUTH_TYPES.includes(authType)) throw new HostSettingsError(`unsupported auth_type: ${authType}`);

  const port = coercePort(payload['port'] === undefined ? 22 : payload['port']);
  const tags = stringList(payload['tags'], []);
  let diskMounts = stringList(payload['disk_mounts'], DEFAULT_DISK_MOUNTS);
  if (diskMounts.length === 0) diskMounts = [...DEFAULT_DISK_MOUNTS];
  const group = (optionalText(payload['group']) ?? '').trim() || DEFAULT_GROUP;
  const owner = (optionalText(payload['owner']) ?? '').trim();
  const location = (optionalText(payload['location']) ?? '').trim();
  const notes = (optionalText(payload['notes']) ?? '').trim();
  const clearSecrets = stringList(payload['clear_secrets'], []);
  const keyPathRaw = payload['key_path'];
  const keyPath =
    keyPathRaw === null || keyPathRaw === undefined || keyPathRaw === '' ? null : String(keyPathRaw).trim();

  const entries = entriesForUpdate(db, options);
  const index = entries.findIndex((entry) => asString(entry['name']) === name);
  const existing = index >= 0 ? entries[index] : null;

  const existingChecks = existing === null ? undefined : existing['checks'];
  const checks = hasOwn(payload, 'checks')
    ? sanitizeHostChecks(payload['checks'])
    : Array.isArray(existingChecks)
      ? (existingChecks as StoredHostEntry[]).map((check) => clone(check))
      : [];
  const existingAlertRules = existing === null ? undefined : existing['alert_rules'];
  const alertRules = hasOwn(payload, 'alert_rules')
    ? validateAlertRules(payload['alert_rules'])
    : isMapping(existingAlertRules)
      ? clone(existingAlertRules)
      : null;
  const userMonitoring = hasOwn(payload, 'user_monitoring')
    ? triStateBool(payload['user_monitoring'])
    : triStateBoolLenient(existing === null ? null : existing['user_monitoring']);
  const allowUserWrite = hasOwn(payload, 'allow_user_write')
    ? requireBool(payload['allow_user_write'], 'allow_user_write')
    : Boolean(existing === null ? false : existing['allow_user_write']);

  const sudoPassword = validatedSudoPassword(payload);

  const hasInlineSecret = Boolean(
    optionalText(payload['private_key']) ||
      optionalText(payload['password']) ||
      optionalText(payload['passphrase']),
  );
  const skipSecretApply =
    options.allowMissingCredentials === true && authType === 'key' && keyPath === null && !hasInlineSecret;
  if (!skipSecretApply) {
    applyHostSecrets(context, name, authType, {
      password: optionalText(payload['password']),
      private_key: optionalText(payload['private_key']),
      passphrase: optionalText(payload['passphrase']),
      key_path: keyPath,
      clear_secrets: clearSecrets,
    });
  }
  applyHostSudoPassword(context, name, sudoPassword, clearSecrets);

  const entry: StoredHostEntry = {
    name,
    host,
    port,
    username,
    tags,
    disk_mounts: diskMounts,
    auth_type: authType,
    key_path: keyPath,
    disk_health: sanitizeHostDiskHealth(payload['disk_health']),
    group,
    owner,
    location,
    notes,
    user_monitoring: userMonitoring,
    allow_user_write: allowUserWrite,
    checks,
    alert_rules: alertRules,
  };
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
  saveHostEntries(db, entries);
  return listHosts(db, options);
}

/** Delete a host and its secrets (mirrors `HostsMixin.delete_host`). */
export function deleteHost(db: SqliteDatabase, name: string, options: HostsOptions = {}): PublicHostEntry[] {
  const context = makeContext(db, options);
  requireWritable(context);
  const target = requireText(name, 'name');
  for (const template of [HOST_SECRET_PASSWORD, HOST_SECRET_KEY, HOST_SECRET_PASSPHRASE, HOST_SECRET_SUDO_PASSWORD]) {
    context.secrets.delete(secretName(template, target));
  }
  const entries = entriesForUpdate(db, options).filter((entry) => asString(entry['name']) !== target);
  saveHostEntries(db, entries);
  return listHosts(db, options);
}

/** Copy a host and its secrets under a new name (mirrors `HostsMixin.copy_host`). */
export function copyHost(
  db: SqliteDatabase,
  source: string,
  newName: string,
  options: HostsOptions = {},
): PublicHostEntry[] {
  const context = makeContext(db, options);
  requireWritable(context);
  const sourceName = requireText(source, 'name');
  const targetName = requireText(newName, 'name');
  const entries = entriesForUpdate(db, options);
  const index = entries.findIndex((entry) => asString(entry['name']) === sourceName);
  if (index < 0) throw new HostSettingsError(`源主机不存在: ${sourceName}`);
  if (entries.some((entry) => asString(entry['name']) === targetName)) {
    throw new HostSettingsError(`目标主机已存在: ${targetName}`);
  }
  for (const template of [HOST_SECRET_PASSWORD, HOST_SECRET_KEY, HOST_SECRET_PASSPHRASE, HOST_SECRET_SUDO_PASSWORD]) {
    const from = secretName(template, sourceName);
    if (context.secrets.has(from)) {
      const value = context.secrets.read(from);
      if (value !== null) context.secrets.write(secretName(template, targetName), value);
    }
  }
  const copied = clone(entries[index]);
  copied['name'] = targetName;
  copied['group'] = asString(copied['group']).trim() || DEFAULT_GROUP;
  entries.push(copied);
  saveHostEntries(db, entries);
  return listHosts(db, options);
}

/** Distinct host groups, always including the default bucket (sorted). */
export function hostGroups(db: SqliteDatabase, options: HostsOptions = {}): string[] {
  const groups = new Set<string>([DEFAULT_GROUP]);
  for (const entry of entriesForUpdate(db, options)) {
    groups.add(asString(entry['group']).trim() || DEFAULT_GROUP);
  }
  return [...groups].sort();
}

// ---------------------------------------------------------------------------
// Import: candidate validation + upsert loop
// ---------------------------------------------------------------------------

interface ValidatedCandidatePayload extends Record<string, unknown> {
  name: string;
  host: string;
  username: string;
  auth_type: string;
  port: number;
}

function validateImportCandidate(
  raw: Record<string, unknown>,
  context: HostContext,
  allowMissingCredentials: boolean,
): ValidatedCandidatePayload {
  if (raw['valid'] === false) throw new HostSettingsError(String(raw['error'] ?? '候选主机无效'));
  const payload: Record<string, unknown> = { ...raw };
  const name = requireText(raw['name'], 'name');
  payload['name'] = name;
  payload['host'] = requireText(raw['host'], 'host');
  payload['username'] = requireText(raw['username'], 'username');
  const authRaw = raw['auth_type'];
  const authType = authRaw === null || authRaw === undefined ? '' : String(authRaw).trim();
  if (!authType) throw new HostSettingsError('auth_type 不能为空');
  if (!HOST_AUTH_TYPES.includes(authType)) throw new HostSettingsError(`不支持的认证方式: ${authType}`);
  payload['auth_type'] = authType;
  payload['port'] = coercePort(raw['port'] === undefined ? 22 : raw['port']);

  if (allowMissingCredentials) return payload as ValidatedCandidatePayload;

  const clear = new Set(stringList(raw['clear_secrets'], []));
  if (authType === 'password') {
    const existing = context.secrets.has(secretName(HOST_SECRET_PASSWORD, name));
    const usable = Boolean(optionalText(raw['password'])) || (existing && !clear.has('password'));
    if (!usable) throw new HostSettingsError('SSH 密码未设置');
  } else {
    const keyPathRaw = raw['key_path'];
    const hasKeyPath = keyPathRaw !== null && keyPathRaw !== undefined && Boolean(String(keyPathRaw).trim());
    const existing = context.secrets.has(secretName(HOST_SECRET_KEY, name));
    const usable = Boolean(optionalText(raw['private_key'])) || hasKeyPath || (existing && !clear.has('key'));
    if (!usable) throw new HostSettingsError('SSH 私钥未设置');
  }
  return payload as ValidatedCandidatePayload;
}

/** Import parsed candidates (mirrors `HostsMixin.import_hosts`). */
export function importHosts(
  db: SqliteDatabase,
  candidates: unknown,
  options: ImportHostsOptions = {},
): ImportResult {
  const context = makeContext(db, options);
  requireWritable(context);
  const list = Array.isArray(candidates)
    ? candidates
    : isMapping(candidates) && Array.isArray(candidates['candidates'])
      ? (candidates['candidates'] as unknown[])
      : null;
  if (list === null) throw new HostSettingsError('candidates 必须是列表');

  const existing = new Set(entriesForUpdate(db, options).map((entry) => asString(entry['name']).trim()));
  const validated: ValidatedCandidatePayload[] = [];
  const skipped: string[] = [];
  const failed: { name: string; error: string }[] = [];
  const seen = new Set<string>();
  const overwrite = options.overwrite === true;
  const allowMissing = options.allowMissingCredentials === true;

  for (const raw of list) {
    if (!isMapping(raw)) {
      failed.push({ name: '', error: '主机条目必须是对象' });
      continue;
    }
    if (raw['valid'] === false) {
      failed.push({ name: asString(raw['name']).trim(), error: String(raw['error'] ?? '候选主机无效') });
      continue;
    }
    let name: string;
    try {
      name = requireText(raw['name'], 'name');
    } catch (err) {
      failed.push({ name: asString(raw['name']).trim(), error: (err as Error).message });
      continue;
    }
    if (existing.has(name) && !overwrite) {
      skipped.push(name);
      seen.add(name);
      continue;
    }
    if (seen.has(name)) {
      skipped.push(name);
      continue;
    }
    try {
      validated.push(validateImportCandidate(raw, context, allowMissing));
    } catch (err) {
      failed.push({ name, error: (err as Error).message });
      continue;
    }
    seen.add(name);
  }

  const created: string[] = [];
  const updated: string[] = [];
  for (const payload of validated) {
    const name = payload.name;
    try {
      upsertHost(db, payload, { ...options, name });
    } catch (err) {
      failed.push({ name, error: (err as Error).message });
      continue;
    }
    if (existing.has(name)) updated.push(name);
    else created.push(name);
    existing.add(name);
  }
  return { created, updated, skipped, failed };
}

// ---------------------------------------------------------------------------
// Import parsers: SSH config
// ---------------------------------------------------------------------------

export interface SshParseOptions {
  home?: string;
  fileExists?: (filePath: string) => boolean;
}

export interface ApplyImportDefaultsOptions {
  home?: string;
  defaultUsername?: string;
  fileExists?: (filePath: string) => boolean;
}

function decodeText(input: string | Buffer): string {
  if (typeof input === 'string') return input.replace(/^\uFEFF/, '');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input).replace(/^\uFEFF/, '');
  } catch {
    try {
      return new TextDecoder('gb18030').decode(input).replace(/^\uFEFF/, '');
    } catch {
      return Buffer.from(input).toString('utf8').replace(/^\uFEFF/, '');
    }
  }
}

function splitMulti(value: string): string[] {
  return String(value)
    .replace(/;/g, ',')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' || first === "'") && first === last) return text.slice(1, -1);
  }
  return text;
}

function isWildcard(pattern: string): boolean {
  return /[?*!]/.test(pattern);
}

function expandIdentity(value: string, home: string): string {
  const text = value.trim().replace(/%d/g, home);
  if (text === '~') return home;
  if (text.startsWith('~/')) return path.join(home, text.slice(2));
  if (text.startsWith('~')) return path.join(home, text.slice(1).replace(/^\/+/, ''));
  if (path.isAbsolute(text)) return path.normalize(text);
  return path.join(home, '.ssh', text);
}

interface SshBlock {
  kind: 'host' | 'match';
  patterns: string[];
  value: string;
  options: Record<string, string[]>;
}

function tokenizeSshBlocks(source: string, warnings: string[]): SshBlock[] {
  const blocks: SshBlock[] = [];
  let current: SshBlock | null = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const spaceIndex = line.search(/\s/);
    const keyword = (spaceIndex === -1 ? line : line.slice(0, spaceIndex)).toLowerCase();
    const rest = spaceIndex === -1 ? '' : line.slice(spaceIndex + 1).trim();
    const value = unquote(rest);
    if (keyword === 'host') {
      current = { kind: 'host', patterns: value ? value.split(/\s+/) : [], value, options: {} };
      blocks.push(current);
    } else if (keyword === 'match') {
      current = { kind: 'match', patterns: [], value, options: {} };
      blocks.push(current);
    } else if (keyword === 'include') {
      warnings.push(`跳过 Include 指令: ${value}`);
      current = null;
    } else if (current) {
      (current.options[keyword] ??= []).push(value);
    }
  }
  return blocks;
}

/** Parse `~/.ssh/config` text into import candidates (no defaults applied). */
export function parseSshConfig(text: string | Buffer, options: SshParseOptions = {}): ParseResult {
  const home = options.home ?? os.homedir();
  const fileExists = options.fileExists ?? ((filePath: string) => fs.existsSync(filePath));
  const source = decodeText(text);
  const warnings: string[] = [];
  const candidates: HostCandidate[] = [];
  const errors: ParseError[] = [];

  for (const block of tokenizeSshBlocks(source, warnings)) {
    if (block.kind === 'match') {
      warnings.push(block.value ? `跳过 Match 配置块: ${block.value}` : '跳过 Match 配置块');
      continue;
    }
    const aliases: string[] = [];
    for (const pattern of block.patterns) {
      if (isWildcard(pattern)) warnings.push(`跳过通配符 Host: ${pattern}`);
      else aliases.push(pattern);
    }
    if (aliases.length === 0) continue;

    const opts = block.options;
    const hostname = (opts['hostname']?.[0] ?? '').trim();
    const username = (opts['user']?.[0] ?? '').trim();
    let port = 22;
    const rawPort = (opts['port']?.[0] ?? '').trim();
    if (rawPort) {
      const parsed = /^-?\d+$/.test(rawPort) ? Number(rawPort) : null;
      if (parsed === null) warnings.push(`无效端口 ${rawPort}，使用默认 22`);
      else port = parsed;
    }
    const identity = (opts['identityfile']?.[0] ?? '').trim();
    let keyPath: string | null = null;
    if (identity) {
      keyPath = expandIdentity(identity, home);
      if (!fileExists(keyPath)) warnings.push(`私钥文件不存在: ${keyPath}`);
    }
    const needsProxy = 'proxyjump' in opts || 'proxycommand' in opts;

    for (const alias of aliases) {
      const host = hostname || alias;
      const candidateWarnings: string[] = [];
      if (needsProxy) {
        candidateWarnings.push(PROXY_ERROR);
        warnings.push(`主机 ${alias} 需要代理跳转，工具暂不支持`);
      }
      candidates.push({
        name: alias,
        host,
        port,
        port_explicit: Boolean(rawPort),
        username,
        auth_type: 'key',
        key_path: keyPath,
        tags: [],
        disk_mounts: [...DEFAULT_DISK_MOUNTS],
        group: DEFAULT_GROUP,
        owner: '',
        location: '',
        notes: '',
        warnings: candidateWarnings,
        valid: !needsProxy,
        error: needsProxy ? PROXY_ERROR : null,
      });
    }
  }
  return { candidates, errors, warnings };
}

function parseStarDefaults(source: string): Record<string, string> {
  const defaults: Record<string, string> = {};
  let inStar = false;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const spaceIndex = line.search(/\s/);
    const keyword = (spaceIndex === -1 ? line : line.slice(0, spaceIndex)).toLowerCase();
    const value = unquote(spaceIndex === -1 ? '' : line.slice(spaceIndex + 1).trim());
    if (keyword === 'host') {
      inStar = value.split(/\s+/).includes('*');
      continue;
    }
    if (keyword === 'match' || keyword === 'include') {
      inStar = false;
      continue;
    }
    if (inStar && !(keyword in defaults) && value) defaults[keyword] = value;
  }
  return defaults;
}

function replaceSshTokens(value: string, tokens: { home: string; host: string; username: string }): string {
  return value.replace(/%d/g, tokens.home).replace(/%h/g, tokens.host).replace(/%u/g, tokens.username);
}

/** Fill `Host *` defaults, `${...}`-style tokens and fallbacks into candidates. */
export function applyImportDefaults(
  result: ParseResult,
  text: string | Buffer,
  options: ApplyImportDefaultsOptions = {},
): ParseResult {
  const home = options.home ?? os.homedir();
  const fileExists = options.fileExists ?? ((filePath: string) => fs.existsSync(filePath));
  const source = decodeText(text);
  const defaults = parseStarDefaults(source);
  const defaultUser = defaults['user'] || options.defaultUsername || '';
  const defaultIdentity = defaults['identityfile'];
  const resolved: HostCandidate[] = [];
  let unusedTokensSeen = false;

  for (const candidate of result.candidates) {
    const usernameSeed = candidate.username || defaultUser;
    const host = replaceSshTokens(candidate.host, { home, host: candidate.host, username: usernameSeed });
    const username = replaceSshTokens(usernameSeed, { home, host, username: usernameSeed });

    let port = candidate.port;
    if (!candidate.port_explicit && defaults['port'] && /^-?\d+$/.test(defaults['port'])) {
      const defaultPort = Number(defaults['port']);
      if (defaultPort > 0 && defaultPort < 65536) port = defaultPort;
    }

    let keyPath = candidate.key_path;
    if (keyPath) {
      keyPath = replaceSshTokens(keyPath, { home, host, username });
    } else if (defaultIdentity) {
      keyPath = expandIdentity(replaceSshTokens(defaultIdentity, { home, host, username }), home);
    } else {
      for (const fallback of ['id_ed25519', 'id_rsa']) {
        const candidatePath = path.join(home, '.ssh', fallback);
        if (fileExists(candidatePath)) {
          keyPath = candidatePath;
          break;
        }
      }
    }

    const candidateWarnings = [...candidate.warnings];
    if (!username) candidateWarnings.push('未指定用户名，导入后需补用户名');
    if (candidate.auth_type === 'key' && !keyPath) candidateWarnings.push('未指定 IdentityFile，导入后需补私钥或密码');
    else if (candidate.auth_type === 'key' && keyPath && !fileExists(keyPath)) {
      candidateWarnings.push(`私钥文件不存在: ${keyPath}`);
    }
    if ((keyPath && keyPath.includes('%')) || host.includes('%')) {
      unusedTokensSeen = true;
      candidateWarnings.push('包含未识别的 SSH 配置占位符，请检查');
    }

    const valid =
      Boolean(candidate.name && host && Number.isInteger(port) && port > 0 && port < 65536) && candidate.error === null;
    resolved.push({
      ...candidate,
      host,
      port,
      username,
      key_path: keyPath ?? null,
      warnings: dedupe(candidateWarnings),
      valid,
    });
  }

  const warnings = [...result.warnings];
  if (unusedTokensSeen) warnings.push('部分 SSH 配置包含未识别占位符，请确认导入后配置');
  return { candidates: resolved, errors: result.errors, warnings: dedupe(warnings) };
}

// ---------------------------------------------------------------------------
// Import parsers: CSV
// ---------------------------------------------------------------------------

function sniffDelimiter(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(0, 10);
  const commas = lines.reduce((sum, line) => sum + (line.split(',').length - 1), 0);
  const tabs = lines.reduce((sum, line) => sum + (line.split('\t').length - 1), 0);
  return tabs > commas ? '\t' : ',';
}

function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') continue;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normalizeHeader(header: string): string {
  const cleaned = header.replace(/^\uFEFF/, '').trim().toLowerCase();
  return HEADER_ALIASES[cleaned] ?? '';
}

/** Parse a CSV document into import candidates (mirrors `host_import.parse_csv`). */
export function parseCsv(text: string | Buffer): ParseResult {
  const source = decodeText(text);
  const delimiter = sniffDelimiter(source);
  const rows = parseCsvRows(source, delimiter).filter((row) => row.some((cell) => cell.trim() !== ''));
  const candidates: HostCandidate[] = [];
  const errors: ParseError[] = [];
  const warnings: string[] = [];
  if (rows.length === 0) return { candidates, errors, warnings };

  const header = rows[0];
  const fieldIndex = new Map<string, number>();
  header.forEach((cell, index) => {
    const field = normalizeHeader(cell);
    if (field && !fieldIndex.has(field)) fieldIndex.set(field, index);
  });
  if (!fieldIndex.has('name') || !fieldIndex.has('host')) {
    errors.push({ row: 1, error: '缺少必需列: name, host' });
    return { candidates, errors, warnings };
  }

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const record: Record<string, string> = {};
    for (const [field, index] of fieldIndex) record[field] = index < row.length ? row[index].trim() : '';
    const name = (record['name'] ?? '').trim();
    const host = (record['host'] ?? '').trim();
    if (!name || !host) {
      errors.push({ row: rowIndex + 1, error: 'name 和 host 不能为空' });
      continue;
    }
    let port = 22;
    const rawPort = (record['port'] ?? '').trim();
    if (rawPort) {
      const parsed = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        errors.push({ row: rowIndex + 1, error: `无效端口: ${rawPort}` });
        continue;
      }
      port = parsed;
    }
    const diskMounts = splitMulti(record['disk_mounts'] ?? '');
    candidates.push({
      name,
      host,
      port,
      port_explicit: Boolean(rawPort),
      username: (record['username'] ?? '').trim(),
      auth_type: (record['auth_type'] ?? '').trim() || 'key',
      key_path: (record['key_path'] ?? '').trim() || null,
      tags: splitMulti(record['tags'] ?? ''),
      disk_mounts: diskMounts.length > 0 ? diskMounts : [...DEFAULT_DISK_MOUNTS],
      group: (record['group'] ?? '').trim() || DEFAULT_GROUP,
      owner: (record['owner'] ?? '').trim(),
      location: (record['location'] ?? '').trim(),
      notes: (record['notes'] ?? '').trim(),
      warnings: [],
      valid: true,
      error: null,
    });
  }
  return { candidates, errors, warnings };
}

// ---------------------------------------------------------------------------
// Import parsers: YAML (minimal, dependency-free)
// ---------------------------------------------------------------------------

interface YamlLine {
  indent: number;
  text: string;
}

function stripYamlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function tokenizeYaml(text: string): YamlLine[] {
  const lines: YamlLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const stripped = stripYamlComment(rawLine);
    const trimmed = stripped.trim();
    if (!trimmed || trimmed === '---' || trimmed === '...') continue;
    const indent = stripped.length - stripped.trimStart().length;
    lines.push({ indent, text: trimmed });
  }
  return lines;
}

function isYamlSeqLine(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

function splitYamlKV(text: string): { key: string; value: string } | null {
  if (text.startsWith('[') || text.startsWith('{')) return null;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble) {
      const after = text[i + 1];
      if (after === undefined || after === ' ' || after === '\t') {
        return { key: unquote(text.slice(0, i).trim()), value: text.slice(i + 1).trim() };
      }
    }
  }
  return null;
}

function splitYamlFlow(inner: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (const ch of inner) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (ch === '[' || ch === '{') depth += 1;
      else if (ch === ']' || ch === '}') depth -= 1;
      else if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function parseYamlScalar(value: string): unknown {
  const text = value.trim();
  if (text === '') return null;
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return splitYamlFlow(inner).map((part) => parseYamlScalar(part));
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const inner = text.slice(1, -1).trim();
    const obj: Record<string, unknown> = {};
    if (inner) {
      for (const part of splitYamlFlow(inner)) {
        const kv = splitYamlKV(part);
        if (kv) obj[kv.key] = parseYamlScalar(kv.value);
      }
    }
    return obj;
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  const lower = text.toLowerCase();
  if (lower === 'null' || lower === '~') return null;
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^[+-]?\d+$/.test(text)) return Number(text);
  if (/^[+-]?\d*\.\d+$/.test(text)) return Number(text);
  return text;
}

function parseYamlNode(lines: YamlLine[], index: number, indent: number): { value: unknown; next: number } {
  if (isYamlSeqLine(lines[index].text)) return parseYamlSeq(lines, index, indent);
  return parseYamlMap(lines, index, indent);
}

function parseYamlMap(lines: YamlLine[], index: number, indent: number): { value: Record<string, unknown>; next: number } {
  const obj: Record<string, unknown> = {};
  let cur = index;
  while (cur < lines.length && lines[cur].indent === indent && !isYamlSeqLine(lines[cur].text)) {
    const kv = splitYamlKV(lines[cur].text);
    if (!kv) {
      cur += 1;
      continue;
    }
    cur += 1;
    if (kv.value === '') {
      if (cur < lines.length && lines[cur].indent > indent) {
        const child = parseYamlNode(lines, cur, lines[cur].indent);
        obj[kv.key] = child.value;
        cur = child.next;
      } else {
        obj[kv.key] = null;
      }
    } else {
      obj[kv.key] = parseYamlScalar(kv.value);
    }
  }
  return { value: obj, next: cur };
}

function parseYamlSeq(lines: YamlLine[], index: number, indent: number): { value: unknown[]; next: number } {
  const arr: unknown[] = [];
  let cur = index;
  while (cur < lines.length && lines[cur].indent === indent && isYamlSeqLine(lines[cur].text)) {
    const rest = lines[cur].text === '-' ? '' : lines[cur].text.slice(2).trim();
    if (rest === '') {
      cur += 1;
      if (cur < lines.length && lines[cur].indent > indent) {
        const child = parseYamlNode(lines, cur, lines[cur].indent);
        arr.push(child.value);
        cur = child.next;
      } else {
        arr.push(null);
      }
      continue;
    }
    const firstKv = splitYamlKV(rest);
    if (firstKv) {
      const obj: Record<string, unknown> = {};
      cur += 1;
      if (firstKv.value === '') {
        if (cur < lines.length && lines[cur].indent > indent && !isYamlSeqLine(lines[cur].text)) {
          const child = parseYamlNode(lines, cur, lines[cur].indent);
          obj[firstKv.key] = child.value;
          cur = child.next;
        } else {
          obj[firstKv.key] = null;
        }
      } else {
        obj[firstKv.key] = parseYamlScalar(firstKv.value);
      }
      if (cur < lines.length && lines[cur].indent > indent && !isYamlSeqLine(lines[cur].text)) {
        const more = parseYamlMap(lines, cur, lines[cur].indent);
        Object.assign(obj, more.value);
        cur = more.next;
      }
      arr.push(obj);
    } else {
      arr.push(parseYamlScalar(rest));
      cur += 1;
    }
  }
  return { value: arr, next: cur };
}

function parseYamlData(text: string): unknown {
  const lines = tokenizeYaml(text);
  if (lines.length === 0) return null;
  return parseYamlNode(lines, 0, lines[0].indent).value;
}

/**
 * Parse an arbitrary YAML document into plain JS data (maps, lists, scalars).
 *
 * Unlike {@link parseYaml} — which validates a *host-import* payload and only
 * accepts a list or a `{hosts: [...]}` mapping — this returns the raw document
 * tree without any schema checks. It is used by the first-run config-seed
 * importer (`runtime/first-run.ts`) to read a legacy `config.yaml`.
 */
export function parseYamlDocument(text: string | Buffer): unknown {
  return parseYamlData(decodeText(text));
}

function yamlTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
  }
  return splitMulti(asText(value));
}

function yamlDiskMounts(value: unknown): string[] {
  const mounts = yamlTags(value);
  return mounts.length > 0 ? mounts : [...DEFAULT_DISK_MOUNTS];
}

/** Parse a YAML document into import candidates (mirrors `host_import.parse_yaml`). */
export function parseYaml(text: string | Buffer): ParseResult {
  const source = decodeText(text);
  const candidates: HostCandidate[] = [];
  const errors: ParseError[] = [];
  const warnings: string[] = [];
  let data: unknown;
  try {
    data = parseYamlData(source);
  } catch (err) {
    errors.push({ row: null, error: `YAML 解析失败: ${(err as Error).message}` });
    return { candidates, errors, warnings };
  }
  if (data === null || data === undefined) return { candidates, errors, warnings };
  if (isMapping(data)) {
    if (!('hosts' in data)) {
      errors.push({ row: null, error: 'YAML 根节点必须为列表或包含 hosts 列表' });
      return { candidates, errors, warnings };
    }
    data = data['hosts'];
  }
  if (!Array.isArray(data)) {
    errors.push({ row: null, error: 'YAML 根节点必须为列表或包含 hosts 列表' });
    return { candidates, errors, warnings };
  }

  data.forEach((row, index) => {
    const rowNumber = index + 1;
    if (!isMapping(row)) {
      errors.push({ row: rowNumber, error: '主机条目必须为映射' });
      return;
    }
    const name = asText(row['name']);
    const host = asText(row['host']);
    if (!name || !host) {
      errors.push({ row: rowNumber, error: 'name 和 host 不能为空' });
      return;
    }
    let port = 22;
    const portRaw = row['port'];
    if (typeof portRaw === 'number') {
      if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
        errors.push({ row: rowNumber, error: `无效端口: ${portRaw}` });
        return;
      }
      port = portRaw;
    } else if (typeof portRaw === 'string' && portRaw.trim()) {
      const textPort = portRaw.trim();
      const parsed = /^\d+$/.test(textPort) ? Number(textPort) : NaN;
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        errors.push({ row: rowNumber, error: `无效端口: ${textPort}` });
        return;
      }
      port = parsed;
    }
    candidates.push({
      name,
      host,
      port,
      port_explicit: portRaw !== undefined && portRaw !== null && String(portRaw) !== '',
      username: asText(row['username']),
      auth_type: asText(row['auth_type']) || 'key',
      key_path: asText(row['key_path']) || null,
      tags: yamlTags(row['tags']),
      disk_mounts: yamlDiskMounts(row['disk_mounts']),
      group: asText(row['group']) || DEFAULT_GROUP,
      owner: asText(row['owner']),
      location: asText(row['location']),
      notes: asText(row['notes']),
      warnings: [],
      valid: true,
      error: null,
    });
  });
  return { candidates, errors, warnings };
}

// ---------------------------------------------------------------------------
// Import previews
// ---------------------------------------------------------------------------

const IMPORT_PARSERS: Record<string, (text: string | Buffer) => ParseResult> = {
  ssh: (text) => parseSshConfig(text),
  ssh_config: (text) => parseSshConfig(text),
  csv: (text) => parseCsv(text),
  yaml: (text) => parseYaml(text),
  yml: (text) => parseYaml(text),
};

/** Preview an import payload without touching the store (mirrors `_parse_import_payload`). */
export function previewHostImport(
  _db: SqliteDatabase | null,
  formatOrPayload: string | { format?: unknown; content?: unknown },
  maybeContent?: string,
): ImportPreview {
  let format: string;
  let content: unknown;
  if (typeof formatOrPayload === 'string') {
    format = formatOrPayload;
    content = maybeContent;
  } else {
    format = typeof formatOrPayload.format === 'string' ? formatOrPayload.format : '';
    content = formatOrPayload.content;
  }
  const normalized = format.trim().toLowerCase();
  const parser = IMPORT_PARSERS[normalized];
  if (!parser) throw new HostSettingsError('unsupported_format', { code: 'unsupported_format', status: 400 });
  if (typeof content !== 'string') throw new HostSettingsError('invalid_payload', { code: 'invalid_payload', status: 400 });
  return parser(content);
}

export interface SshPreviewOptions {
  home?: string;
  configPath?: string;
  defaultUsername?: string;
  fileExists?: (filePath: string) => boolean;
  readFile?: (filePath: string) => string | Buffer;
}

function currentUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env['USER'] ?? process.env['USERNAME'] ?? '';
  }
}

/** Preview the local `~/.ssh/config` as importable hosts (mirrors `_read_ssh_config_candidates`). */
export function previewSshConfigImport(options: SshPreviewOptions = {}): SshConfigPreview {
  const home = options.home ?? os.homedir();
  const configPath = options.configPath ?? path.join(home, '.ssh', 'config');
  const defaultUsername = options.defaultUsername ?? currentUsername();
  const fileExists = options.fileExists ?? ((filePath: string) => fs.existsSync(filePath));
  if (!fileExists(configPath)) {
    return { path: configPath, exists: false, default_username: defaultUsername, candidates: [], errors: [], warnings: [] };
  }
  const effectiveHome = path.dirname(path.dirname(configPath));
  const readFile = options.readFile ?? ((filePath: string) => fs.readFileSync(filePath));
  const raw = readFile(configPath);
  const parsed = parseSshConfig(raw, { home: effectiveHome, fileExists });
  const applied = applyImportDefaults(parsed, raw, { home: effectiveHome, defaultUsername, fileExists });
  return {
    path: configPath,
    exists: true,
    default_username: defaultUsername,
    candidates: applied.candidates,
    errors: applied.errors,
    warnings: applied.warnings,
  };
}

// ---------------------------------------------------------------------------
// Connectivity tests
// ---------------------------------------------------------------------------

function buildServer(entry: StoredHostEntry, context: HostContext): HostConfig {
  const name = asString(entry['name']);
  const host = asString(entry['host']);
  const username = asString(entry['username']);
  const authType = asString(entry['auth_type']);
  if (!name || !host || !username || !HOST_AUTH_TYPES.includes(authType)) {
    throw new HostSettingsError(
      `host entry is invalid: ${name || '<unnamed>'} (host/auth_type/username missing or unsupported)`,
    );
  }
  const port = asPort(entry['port']);
  const diskMounts =
    Array.isArray(entry['disk_mounts']) && entry['disk_mounts'].length > 0
      ? entry['disk_mounts'].map((mount) => String(mount))
      : [...DEFAULT_DISK_MOUNTS];

  const keyPathRaw = entry['key_path'];
  const keyPath = keyPathRaw === null || keyPathRaw === undefined || keyPathRaw === '' ? undefined : String(keyPathRaw);

  let auth: AuthConfig;
  if (authType === 'password') {
    const secret = context.secrets.read(secretName(HOST_SECRET_PASSWORD, name));
    auth = { type: 'password', password: secret ?? undefined };
  } else {
    auth = { type: 'key' };
    if (keyPath) auth.key_path = keyPath;
    const keyData = context.secrets.read(secretName(HOST_SECRET_KEY, name));
    const passphrase = context.secrets.read(secretName(HOST_SECRET_PASSPHRASE, name));
    if (keyData !== null) auth.key_data = keyData;
    if (passphrase !== null) auth.passphrase = passphrase;
  }

  const checks: HostCheckConfig[] = Array.isArray(entry['checks'])
    ? entry['checks'].filter(isMapping).map((check) => buildHostCheck(check))
    : [];

  const server: HostConfig = {
    name,
    host,
    port,
    username,
    auth,
    tags: Array.isArray(entry['tags']) ? entry['tags'].map((tag) => String(tag)) : [],
    disk_mounts: diskMounts,
    group: asString(entry['group']).trim() || DEFAULT_GROUP,
    owner: asString(entry['owner']).trim(),
    location: asString(entry['location']).trim(),
    notes: asString(entry['notes']).trim(),
    checks,
    allow_user_write: Boolean(entry['allow_user_write']),
  };
  const diskHealth = buildHostDiskHealth(entry['disk_health']);
  if (diskHealth) server.disk_health = diskHealth;
  const alertRules = buildHostAlertRules(entry['alert_rules']);
  if (alertRules) server.alert_rules = alertRules;
  const userMonitoring = triStateBoolLenient(entry['user_monitoring']);
  if (userMonitoring !== null) server.user_monitoring = userMonitoring;
  const sudoPassword = context.secrets.read(secretName(HOST_SECRET_SUDO_PASSWORD, name));
  if (sudoPassword !== null) server.sudo_password = sudoPassword;
  return server;
}

/** Build the effective `HostConfig[]` (mirrors `HostsMixin._build_servers`). */
export function buildServers(db: SqliteDatabase, options: HostsOptions = {}): HostConfig[] {
  const context = makeContext(db, options);
  return entriesForUpdate(db, options).map((entry) => buildServer(entry, context));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Run an injected connectivity runner for each named host (mirrors `api_test_hosts_batch`). */
export async function testHostsBatch(
  db: SqliteDatabase,
  names: string[],
  runner: HostRunner,
  options: HostsOptions = {},
): Promise<HostBatchResult> {
  if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) {
    throw new HostSettingsError('invalid_payload', { code: 'invalid_payload', status: 400 });
  }
  const hostNames = new Set(listHosts(db, options).map((host) => host.name));
  const serverByName = new Map<string, HostConfig>();
  try {
    for (const server of buildServers(db, options)) serverByName.set(server.name, server);
  } catch {
    // Leave the map empty; each host reports "主机配置不可用" below.
  }

  const runOne = async (name: string): Promise<HostBatchResultRow> => {
    if (!hostNames.has(name)) return { name, ok: false, detail: '主机不存在' };
    const server = serverByName.get(name);
    if (!server) return { name, ok: false, detail: '主机配置不可用' };
    try {
      const result = await runner(server);
      return { name, ok: result.exitStatus === 0, detail: (result.stdout || result.stderr || '').trim() };
    } catch (err) {
      return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  };

  const results = await mapWithConcurrency(names, names.length <= 1 ? 1 : 4, runOne);
  return { results };
}
