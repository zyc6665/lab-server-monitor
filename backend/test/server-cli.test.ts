import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  parseServerArgv,
  resolveLegacyCandidates,
  resolveRuntimePaths,
} from '../src/runtime/first-run';

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'sm-cli-'));
}

describe('server CLI argument parsing', () => {
  it('parses every recognised flag in space form', () => {
    const parsed = parseServerArgv([
      'node',
      'dist/main.cjs',
      '--data-dir',
      'C:/ProgramData/ServerMonitor',
      '--config',
      'C:/ProgramData/ServerMonitor/config/config.yaml',
      '--runtime',
      'C:/ProgramData/ServerMonitor/runtime.json',
      '--import-legacy',
      '--port',
      '0',
    ]);
    expect(parsed.dataDir).toBe('C:/ProgramData/ServerMonitor');
    expect(parsed.config).toBe('C:/ProgramData/ServerMonitor/config/config.yaml');
    expect(parsed.runtime).toBe('C:/ProgramData/ServerMonitor/runtime.json');
    expect(parsed.importLegacy).toBe(true);
    expect(parsed.port).toBe(0);
  });

  it('parses equals form and ignores the node/script prefix', () => {
    const parsed = parseServerArgv(['node', 'main.cjs', '--data-dir=D:/sm', '--port=5433']);
    expect(parsed).toEqual({ dataDir: 'D:/sm', port: 5433, importLegacy: false });
  });

  it('rejects an invalid port', () => {
    expect(() => parseServerArgv(['--port', '-1'])).toThrow(/--port/);
    expect(() => parseServerArgv(['--port', '1.5'])).toThrow(/--port/);
  });

  it('leaves legacy health-only argv untouched (no bootstrap flags)', () => {
    const parsed = parseServerArgv(['node', 'main.cjs', '--port', '0', '--runtime', 'rt.json']);
    expect(parsed.dataDir).toBeUndefined();
    expect(parsed.importLegacy).toBe(false);
    expect(parsed.port).toBe(0);
  });

  it('resolveRuntimePaths maps --data-dir to <dataDir>/servermonitor.db', () => {
    const dataDir = path.resolve(tempDir());
    try {
      const resolved = resolveRuntimePaths(['--data-dir', dataDir], {});
      expect(resolved.dbPath).toBe(path.join(dataDir, 'servermonitor.db'));
      expect(resolved.importLegacy).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('resolveRuntimePaths keeps --port and --import-legacy', () => {
    const resolved = resolveRuntimePaths(['--data-dir', tempDir(), '--port', '8081', '--import-legacy'], {});
    expect(resolved.port).toBe(8081);
    expect(resolved.importLegacy).toBe(true);
  });

  it('resolveRuntimePaths defaults the data dir from the environment', () => {
    const localAppData = path.resolve(tempDir());
    try {
      const resolved = resolveRuntimePaths([], { LOCALAPPDATA: localAppData });
      expect(resolved.dataDir).toBe(path.join(localAppData, 'ServerMonitor'));
    } finally {
      rmSync(localAppData, { recursive: true, force: true });
    }
  });

  it('resolveLegacyCandidates returns a de-duplicated, ordered list', () => {
    const dataDir = path.resolve(tempDir());
    try {
      const candidates = resolveLegacyCandidates(dataDir, {}, path.resolve(tempDir()));
      expect(candidates).toHaveLength(2);
      expect(new Set(candidates).size).toBe(candidates.length);
      expect(candidates[0]).toBe(path.join(dataDir, '..', 'data', 'servermonitor.db'));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
