import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CONFIG_SEED_MARKER,
  LEGACY_IMPORT_MARKER,
  extractConfigSections,
  firstRunImport,
  migrateWithBackup,
  parseDotEnv,
  parseServerArgv,
  resolveLegacyCandidates,
  resolveRuntimePaths,
} from '../../src/runtime/first-run';
import { openDatabase } from '../../src/storage/db';
import { initSchema } from '../../src/storage/schema';
import { loadAppSettings } from '../../src/storage/settings';

type SqliteDb = ReturnType<typeof openDatabase>;

let dbs: SqliteDb[] = [];
let dirs: string[] = [];

function track<T extends SqliteDb>(db: T): T {
  dbs.push(db);
  return db;
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sm-firstrun-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const db of dbs) {
    if (db.open) {
      db.close();
    }
  }
  dbs = [];
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

/** Create a standalone SQLite file with one content table (a "legacy" DB). */
function makeLegacyDb(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const db = openDatabase(filePath);
  try {
    db.exec('CREATE TABLE legacy_probe (id INTEGER PRIMARY KEY, label TEXT)');
    db.prepare('INSERT INTO legacy_probe (label) VALUES (?)').run('copied-row');
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// parseServerArgv
// ---------------------------------------------------------------------------

describe('parseServerArgv', () => {
  it('parses the space-separated flag form and the boolean switch', () => {
    const parsed = parseServerArgv([
      'node',
      'main.cjs',
      '--data-dir',
      'D:/sm-data',
      '--config',
      'D:/sm-data/config/config.yaml',
      '--runtime',
      'D:/sm-data/runtime.json',
      '--import-legacy',
      '--port',
      '8123',
    ]);
    expect(parsed).toEqual({
      dataDir: 'D:/sm-data',
      config: 'D:/sm-data/config/config.yaml',
      runtime: 'D:/sm-data/runtime.json',
      importLegacy: true,
      port: 8123,
    });
  });

  it('parses the --flag=value form and defaults importLegacy to false', () => {
    const parsed = parseServerArgv(['--data-dir=D:/x', '--port=0']);
    expect(parsed.dataDir).toBe('D:/x');
    expect(parsed.port).toBe(0);
    expect(parsed.importLegacy).toBe(false);
  });

  it('ignores unrelated tokens (node binary / script path)', () => {
    const parsed = parseServerArgv(['C:/node.exe', 'C:/main.cjs']);
    expect(parsed).toEqual({ importLegacy: false });
  });

  it('rejects an out-of-range or non-integer --port', () => {
    expect(() => parseServerArgv(['--port', 'abc'])).toThrow(/--port/);
    expect(() => parseServerArgv(['--port', '70000'])).toThrow(/--port/);
  });
});

// ---------------------------------------------------------------------------
// resolveRuntimePaths
// ---------------------------------------------------------------------------

describe('resolveRuntimePaths', () => {
  it('derives dbPath from an explicit --data-dir and keeps --port', () => {
    const dataDir = path.resolve(tempDir(), 'data');
    const resolved = resolveRuntimePaths(['--data-dir', dataDir, '--port', '9000'], {});
    expect(resolved.dataDir).toBe(dataDir);
    expect(resolved.dbPath).toBe(path.join(dataDir, 'servermonitor.db'));
    expect(resolved.importLegacy).toBe(false);
    expect(resolved.port).toBe(9000);
    expect(resolved.configSeedPath).toBeUndefined();
    expect(resolved.runtimePath).toBeUndefined();
  });

  it('expands an explicit --config / --runtime', () => {
    const dir = tempDir();
    const resolved = resolveRuntimePaths(
      ['--data-dir', dir, '--config', 'seed.yaml', '--runtime', 'rt.json'],
      {},
    );
    expect(resolved.configSeedPath).toBe(path.resolve('seed.yaml'));
    expect(resolved.runtimePath).toBe(path.resolve('rt.json'));
  });

  it('falls back to %LOCALAPPDATA%\\ServerMonitor when no --data-dir is given', () => {
    const localAppData = path.resolve(tempDir(), 'LocalAppData');
    const resolved = resolveRuntimePaths([], { LOCALAPPDATA: localAppData });
    expect(resolved.dataDir).toBe(path.join(localAppData, 'ServerMonitor'));
    expect(resolved.dbPath).toBe(path.join(localAppData, 'ServerMonitor', 'servermonitor.db'));
  });

  it('prefers SERVERMONITOR_DATA_DIR over LOCALAPPDATA', () => {
    const envDataDir = path.resolve(tempDir(), 'env-data');
    const resolved = resolveRuntimePaths([], {
      SERVERMONITOR_DATA_DIR: envDataDir,
      LOCALAPPDATA: path.resolve(tempDir(), 'LocalAppData'),
    });
    expect(resolved.dataDir).toBe(envDataDir);
  });

  it('treats --import-legacy as a bootstrap flag', () => {
    const resolved = resolveRuntimePaths(['--import-legacy'], { LOCALAPPDATA: tempDir() });
    expect(resolved.importLegacy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveLegacyCandidates
// ---------------------------------------------------------------------------

describe('resolveLegacyCandidates', () => {
  it('orders explicit > sibling data dir > cwd and de-duplicates', () => {
    const dataDir = path.resolve(tempDir(), 'data');
    const explicit = path.join(dataDir, '..', 'data', 'servermonitor.db');
    const candidates = resolveLegacyCandidates(
      dataDir,
      { SERVERMONITOR_LEGACY_DB: explicit },
      path.resolve(tempDir(), 'cwd'),
    );
    expect(candidates[0]).toBe(path.resolve(explicit));
    // The explicit path equals the sibling default, so it must appear once.
    expect(candidates.filter((p) => p === path.resolve(explicit))).toHaveLength(1);
    expect(candidates.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// extractConfigSections / parseDotEnv
// ---------------------------------------------------------------------------

describe('extractConfigSections', () => {
  it('projects present YAML sections and skips absent ones', () => {
    const sections = extractConfigSections({
      monitoring: { poll_interval_seconds: 120 },
      ssh: { connect_timeout: 33 },
      alerts: { thresholds: { cpu_percent: 80 }, enabled: false },
      report: { weekly: { enabled: false } },
    });
    const byName = Object.fromEntries(sections.map((s) => [s.section, s.payload]));
    expect(Object.keys(byName).sort()).toEqual(['alerts', 'monitoring', 'report', 'ssh']);
    expect(byName.ssh).toEqual({ connect_timeout: 33 });
    expect(byName.monitoring.poll_interval_seconds).toBe(120);
    expect(byName.alerts.enabled).toBe(false);
    expect(byName.alerts.thresholds).toEqual({ cpu_percent: 80 });
    expect(byName.report.weekly).toEqual({ enabled: false });
    expect(byName.smtp).toBeUndefined();
  });

  it('returns nothing for a non-mapping document', () => {
    expect(extractConfigSections(null)).toEqual([]);
    expect(extractConfigSections('nope')).toEqual([]);
  });
});

describe('parseDotEnv', () => {
  it('parses key/value pairs with quotes, export and comments', () => {
    const parsed = parseDotEnv(
      ['# comment', 'SMTP_PASSWORD="s3cr3t"', "export HOST='10.0.0.1'", '', 'PORT=587'].join(
        '\n',
      ),
    );
    expect(parsed).toEqual({ SMTP_PASSWORD: 's3cr3t', HOST: '10.0.0.1', PORT: '587' });
  });
});

// ---------------------------------------------------------------------------
// firstRunImport
// ---------------------------------------------------------------------------

describe('firstRunImport', () => {
  it('starts fresh (no copy, no config) when no legacy database exists', async () => {
    const dataDir = tempDir();
    const dbPath = path.join(dataDir, 'servermonitor.db');
    const result = await firstRunImport({ dataDir, dbPath, legacyDbCandidates: [] });
    expect(result.imported).toBe(false);
    expect(result.legacyCopied).toBe(false);
    expect(result.configImported).toBe(false);
    expect(result.messages.join(' ')).toMatch(/no legacy database/i);
  });

  it('atomically copies a legacy database and records the legacy marker', async () => {
    const root = tempDir();
    const legacyPath = path.join(root, 'legacy', 'servermonitor.db');
    makeLegacyDb(legacyPath);
    const dataDir = path.join(root, 'data');
    const dbPath = path.join(dataDir, 'servermonitor.db');

    const result = await firstRunImport({
      dataDir,
      dbPath,
      legacyDbCandidates: [legacyPath],
    });
    expect(result.legacyCopied).toBe(true);
    expect(result.imported).toBe(true);
    expect(result.messages.join(' ')).toMatch(/copied legacy database/i);
    expect(existsSync(dbPath)).toBe(true);

    // No temp artefacts left behind after the rename.
    const leftovers = readdirSync(dataDir).filter((name) => name.includes('.tmp'));
    expect(leftovers).toEqual([]);

    const db = track(openDatabase(dbPath));
    const copied = db.prepare('SELECT label FROM legacy_probe').all() as Array<{ label: string }>;
    expect(copied).toEqual([{ label: 'copied-row' }]);
    expect(loadAppSettings(db)[LEGACY_IMPORT_MARKER]).toBeDefined();
  });

  it('does not overwrite an existing non-empty database', async () => {
    const root = tempDir();
    const dataDir = path.join(root, 'data');
    const dbPath = path.join(dataDir, 'servermonitor.db');
    mkdirSync(dataDir, { recursive: true });
    makeLegacyDb(dbPath); // existing target
    const candidate = path.join(root, 'other', 'servermonitor.db');
    makeLegacyDb(candidate);

    const result = await firstRunImport({ dataDir, dbPath, legacyDbCandidates: [candidate] });
    expect(result.legacyCopied).toBe(false);
    expect(result.imported).toBe(false);
    expect(result.messages.join(' ')).toMatch(/existing database found/i);
  });

  it('imports a config seed once and skips it on the second run', async () => {
    const root = tempDir();
    const dataDir = path.join(root, 'data');
    const dbPath = path.join(dataDir, 'servermonitor.db');
    mkdirSync(dataDir, { recursive: true });
    const seedPath = path.join(root, 'config.yaml');
    writeFileSync(
      seedPath,
      ['ssh:', '  connect_timeout: 33', 'monitoring:', '  poll_interval_seconds: 120'].join('\n'),
      'utf8',
    );

    const first = await firstRunImport({ dataDir, dbPath, configSeedPath: seedPath, env: {} });
    expect(first.configImported).toBe(true);
    expect(first.imported).toBe(true);

    const db = track(openDatabase(dbPath));
    const settings = loadAppSettings(db);
    expect((settings.ssh as Record<string, unknown>).connect_timeout).toBe(33);
    expect((settings.monitoring as Record<string, unknown>).poll_interval_seconds).toBe(120);
    expect(settings[CONFIG_SEED_MARKER]).toBeDefined();

    const second = await firstRunImport({ dataDir, dbPath, configSeedPath: seedPath, env: {} });
    expect(second.configImported).toBe(false);
    expect(second.messages.join(' ')).toMatch(/already imported/i);
  });

  it('loads a sibling .env into the provided environment', async () => {
    const root = tempDir();
    const dataDir = path.join(root, 'data');
    const dbPath = path.join(dataDir, 'servermonitor.db');
    const seedDir = path.join(dataDir, 'config');
    mkdirSync(seedDir, { recursive: true });
    const seedPath = path.join(seedDir, 'config.yaml');
    writeFileSync(seedPath, 'ssh:\n  command_timeout: 44\n', 'utf8');
    writeFileSync(path.join(seedDir, '.env'), 'SMTP_PASSWORD=from-dotenv\n', 'utf8');

    const env: NodeJS.ProcessEnv = {};
    const result = await firstRunImport({ dataDir, dbPath, configSeedPath: seedPath, env });
    expect(result.configImported).toBe(true);
    expect(env.SMTP_PASSWORD).toBe('from-dotenv');
    expect(result.messages.join(' ')).toMatch(/\.env/);
  });
});

// ---------------------------------------------------------------------------
// migrateWithBackup
// ---------------------------------------------------------------------------

describe('migrateWithBackup', () => {
  it('does nothing for a brand-new empty database', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'servermonitor.db');
    const db = track(openDatabase(dbPath));
    const result = await migrateWithBackup(dbPath, db);
    expect(result.backedUp).toBe(false);
    expect(result.migrated).toBe(false);
    expect(result.userVersion).toBe(0);
  });

  it('skips an already-current database', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'servermonitor.db');
    const db = track(openDatabase(dbPath));
    initSchema(db);
    const result = await migrateWithBackup(dbPath, db);
    expect(result.backedUp).toBe(false);
    expect(result.userVersion).toBe(1);
  });

  it('backs up a legacy database before migrating it', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'servermonitor.db');
    const db = track(openDatabase(dbPath));
    db.exec('CREATE TABLE legacy_probe (id INTEGER PRIMARY KEY, label TEXT)');
    expect(db.pragma('user_version', { simple: true })).toBe(0);

    const now = new Date('2026-01-02T03:04:05.678Z');
    const result = await migrateWithBackup(dbPath, db, { now });

    expect(result.backedUp).toBe(true);
    expect(result.userVersion).toBe(1);
    expect(result.backupPath).toBeDefined();
    expect(path.basename(result.backupPath as string)).toBe('pre-migrate-0-20260102T030405678Z.db');
    expect(existsSync(result.backupPath as string)).toBe(true);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
  });

  it('aborts (does not migrate) when the pre-migration backup fails', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'servermonitor.db');
    const db = track(openDatabase(dbPath));
    db.exec('CREATE TABLE legacy_probe (id INTEGER PRIMARY KEY)');

    await expect(
      migrateWithBackup(dbPath, db, {
        backup: async () => {
          throw new Error('backup disk full');
        },
      }),
    ).rejects.toThrow(/backup disk full/);

    // Migration never ran: the schema version is untouched.
    expect(db.pragma('user_version', { simple: true })).toBe(0);
  });
});
