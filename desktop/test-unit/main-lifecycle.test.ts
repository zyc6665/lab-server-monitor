import { describe, it, expect } from 'vitest';
import {
  buildBackendArgs,
  parseDataDirArg,
  startHidden,
  parseLoginItemArgs,
  buildLoginItemArgs,
  shouldShowWindow,
  legacyDbCandidates,
  detectLegacyImport,
  shutdownPlan,
  DEFAULT_DB_FILE_NAME,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  type ShutdownDeps,
} from '../src/main/lifecycle';

const DATA = 'D:\\ServerMonitorData';
const RUNTIME = 'D:\\ServerMonitorData\\runtime.json';

describe('buildBackendArgs', () => {
  it('builds the canonical argv without --import-legacy', () => {
    expect(buildBackendArgs({ dataDir: DATA, runtimePath: RUNTIME })).toEqual([
      '--data-dir',
      DATA,
      '--port',
      '0',
      '--runtime',
      RUNTIME,
    ]);
  });

  it('appends --import-legacy when requested', () => {
    expect(
      buildBackendArgs({ dataDir: DATA, runtimePath: RUNTIME, importLegacy: true }),
    ).toEqual(['--data-dir', DATA, '--port', '0', '--runtime', RUNTIME, '--import-legacy']);
  });

  it('omits --import-legacy when explicitly false', () => {
    const args = buildBackendArgs({ dataDir: DATA, runtimePath: RUNTIME, importLegacy: false });
    expect(args).not.toContain('--import-legacy');
    expect(args).toHaveLength(6);
  });
});

describe('parseDataDirArg', () => {
  it('parses the separated form --data-dir X', () => {
    expect(parseDataDirArg(['electron', '.', '--data-dir', 'E:\\Custom'])).toBe('E:\\Custom');
  });

  it('parses the inline form --data-dir=X', () => {
    expect(parseDataDirArg(['electron', '.', '--data-dir=E:\\Inline'])).toBe('E:\\Inline');
  });

  it('returns null when the flag is missing', () => {
    expect(parseDataDirArg(['electron', '.', '--port', '0'])).toBeNull();
  });

  it('returns null when the separated form has no value', () => {
    expect(parseDataDirArg(['--data-dir'])).toBeNull();
    expect(parseDataDirArg(['--data-dir', '--start-hidden'])).toBeNull();
  });

  it('does not confuse --data-dir with a longer flag name', () => {
    expect(parseDataDirArg(['--data-directory=E:\\Bogus'])).toBeNull();
  });
});

describe('startHidden / shouldShowWindow', () => {
  it('detects --start-hidden', () => {
    expect(startHidden(['electron', '.', '--start-hidden'])).toBe(true);
    expect(startHidden(['electron', '.'])).toBe(false);
  });

  it('hides the window only when startHidden', () => {
    expect(shouldShowWindow({ startHidden: true })).toBe(false);
    expect(shouldShowWindow({ startHidden: false })).toBe(true);
  });
});

describe('parseLoginItemArgs / buildLoginItemArgs', () => {
  it('registers exactly --start-hidden for autostart', () => {
    expect(buildLoginItemArgs()).toEqual(['--start-hidden']);
  });

  it('parses login-item args and detects hidden start', () => {
    const parsed = parseLoginItemArgs(['--start-hidden', '--foo']);
    expect(parsed.startHidden).toBe(true);
    expect(parsed.args).toEqual(['--start-hidden', '--foo']);
  });

  it('reports startHidden=false when the flag is absent', () => {
    expect(parseLoginItemArgs(['--verbose']).startHidden).toBe(false);
  });
});

