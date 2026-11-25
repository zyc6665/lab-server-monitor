/**
 * First-run bootstrap helpers for the Electron-hosted backend.
 *
 * Task 2 of P6 gives the packaged backend a CLI (`--data-dir`, `--config`,
 * `--runtime`, `--import-legacy`, `--port`) and three pre-start steps:
 *
 * 1. {@link resolveRuntimePaths} — turn argv + env into the data directory,
 *    database path, config seed path and runtime handshake path.
 * 2. {@link firstRunImport} — on a brand-new install, atomically copy a legacy
 *    `servermonitor.db` from a known candidate location and import the legacy
 *    `config.yaml`/`.env` seed into the SQLite settings store (once, guarded by
 *    `app_settings['config_seed_imported']`).
 * 3. {@link migrateWithBackup} — snapshot an existing non-empty database before
 *    running the legacy schema migration, aborting startup if the backup fails.
 *
 * Behavioural intent mirrors the Python oracle's startup order
 * (`servermanage/app.py::load_runtime_with_settings`: load dotenv → load config
 * → init_storage → settings.load → re-init), adapted to the desktop design
 * where the SQLite store, not `config.yaml`, is authoritative after first run.
 *
 * Everything filesystem-related is injectable so the import path can be unit
 * tested without touching the user's real profile.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  DEFAULT_DB_FILE_NAME,
  backupsDirFrom,
  configPathFrom,
  dbPathFrom,
  resolvePaths,
  runtimePathFrom,
} from '../config/paths';
import { parseYamlDocument } from '../config/hosts';
import { validateSection } from '../config/schema';
import { openDatabase } from '../storage/db';
import { SCHEMA_VERSION, CREATE_STATEMENTS } from '../storage/schema';
import { backupBeforeMigration, migrateLegacy } from '../storage/migrate';
import { loadAppSettings, saveAppSettings } from '../storage/settings';
import { nowIsoUtc } from '../storage/time';

type SqliteDatabase = import('better-sqlite3').Database;

/** `app_settings` marker written by the config-seed importer. */
export const CONFIG_SEED_MARKER = 'config_seed_imported';
/** `app_settings` marker written when a legacy database was copied in. */
export const LEGACY_IMPORT_MARKER = 'first_run_imported';

// ---------------------------------------------------------------------------
// Filesystem seam
// ---------------------------------------------------------------------------

/** The subset of `node:fs` the import path needs (injectable for tests). */
export interface FirstRunFs {
  existsSync(p: string): boolean;
  statSync(p: string): { size: number };
  mkdirSync(p: string, opts?: { recursive?: boolean }): string | undefined;
  copyFileSync(src: string, dest: string): void;
  renameSync(from: string, to: string): void;
  rmSync(p: string, opts?: { force?: boolean }): void;
  readFileSync(p: string, encoding: 'utf8'): string;
}

const defaultFs: FirstRunFs = {
  existsSync: (p) => fs.existsSync(p),
  statSync: (p) => fs.statSync(p),
  mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
  copyFileSync: (src, dest) => fs.copyFileSync(src, dest),
  renameSync: (from, to) => fs.renameSync(from, to),
  rmSync: (p, opts) => fs.rmSync(p, opts),
  readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
};

function fileNonEmpty(fsApi: FirstRunFs, p: string): boolean {
  return fsApi.existsSync(p) && fsApi.statSync(p).size > 0;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/** Parsed subset of the backend CLI flags. */
export interface ParsedServerArgv {
  dataDir?: string;
  config?: string;
  runtime?: string;
  importLegacy: boolean;
  port?: number;
}

function parsePortArg(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`--port must be an integer between 0 and 65535 (got "${raw}")`);
  }
  return n;
}

interface ArgValue {
  value?: string;
  /** Index of the consumed value token (equals `index` for `--flag=value`). */
  next: number;
}

function readArgValue(argv: readonly string[], index: number): ArgValue {
  const token = argv[index];
  const eq = token.indexOf('=');
  if (eq >= 0) {
    return { value: token.slice(eq + 1), next: index };
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) {
    return { value: undefined, next: index };
  }
  return { value: next, next: index + 1 };
}

/**
 * Parse the recognised backend flags out of `argv`.
 *
 * Accepts both `--flag value` and `--flag=value`. Unknown tokens (the node
 * binary, the script path, anything else) are ignored, so callers may pass the
 * raw `process.argv`. `--import-legacy` is a bare boolean switch.
 */
