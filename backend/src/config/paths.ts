import * as path from 'node:path';

/**
 * Pure path resolution for the ServerMonitor data directory.
 *
 * The desktop design decouples the data directory from the install directory:
 * the data directory holds the database, config seed, logs, runtime file and
 * backups. Everything here is a pure function of its inputs so it can be unit
 * tested without electron or the real filesystem.
 *
 * Layout (see docs/superpowers/specs/2026-11-25-single-stack-desktop-rewrite-design.md §5.2):
 *   <dataDir>/servermonitor.db
 *   <dataDir>/config/config.yaml
 *   <dataDir>/config/.env
 *   <dataDir>/logs/
 *   <dataDir>/runtime.json
 *   <dataDir>/backups/
 */

export const DEFAULT_DB_FILE_NAME = 'servermonitor.db';

export interface PathOptions {
  /** Absolute data directory. Wins over {@link installDir} when provided. */
  dataDir?: string;
  /** Install directory; the data dir defaults to `<installDir>/data`. */
  installDir?: string;
  /** Override for the log directory (defaults to `<dataDir>/logs`). */
  logDir?: string;
  /** Override for the database file name (defaults to {@link DEFAULT_DB_FILE_NAME}). */
  dbFileName?: string;
}

export interface ResolvedPaths {
  dataDir: string;
  logDir: string;
  dbPath: string;
  configPath: string;
  dotenvPath: string;
  runtimePath: string;
  backupsDir: string;
}

export function dbPathFrom(dataDir: string, dbFileName: string = DEFAULT_DB_FILE_NAME): string {
  return path.join(dataDir, dbFileName);
}

export function logDirFrom(dataDir: string): string {
  return path.join(dataDir, 'logs');
}

export function configPathFrom(dataDir: string): string {
  return path.join(dataDir, 'config', 'config.yaml');
}

export function dotenvPathFrom(dataDir: string): string {
  return path.join(dataDir, 'config', '.env');
}

export function runtimePathFrom(dataDir: string): string {
  return path.join(dataDir, 'runtime.json');
}

export function backupsDirFrom(dataDir: string): string {
  return path.join(dataDir, 'backups');
}

export function resolvePaths(options: PathOptions): ResolvedPaths {
  const dataDir = options.dataDir ?? path.join(options.installDir ?? '.', 'data');
  const logDir = options.logDir ?? logDirFrom(dataDir);
  return {
    dataDir,
    logDir,
    dbPath: dbPathFrom(dataDir, options.dbFileName),
    configPath: configPathFrom(dataDir),
    dotenvPath: dotenvPathFrom(dataDir),
    runtimePath: runtimePathFrom(dataDir),
    backupsDir: backupsDirFrom(dataDir),
  };
}
