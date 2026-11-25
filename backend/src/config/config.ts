import * as os from 'node:os';
import * as path from 'node:path';

import { ConfigError } from './errors';
import { readEnv } from './env';
import { resolvePaths } from './paths';
import { APP_VERSION } from '../version';

export { ConfigError } from './errors';

/** Authentication material for one host (mirrors `servermanage.models.AuthConfig`). */
export interface AuthConfig {
  type: string;
  password?: string | null;
  password_env?: string;
  key_path?: string;
  passphrase?: string | null;
  passphrase_env?: string;
  key_data?: string;
}

/** Per-host disk health override (mirrors `HostDiskHealthOverride`). */
export interface HostDiskHealthOverride {
  enabled?: boolean;
  storcli_path?: string;
  use_sudo?: boolean;
}

/** One synthetic health check attached to a host (mirrors `HostCheckConfig`). */
export interface HostCheckConfig {
  name: string;
  type: string;
  target: string;
  timeout_seconds: number;
  expected?: string;
  enabled: boolean;
}

/** Per-host alert threshold overrides (mirrors `HostAlertRules`). */
export interface HostAlertRules {
  cpu_percent?: number;
  memory_percent?: number;
  disk_percent?: number;
  gpu_memory_percent?: number;
  disk_temperature_c?: number;
  consecutive_periods?: number;
}

/** A monitored host (mirrors `servermanage.models.HostConfig`). */
export interface HostConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthConfig;
  tags: string[];
  disk_health?: HostDiskHealthOverride;
  disk_mounts: string[];
  group: string;
  owner: string;
  location: string;
  notes: string;
  checks: HostCheckConfig[];
  alert_rules?: HostAlertRules;
  user_monitoring?: boolean;
  allow_user_write: boolean;
  sudo_password?: string;
}

/** Resolved application configuration produced by {@link loadConfig}. */
export interface AppConfig {
  dbPath: string;
  host: string;
  port: number;
  dataDir: string;
  logDir: string;
  servers: HostConfig[];
  tls?: { cert?: string; key?: string };
  appVersion: string;
  configPath?: string;
  dotenvPath?: string;
  runtimePath?: string;
  backupsDir?: string;
}

export interface NormalizeOptions {
  /** Environment used to resolve secret references (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** When true, missing secret env vars yield `null` instead of throwing. */
  allowMissingSecrets?: boolean;
}

export interface ConfigOverrides {
  /** Already-parsed `servers` section (YAML is parsed elsewhere). */
  servers?: unknown;
  /** Already-parsed `dashboard` section; drives host/port like config.py. */
  dashboard?: { host?: string; port?: number };
}

const MAX_CHECKS = 20;
const DEFAULT_HOST_PORT = 22;
const DEFAULT_DASHBOARD_HOST = '0.0.0.0';
const DEFAULT_DASHBOARD_PORT = 8080;
const DEFAULT_DISK_MOUNTS = ['/', '/data'];
const DEFAULT_GROUP = '未分组';

const ALERT_RULE_RANGES: Record<string, [number, number]> = {
  cpu_percent: [1, 100],
  memory_percent: [1, 100],
  disk_percent: [1, 100],
  gpu_memory_percent: [1, 100],
  disk_temperature_c: [1, 120],
};

const EXPECTED_STATUS_RE = /^\d{3}(-\d{3})?$/;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireMapping(value: unknown, name: string): Record<string, unknown> {
  if (!isMapping(value)) {
    throw new ConfigError(`${name} must be a mapping`);
  }
  return value;
}

function requireString(mapping: Record<string, unknown>, key: string, section: string): string {
  const value = mapping[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${section}.${key} is required`);
  }
  return value.trim();
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => String(item));
}

function loadBool(value: unknown, label: string, fallback = false): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${label} must be a boolean`);
  }
  return value;
}