export function parseServerArgv(argv: readonly string[]): ParsedServerArgv {
  const parsed: ParsedServerArgv = { importLegacy: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf('=');
    const name = eq >= 0 ? token.slice(0, eq) : token;

    if (name === '--data-dir') {
      const { value, next } = readArgValue(argv, i);
      if (value !== undefined && value !== '') parsed.dataDir = value;
      i = next;
    } else if (name === '--config') {
      const { value, next } = readArgValue(argv, i);
      if (value !== undefined && value !== '') parsed.config = value;
      i = next;
    } else if (name === '--runtime') {
      const { value, next } = readArgValue(argv, i);
      if (value !== undefined && value !== '') parsed.runtime = value;
      i = next;
    } else if (name === '--port') {
      const { value, next } = readArgValue(argv, i);
      if (value !== undefined && value !== '') parsed.port = parsePortArg(value);
      i = next;
    } else if (name === '--import-legacy') {
      parsed.importLegacy = true;
    }
  }
  return parsed;
}

/** Resolved runtime paths returned by {@link resolveRuntimePaths}. */
export interface ResolvedRuntimePaths {
  dataDir: string;
  dbPath: string;
  configSeedPath?: string;
  runtimePath?: string;
  importLegacy: boolean;
  /** `--port` when supplied (0 = OS-assigned); the caller keeps its default otherwise. */
  port?: number;
}

function defaultDataDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env['SERVERMONITOR_DATA_DIR']?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  const localAppData = env['LOCALAPPDATA']?.trim();
  if (localAppData) {
    return path.join(localAppData, 'ServerMonitor');
  }
  // Fall back to the pure `paths.ts` layout (`<installDir>/data`).
  return path.resolve(resolvePaths({ installDir: env['SERVERMONITOR_APP_DIR']?.trim() }).dataDir);
}

/**
 * Resolve the runtime data-directory layout from CLI argv + environment.
 *
 * Precedence for the data directory: `--data-dir` > `SERVERMONITOR_DATA_DIR`
 * > `%LOCALAPPDATA%\\ServerMonitor` > `<SERVERMONITOR_APP_DIR|.>/data`.
 * The config seed defaults to `<dataDir>/config/config.yaml` only when it
 * actually exists; the runtime handshake file is written only when `--runtime`
 * is given (preserving the pre-P6 `--port/--runtime` contract).
 */