describe('legacyDbCandidates', () => {
  it('orders explicit env then dataDir/../data then cwd/data', () => {
    const candidates = legacyDbCandidates({
      dataDir: 'D:\\ServerMonitorData',
      env: { SERVERMONITOR_LEGACY_DB: 'X:\\legacy.db' },
      cwd: 'C:\\app',
    });
    expect(candidates[0]).toBe('X:\\legacy.db');
    expect(candidates).toContain('D:\\data\\servermonitor.db');
    expect(candidates).toContain('C:\\app\\data\\servermonitor.db');
  });

  it('deduplicates identical candidates', () => {
    const candidates = legacyDbCandidates({
      dataDir: 'D:\\ServerMonitorData',
      env: {},
      cwd: 'D:\\ServerMonitorData\\..\\data\\..\\..', // resolves to D:\ -> D:\data\servermonitor.db
    });
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});

describe('detectLegacyImport', () => {
  const legacy = ['D:\\data\\servermonitor.db'];

  it('true when first run (no new db) and a legacy candidate exists', () => {
    expect(
      detectLegacyImport({
        dataDir: DATA,
        legacyCandidates: legacy,
        exists: (p) => p === legacy[0],
      }),
    ).toBe(true);
  });

  it('false when the new database already exists', () => {
    expect(
      detectLegacyImport({
        dataDir: DATA,
        legacyCandidates: legacy,
        exists: () => true,
      }),
    ).toBe(false);
  });

  it('false when no legacy candidate exists', () => {
    expect(
      detectLegacyImport({
        dataDir: DATA,
        legacyCandidates: legacy,
        exists: () => false,
      }),
    ).toBe(false);
  });

  it('uses the configured db file name', () => {
    const dbPath = `${DATA}\\custom.db`;
    expect(
      detectLegacyImport({
        dataDir: DATA,
        legacyCandidates: legacy,
        exists: (p) => p === dbPath,
        dbFileName: 'custom.db',
      }),
    ).toBe(false);
  });

  it('exposes the shared default db file name', () => {
    expect(DEFAULT_DB_FILE_NAME).toBe('servermonitor.db');
  });
});

describe('shutdownPlan', () => {
  function recorder(exitAwaited: boolean | Promise<boolean>) {
    const calls: string[] = [];
    const deps: ShutdownDeps = {
      kill: () => calls.push('kill'),
      waitExit: async (timeoutMs: number) => {
        calls.push(`waitExit:${timeoutMs}`);
        return typeof exitAwaited === 'boolean' ? exitAwaited : await exitAwaited;
      },
      forceKill: () => calls.push('forceKill'),
      timeoutMs: 7000,
    };
    return { calls, deps };
  }

  it('runs kill -> waitExit and returns graceful when the process exits in time', async () => {
    const { calls, deps } = recorder(true);
    const plan = shutdownPlan(deps);
    await expect(plan.run()).resolves.toBe('graceful');
    expect(calls).toEqual(['kill', 'waitExit:7000']);
    expect(calls).not.toContain('forceKill');
  });

  it('force-kills after the wait times out', async () => {
    const { calls, deps } = recorder(false);
    const plan = shutdownPlan(deps);
    await expect(plan.run()).resolves.toBe('forced');
    expect(calls).toEqual(['kill', 'waitExit:7000', 'forceKill']);
  });

  it('honours a custom timeout', async () => {
    const { calls, deps } = recorder(true);
    deps.timeoutMs = 1500;
    const plan = shutdownPlan(deps);
    await plan.run();
    expect(calls).toEqual(['kill', 'waitExit:1500']);
  });

  it('declares the ladder order and defaults the timeout to 7000ms', () => {
    const { deps } = recorder(true);
    const plan = shutdownPlan(deps);
    expect(plan.steps).toEqual(['kill', 'waitExit', 'forceKill']);
    expect(plan.timeoutMs).toBe(7000);
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(7000);
  });

  it('still force-kills when waitExit rejects', async () => {
    const calls: string[] = [];
    const plan = shutdownPlan({
      kill: () => calls.push('kill'),
      waitExit: async () => {
        calls.push('waitExit');
        throw new Error('boom');
      },
      forceKill: () => calls.push('forceKill'),
    });
    await expect(plan.run()).resolves.toBe('forced');
    expect(calls).toEqual(['kill', 'waitExit', 'forceKill']);
  });
});