function optionalBool(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${label} must be a boolean`);
  }
  return value;
}

function expandHome(raw: string): string {
  if (raw === '~') {
    return os.homedir();
  }
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

function loadHostPort(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_HOST_PORT;
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n)) {
    throw new ConfigError('servers[].port must be an integer');
  }
  return n;
}

function loadAuth(data: Record<string, unknown>, env: NodeJS.ProcessEnv, allowMissingSecrets: boolean): AuthConfig {
  const authType = data.type;

  if (authType === 'password') {
    const envName = asString(data.password_env);
    if (envName === undefined || envName.trim() === '') {
      throw new ConfigError('password auth requires password_env');
    }
    let password: string | null = env[envName] ?? null;
    if (password === null && !allowMissingSecrets) {
      throw new ConfigError(`Missing required environment variable: ${envName}`);
    }
    return { type: 'password', password_env: envName, password };
  }

  if (authType === 'key') {
    const keyData = data.key_data;
    const passphraseEnv = asString(data.passphrase_env);
    let passphrase: string | null = null;
    if (typeof data.passphrase === 'string') {
      passphrase = data.passphrase;
    } else if (passphraseEnv !== undefined) {
      passphrase = env[passphraseEnv] ?? null;
      if (passphrase === null && !allowMissingSecrets) {
        throw new ConfigError(`Missing required environment variable: ${passphraseEnv}`);
      }
    }

    const keyPathRaw = data.key_path;
    const hasKeyPath = typeof keyPathRaw === 'string' && keyPathRaw.trim() !== '';

    if (!hasKeyPath && keyData !== undefined && keyData !== null) {
      return {
        type: 'key',
        key_data: String(keyData),
        passphrase,
        passphrase_env: passphraseEnv,
      };
    }
    if (!hasKeyPath) {
      throw new ConfigError('SSH key path does not exist');
    }
    return {
      type: 'key',
      key_path: expandHome(String(keyPathRaw)),
      passphrase,
      passphrase_env: passphraseEnv,
    };
  }

  const printable = authType === undefined || authType === null ? 'None' : String(authType);
  throw new ConfigError(`Unsupported auth type: ${printable}`);
}

function loadCheckTimeout(value: unknown, label: string): number {
  if (value === undefined || value === null) {
    return 5;
  }
  if (typeof value === 'boolean') {
    throw new ConfigError(`${label}.timeout_seconds must be an integer`);
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n)) {
    throw new ConfigError(`${label}.timeout_seconds must be an integer`);
  }
  if (n < 1 || n > 30) {
    throw new ConfigError(`${label}.timeout_seconds must be between 1 and 30`);
  }
  return n;
}

function loadHostChecks(raw: unknown): HostCheckConfig[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new ConfigError('servers[].checks must be a list');
  }
  if (raw.length > MAX_CHECKS) {
    throw new ConfigError('servers[].checks supports at most 20 entries');
  }

  const seen = new Set<string>();
  return raw.map((item, index) => {
    const label = `servers[].checks[${index}]`;
    const mapping = requireMapping(item, label);

    const name = requireString(mapping, 'name', label);
    if (name.length > 64) {
      throw new ConfigError(`${label}.name must be at most 64 characters`);
    }
    const folded = name.toLowerCase();
    if (seen.has(folded)) {
      throw new ConfigError(`${label}.name duplicates another check: ${name}`);
    }
    seen.add(folded);

    const type = requireString(mapping, 'type', label);
    const target = requireString(mapping, 'target', label);
    const timeout_seconds = loadCheckTimeout(mapping.timeout_seconds, label);

    let expected: string | undefined;
    if (mapping.expected !== undefined && mapping.expected !== null) {
      if (typeof mapping.expected !== 'string' || !EXPECTED_STATUS_RE.test(mapping.expected)) {
        throw new ConfigError(`${label}.expected must be a status code or range (e.g. 200 or 200-299)`);
      }
      expected = mapping.expected;
    }

    const enabled =
      mapping.enabled === undefined || mapping.enabled === null
        ? true
        : loadBool(mapping.enabled, `${label}.enabled`, true);

    return { name, type, target, timeout_seconds, expected, enabled };
  });
}

function loadHostAlertRules(raw: unknown): HostAlertRules | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const mapping = requireMapping(raw, 'servers[].alert_rules');
  const result: HostAlertRules = {};

  for (const key of Object.keys(ALERT_RULE_RANGES)) {
    const [min, max] = ALERT_RULE_RANGES[key];
    const value = mapping[key];
    if (value === undefined || value === null) {
      (result as Record<string, unknown>)[key] = undefined;
      continue;
    }
    if (typeof value === 'boolean') {
      throw new ConfigError(`servers[].alert_rules.${key} must be a number`);
    }
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) {
      throw new ConfigError(`servers[].alert_rules.${key} must be a number`);
    }
    if (n < min || n > max) {
      throw new ConfigError(`servers[].alert_rules.${key} must be between ${min} and ${max}`);
    }
    (result as Record<string, unknown>)[key] = n;
  }

  const consecutive = mapping.consecutive_periods;
  if (consecutive === undefined || consecutive === null) {
    result.consecutive_periods = undefined;
  } else {
    if (typeof consecutive === 'boolean' || !Number.isInteger(Number(consecutive))) {
      throw new ConfigError('servers[].alert_rules.consecutive_periods must be an integer');
    }
    const n = Number(consecutive);
    if (n < 1 || n > 10) {
      throw new ConfigError('servers[].alert_rules.consecutive_periods must be between 1 and 10');
    }
    result.consecutive_periods = n;
  }

  return result;
}

function loadHostDisk(raw: unknown): HostDiskHealthOverride | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const mapping = requireMapping(raw, 'servers[].disk_health');
  return {
    enabled: optionalBool(mapping.enabled, 'servers[].disk_health.enabled'),
    storcli_path:
      mapping.storcli_path === undefined || mapping.storcli_path === null
        ? undefined
        : String(mapping.storcli_path),
    use_sudo: optionalBool(mapping.use_sudo, 'servers[].disk_health.use_sudo'),
  };
}

function loadUserMonitoring(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new ConfigError('servers[].user_monitoring must be a boolean');
  }
  return value;
}

function loadSudoPassword(mapping: Record<string, unknown>, env: NodeJS.ProcessEnv): string | undefined {
  const envName = asString(mapping.sudo_password_env);
  if (envName !== undefined && envName.trim() !== '') {
    const fromEnv = env[envName];
    if (fromEnv) {
      return fromEnv;
    }
  }
  const direct = mapping.sudo_password;
  if (direct === undefined || direct === null) {
    return undefined;
  }
  const s = String(direct);
  return s === '' ? undefined : s;
}

function loadAuthFromHost(mapping: Record<string, unknown>): Record<string, unknown> {
  const raw = mapping.auth;
  if (raw === undefined || raw === null) {
    return {};
  }
  return requireMapping(raw, 'servers[].auth');
}

/**
 * Normalise one raw host entry into a {@link HostConfig}, applying the same
 * defaults and validation rules as `servermanage.config._load_host`.
 */
export function normalizeHost(raw: unknown, options: NormalizeOptions = {}): HostConfig {
  const env = options.env ?? process.env;
  const allowMissingSecrets = options.allowMissingSecrets ?? false;

  const mapping = requireMapping(raw, 'servers[]');

  const name = requireString(mapping, 'name', 'servers[]');
  const host = requireString(mapping, 'host', 'servers[]');
  const port = loadHostPort(mapping.port);
  const username = requireString(mapping, 'username', 'servers[]');

  const auth = loadAuth(loadAuthFromHost(mapping), env, allowMissingSecrets);

  const tags = toStringArray(mapping.tags) ?? [];
  const diskMounts = toStringArray(mapping.disk_mounts) ?? [...DEFAULT_DISK_MOUNTS];
  const group = mapping.group ? String(mapping.group) : DEFAULT_GROUP;
  const owner = mapping.owner ? String(mapping.owner) : '';
  const location = mapping.location ? String(mapping.location) : '';
  const notes = mapping.notes ? String(mapping.notes) : '';

  return {
    name,
    host,
    port,
    username,
    auth,
    tags,
    disk_health: loadHostDisk(mapping.disk_health),
    disk_mounts: diskMounts,
    group,
    owner,
    location,
    notes,
    checks: loadHostChecks(mapping.checks),
    alert_rules: loadHostAlertRules(mapping.alert_rules),
    user_monitoring: loadUserMonitoring(mapping.user_monitoring),
    allow_user_write: loadBool(mapping.allow_user_write, 'servers[].allow_user_write', false),
    sudo_password: loadSudoPassword(mapping, env),
  };
}

/**
 * Normalise an array of raw host entries. Mirrors `load_config_from_mapping`'s
 * servers handling: a non-list yields the oracle's "servers must not be empty".
 */
export function normalizeServers(raw: unknown, options: NormalizeOptions = {}): HostConfig[] {
  if (!Array.isArray(raw)) {
    throw new ConfigError('servers must not be empty');
  }
  return raw.map((item) => normalizeHost(item, options));
}

function parseServersJson(json: string | undefined): unknown {
  if (json === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new ConfigError(`SERVERMONITOR_SERVERS_JSON is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * Load the resolved application configuration.
 *
 * @param env       Environment to read (defaults to `process.env`); injectable for tests.
 * @param overrides Already-parsed config sections (e.g. from the YAML seed); the
 *                  `servers` array and `dashboard` host/port are honoured here.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: ConfigOverrides = {}): AppConfig {
  const configEnv = readEnv(env);

  const paths = resolvePaths({
    dataDir: configEnv.dataDir,
    installDir: configEnv.appDir,
    logDir: configEnv.logDir,
  });

  const host = configEnv.host ?? overrides.dashboard?.host ?? DEFAULT_DASHBOARD_HOST;
  const port = configEnv.port ?? overrides.dashboard?.port ?? DEFAULT_DASHBOARD_PORT;

  const rawServers = overrides.servers ?? parseServersJson(configEnv.serversJson) ?? [];
  const servers = normalizeServers(rawServers, { env, allowMissingSecrets: true });

  const tls =
    configEnv.tlsCert !== undefined || configEnv.tlsKey !== undefined
      ? { cert: configEnv.tlsCert, key: configEnv.tlsKey }
      : undefined;

  return {
    dbPath: paths.dbPath,
    host,
    port,
    dataDir: paths.dataDir,
    logDir: paths.logDir,
    servers,
    tls,
    appVersion: configEnv.appVersion ?? APP_VERSION,
    configPath: paths.configPath,
    dotenvPath: paths.dotenvPath,
    runtimePath: paths.runtimePath,
    backupsDir: paths.backupsDir,
  };
}