export function resolveRuntimePaths(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRuntimePaths {
  const parsed = parseServerArgv(argv);
  const dataDir = parsed.dataDir !== undefined ? path.resolve(parsed.dataDir) : defaultDataDir(env);
  const dbPath = dbPathFrom(dataDir);

  let configSeedPath: string | undefined;
  if (parsed.config !== undefined) {
    configSeedPath = path.resolve(parsed.config);
  } else {
    const candidate = configPathFrom(dataDir);
    if (fs.existsSync(candidate)) {
      configSeedPath = candidate;
    }
  }

  const runtimePath = parsed.runtime !== undefined ? path.resolve(parsed.runtime) : undefined;

  return {
    dataDir,
    dbPath,
    configSeedPath,
    runtimePath,
    importLegacy: parsed.importLegacy,
    port: parsed.port,
  };
}

/**
 * Candidate locations for a legacy `data/servermonitor.db`.
 *
 * `SERVERMONITOR_LEGACY_DB` (if set) takes priority, then the conventional
 * `<dataDir>/../data/servermonitor.db` (a portable install unpacked beside its
 * data) and `<cwd>/data/servermonitor.db` (a source checkout). Duplicates are
 * removed so the first existing candidate wins deterministically.
 */
export function resolveLegacyCandidates(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string[] {
  const raw: string[] = [];
  const explicit = env['SERVERMONITOR_LEGACY_DB']?.trim();
  if (explicit) raw.push(explicit);
  raw.push(path.join(dataDir, '..', 'data', DEFAULT_DB_FILE_NAME));
  raw.push(path.join(cwd, 'data', DEFAULT_DB_FILE_NAME));

  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of raw) {
    const resolved = path.resolve(candidate);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      result.push(resolved);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Atomic legacy copy
// ---------------------------------------------------------------------------

/**
 * Copy `src` (and any `-wal`/`-shm` siblings) to `dest` via a temporary file
 * followed by a rename, so a crash never leaves a partially written database in
 * place and an existing `dest` is only replaced after the copy fully succeeds.
 */
function atomicCopyDatabase(fsApi: FirstRunFs, src: string, dest: string): void {
  fsApi.mkdirSync(path.dirname(dest), { recursive: true });
  const suffix = `.import-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmp = `${dest}${suffix}.tmp`;

  const copySiblings = (): string[] => {
    const temps = [tmp];
    fsApi.copyFileSync(src, tmp);
    for (const ext of ['-wal', '-shm']) {
      if (fsApi.existsSync(`${src}${ext}`)) {
        fsApi.copyFileSync(`${src}${ext}`, `${tmp}${ext}`);
        temps.push(`${tmp}${ext}`);
      }
    }
    return temps;
  };

  let temps: string[] = [];
  try {
    temps = copySiblings();
    if (fsApi.existsSync(dest)) {
      fsApi.rmSync(dest, { force: true });
    }
    fsApi.renameSync(tmp, dest);
    temps = temps.filter((p) => p !== tmp);
    for (const ext of ['-wal', '-shm']) {
      const from = `${tmp}${ext}`;
      if (fsApi.existsSync(from)) {
        if (fsApi.existsSync(`${dest}${ext}`)) {
          fsApi.rmSync(`${dest}${ext}`, { force: true });
        }
        fsApi.renameSync(from, `${dest}${ext}`);
        temps = temps.filter((p) => p !== from);
      }
    }
  } catch (err) {
    for (const leftover of temps) {
      try {
        fsApi.rmSync(leftover, { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Config-seed import
// ---------------------------------------------------------------------------

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asMapping(value: unknown): Record<string, unknown> {
  return isMapping(value) ? value : {};
}

function pickPresent(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out;
}

function hasKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

const ALERT_TOP_FIELDS = [
  'enabled',
  'desktop_notification',
  'email',
  'cooldown_minutes',
  'repeat_while_active',
  'offline_failures',
  'aggregate_by_host',
  'notify_on_recovery',
  'consecutive_periods',
] as const;
const THRESHOLD_FIELDS = [
  'cpu_percent',
  'memory_percent',
  'disk_percent',
  'gpu_memory_percent',
  'disk_temperature_c',
] as const;
const REPORT_TOP_FIELDS = [
  'subject_prefix',
  'include_failed_hosts',
  'daily_enabled',
  'daily_time',
] as const;
const WEEKLY_FIELDS = [
  'enabled',
  'subject_prefix',
  'busy_threshold',
  'idle_threshold',
  'time',
  'weekday',
] as const;
const DISK_TOP_FIELDS = ['enabled', 'use_sudo', 'storcli_candidates'] as const;
const DISK_RULE_FIELDS = [
  'alert_on_media_errors',
  'alert_on_other_errors',
  'alert_on_predictive_failure',
  'alert_on_smart_flag',
  'alert_on_state_not_optimal',
  'alert_on_error_increase',
] as const;
const SSH_FIELDS = ['connect_timeout', 'command_timeout', 'host_key_policy'] as const;
const SMTP_FIELDS = ['host', 'port', 'username', 'use_ssl', 'from_addr', 'to_addrs'] as const;
const USER_MONITORING_FIELDS = [
  'enabled',
  'scan_interval_seconds',
  'usage_interval_seconds',
  'usage_timeout_seconds',
  'command_timeout',
  'write_enabled',
] as const;

interface SectionImport {
  section: string;
  payload: Record<string, unknown>;
}

/**
 * Project a parsed legacy `config.yaml` document onto the settings sections the
 * SQLite store knows about (the field names match the Python `public_settings`
 * projection, minus credential values which stay in the env/DPAPI layer).
 *
 * Only sections actually present in the YAML are returned, so a seed that only
 * customises `ssh` never stamps default values over the other sections.
 */
export function extractConfigSections(raw: unknown): SectionImport[] {
  if (!isMapping(raw)) {
    return [];
  }
  const out: SectionImport[] = [];
  const push = (section: string, payload: Record<string, unknown>): void => {
    if (hasKeys(payload)) {
      out.push({ section, payload });
    }
  };

  // monitoring ← app + storage + explicit monitoring (Python keeps these on
  // AppRuntimeConfig; the store merges them into one section).
  const app = raw['app'];
  const storage = raw['storage'];
  const monitoring = raw['monitoring'];
  if (isMapping(app) || isMapping(storage) || isMapping(monitoring)) {
    push('monitoring', { ...asMapping(storage), ...asMapping(app), ...asMapping(monitoring) });
  }

  if (isMapping(raw['dashboard'])) {
    const dashboard = asMapping(raw['dashboard']);
    const payload = pickPresent(dashboard, ['host', 'port', 'session_lifetime_hours']);
    const auth = asMapping(dashboard['auth']);
    if (hasKeys(auth)) {
      payload['auth'] = pickPresent(auth, ['enabled', 'username', 'password_env']);
    }
    push('dashboard', payload);
  }

  if (isMapping(raw['ssh'])) {
    push('ssh', pickPresent(asMapping(raw['ssh']), SSH_FIELDS));
  }

  if (isMapping(raw['smtp'])) {
    push('smtp', pickPresent(asMapping(raw['smtp']), SMTP_FIELDS));
  }

  if (isMapping(raw['alerts'])) {
    const alerts = asMapping(raw['alerts']);
    const payload = pickPresent(alerts, ALERT_TOP_FIELDS);
    const thresholds = asMapping(alerts['thresholds']);
    if (hasKeys(thresholds)) {
      payload['thresholds'] = pickPresent(thresholds, THRESHOLD_FIELDS);
    }
    const webhook = asMapping(alerts['webhook']);
    if (hasKeys(webhook)) {
      const webhookPayload = pickPresent(webhook, ['enabled', 'type']);
      const urlEnv = webhook['url_env'];
      if (typeof urlEnv === 'string' && urlEnv.trim() !== '') {
        webhookPayload['url_env'] = urlEnv;
      }
      payload['webhook'] = webhookPayload;
    }
    push('alerts', payload);
  }

  if (isMapping(raw['report'])) {
    const report = asMapping(raw['report']);
    const payload = pickPresent(report, REPORT_TOP_FIELDS);
    const weekly = asMapping(report['weekly']);
    if (hasKeys(weekly)) {
      payload['weekly'] = pickPresent(weekly, WEEKLY_FIELDS);
    }
    push('report', payload);
  }

  if (isMapping(raw['disk_health'])) {
    const disk = asMapping(raw['disk_health']);
    const payload = pickPresent(disk, DISK_TOP_FIELDS);
    const rules = asMapping(disk['rules']);
    if (hasKeys(rules)) {
      payload['rules'] = pickPresent(rules, DISK_RULE_FIELDS);
    }
    push('disk_health', payload);
  }

  if (isMapping(raw['user_monitoring'])) {
    push('user_monitoring', pickPresent(asMapping(raw['user_monitoring']), USER_MONITORING_FIELDS));
  }

  return out;
}

/** Parse a `.env` file into a plain key/value map (no expansion, `export` stripped). */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '') {
      out[key] = value;
    }
  }
  return out;
}

function ensureAppSettingsTable(db: SqliteDatabase): void {
  const ddl = CREATE_STATEMENTS.find((statement) =>
    /^\s*CREATE TABLE IF NOT EXISTS app_settings\b/.test(statement),
  );
  if (ddl) {
    db.exec(ddl);
  }
}

interface ImportConfigOptions {
  db: SqliteDatabase;
  seedPath: string;
  fsApi: FirstRunFs;
  env: NodeJS.ProcessEnv;
  now: Date;
  messages: string[];
}

/** Import one config seed into `app_settings` exactly once (marker-guarded). */
function importConfigSeed(options: ImportConfigOptions): boolean {
  const { db, seedPath, fsApi, env, now, messages } = options;
  ensureAppSettingsTable(db);

  const existing = loadAppSettings(db)[CONFIG_SEED_MARKER];
  if (existing !== undefined) {
    messages.push(`config seed already imported; ignoring ${seedPath}`);
    return false;
  }

  let raw: unknown;
  try {
    raw = parseYamlDocument(fsApi.readFileSync(seedPath, 'utf8'));
  } catch (err) {
    messages.push(`config seed could not be parsed (${(err as Error).message}); skipped`);
    return false;
  }

  const importedSections: string[] = [];
  for (const { section, payload } of extractConfigSections(raw)) {
    const { value, errors } = validateSection(section, payload);
    if (errors.length > 0) {
      messages.push(`config section ${section} skipped: ${errors.join('; ')}`);
      continue;
    }
    saveAppSettings(db, section, value);
    importedSections.push(section);
  }

  // `.env` companions carry the credential values (Python loads them with
  // dotenv override); mirror that by filling the process env rather than
  // persisting secret plaintext into app_settings.
  const dotenvPath = path.join(path.dirname(seedPath), '.env');
  let envCount = 0;
  if (fsApi.existsSync(dotenvPath)) {
    const entries = parseDotEnv(fsApi.readFileSync(dotenvPath, 'utf8'));
    for (const [key, value] of Object.entries(entries)) {
      env[key] = value;
      envCount += 1;
    }
    if (envCount > 0) {
      messages.push(`loaded ${envCount} entr${envCount === 1 ? 'y' : 'ies'} from .env`);
    }
  }

  saveAppSettings(db, CONFIG_SEED_MARKER, {
    imported_at: nowIsoUtc(now),
    source: seedPath,
    sections: importedSections,
  });
  messages.push(
    `imported config seed (${importedSections.length > 0 ? importedSections.join(', ') : 'no recognized sections'})`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// firstRunImport
// ---------------------------------------------------------------------------

/** Options for {@link firstRunImport}. */
export interface FirstRunImportOptions {
  /** Absolute data directory (created when missing). */
  dataDir: string;
  /**
   * Open database handle used for the marker/config import. Omit it when a
   * legacy copy may be performed: the function then opens the database itself
   * *after* the copy (a SQLite file cannot be replaced while a handle is open on
   * Windows).
   */
  db?: SqliteDatabase;
  /** Database path override (defaults to `<dataDir>/servermonitor.db`). */
  dbPath?: string;
  /** Candidate legacy `servermonitor.db` paths, in priority order. */
  legacyDbCandidates?: string[];
  /** Legacy `config.yaml` seed to import once. */
  configSeedPath?: string;
  /** Environment to read/write (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Clock for deterministic marker timestamps / backup names. */
  now?: Date;
  /** Filesystem seam (defaults to `node:fs`). */
  fs?: Partial<FirstRunFs>;
  /** Database opener seam (defaults to {@link openDatabase}). */
  openDb?: (dbPath: string) => SqliteDatabase;
}

/** Result of {@link firstRunImport}. */
export interface FirstRunImportResult {
  /** True when anything was imported (legacy copy and/or config seed). */
  imported: boolean;
  /** True when a legacy database file was copied into place. */
  legacyCopied: boolean;
  /** True when the config seed was imported on this call. */
  configImported: boolean;
  messages: string[];
  /** Path the import targeted (the resolved database path). */
  dbPath: string;
}

/**
 * Perform first-run data/config import.
 *
 * - When the target database is missing/empty and a legacy candidate exists, it
 *   is copied atomically into place (temp file + rename; never overwriting an
 *   existing non-empty database). A `first_run_imported` marker is recorded.
 * - When a `config.yaml` seed exists it is imported into `app_settings` once,
 *   guarded by the `config_seed_imported` marker; later boots log and skip it.
 *
 * All filesystem access flows through the injected {@link FirstRunFs}.
 */
export async function firstRunImport(
  options: FirstRunImportOptions,
): Promise<FirstRunImportResult> {
  const fsApi: FirstRunFs = { ...defaultFs, ...(options.fs ?? {}) };
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const dataDir = options.dataDir;
  const dbPath = options.dbPath ?? dbPathFrom(dataDir);
  const messages: string[] = [];

  fsApi.mkdirSync(dataDir, { recursive: true });

  let db = options.db;
  let ownsDb = false;
  const ensureDb = (): SqliteDatabase => {
    if (db === undefined) {
      db = (options.openDb ?? openDatabase)(dbPath);
      ownsDb = true;
    }
    return db;
  };

  let legacyCopied = false;
  const targetExists = fileNonEmpty(fsApi, dbPath);
  if (targetExists) {
    messages.push('existing database found; legacy import skipped');
  } else {
    const candidate = (options.legacyDbCandidates ?? []).find(
      (candidatePath) =>
        path.resolve(candidatePath) !== path.resolve(dbPath) && fileNonEmpty(fsApi, candidatePath),
    );
    if (candidate) {
      atomicCopyDatabase(fsApi, candidate, dbPath);
      legacyCopied = true;
      messages.push(`copied legacy database from ${candidate}`);
      const markerDb = ensureDb();
      ensureAppSettingsTable(markerDb);
      saveAppSettings(markerDb, LEGACY_IMPORT_MARKER, {
        imported_at: nowIsoUtc(now),
        copied_from: candidate,
      });
    } else {
      messages.push('no legacy database found; starting with a fresh database');
    }
  }

  let configImported = false;
  const seedPath = options.configSeedPath;
  if (seedPath !== undefined && fsApi.existsSync(seedPath)) {
    const configDb = ensureDb();
    configImported = importConfigSeed({ db: configDb, seedPath, fsApi, env, now, messages });
  } else if (seedPath !== undefined) {
    messages.push(`config seed not found at ${seedPath}`);
  }

  if (ownsDb && db !== undefined && db.open) {
    db.close();
  }

  return {
    imported: legacyCopied || configImported,
    legacyCopied,
    configImported,
    messages,
    dbPath,
  };
}

// ---------------------------------------------------------------------------
// migrateWithBackup
// ---------------------------------------------------------------------------

/** Options for {@link migrateWithBackup}. */
export interface MigrateWithBackupOptions {
  /** Clock used for the backup filename (deterministic in tests). */
  now?: Date;
  /** Backup directory override (defaults to `<dbDir>/backups`). */
  backupsDir?: string;
  /** Backup routine seam (defaults to {@link backupBeforeMigration}). */
  backup?: (dbPath: string, opts: { directory?: string; timestamp?: Date }) => Promise<string>;
}

/** Result of {@link migrateWithBackup}. */
export interface MigrateWithBackupResult {
  backedUp: boolean;
  backupPath?: string;
  migrated: boolean;
  userVersion: number;
}

/** Compact UTC stamp, e.g. `20261125T114712123Z` (filesystem-safe). */
function compactStamp(when: Date): string {
  return when.toISOString().replace(/[-:.]/g, '');
}

/** Count real (non-`app_settings`/`app_secrets`) user tables. */
function countContentTables(db: SqliteDatabase): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name NOT IN ('app_settings', 'app_secrets')`,
    )
    .get() as { c: number };
  return Number(row.c);
}

/**
 * Snapshot a non-empty, pre-migration database and then migrate it.
 *
 * A database counts as "non-empty" only when it already carries real content
 * tables (a first-run file that merely has the `app_settings` marker is still
 * treated as fresh). When `user_version` is behind {@link SCHEMA_VERSION} the
 * database is backed up to `<backups>/pre-migrate-<version>-<ts>.db` first; if
 * that copy fails, the error is propagated and startup must abort. Migration
 * itself runs in a single transaction, so a mid-migration failure rolls back.
 */
export async function migrateWithBackup(
  dbPath: string,
  db: SqliteDatabase,
  options: MigrateWithBackupOptions = {},
): Promise<MigrateWithBackupResult> {
  const userVersion = Number(db.pragma('user_version', { simple: true }) ?? 0);
  const contentTables = countContentTables(db);

  if (contentTables === 0 || userVersion >= SCHEMA_VERSION) {
    return { backedUp: false, migrated: false, userVersion };
  }

  const now = options.now ?? new Date();
  const backupsDir = options.backupsDir ?? backupsDirFrom(path.dirname(dbPath));
  fs.mkdirSync(backupsDir, { recursive: true });

  const backupPath = path.join(backupsDir, `pre-migrate-${userVersion}-${compactStamp(now)}.db`);
  const backupFn = options.backup ?? backupBeforeMigration;
  const producedPath = await backupFn(dbPath, { directory: backupsDir, timestamp: now });

  // Normalise whatever filename the backup routine chose into the required
  // `pre-migrate-<version>-<ts>.db` name (byte-for-byte the same snapshot).
  if (path.resolve(producedPath) !== path.resolve(backupPath)) {
    if (fs.existsSync(backupPath)) {
      fs.rmSync(backupPath, { force: true });
    }
    fs.renameSync(producedPath, backupPath);
  }

  const result = migrateLegacy(db, { schemaVersion: SCHEMA_VERSION });
  return {
    backedUp: true,
    backupPath,
    migrated: result.changed,
    userVersion: result.userVersion,
  };
}

// Re-export the runtime path helper so the server CLI can derive the default
// handshake path without a second import.
export { runtimePathFrom };
