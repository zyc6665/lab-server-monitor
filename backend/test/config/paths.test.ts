import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

import {
  resolvePaths,
  dbPathFrom,
  logDirFrom,
  configPathFrom,
  dotenvPathFrom,
  runtimePathFrom,
  backupsDirFrom,
} from '../../src/config/paths';

describe('config paths', () => {
  it('derives db/log/config/runtime/backup paths from a data dir', () => {
    const dataDir = path.join(path.sep + 'srv', 'smdata');
    const p = resolvePaths({ dataDir });

    expect(p.dataDir).toBe(dataDir);
    expect(p.logDir).toBe(path.join(dataDir, 'logs'));
    expect(p.dbPath).toBe(path.join(dataDir, 'servermonitor.db'));
    expect(p.configPath).toBe(path.join(dataDir, 'config', 'config.yaml'));
    expect(p.dotenvPath).toBe(path.join(dataDir, 'config', '.env'));
    expect(p.runtimePath).toBe(path.join(dataDir, 'runtime.json'));
    expect(p.backupsDir).toBe(path.join(dataDir, 'backups'));
  });

  it('defaults the data dir to <installDir>/data and the log dir under it', () => {
    const installDir = path.join(path.sep + 'opt', 'ServerMonitor');
    const p = resolvePaths({ installDir });

    expect(p.dataDir).toBe(path.join(installDir, 'data'));
    expect(p.logDir).toBe(path.join(p.dataDir, 'logs'));
    expect(p.dbPath).toBe(path.join(p.dataDir, 'servermonitor.db'));
  });

  it('honours explicit logDir and dbFileName overrides', () => {
    const p = resolvePaths({
      dataDir: 'D:/sm',
      logDir: 'D:/other-logs',
      dbFileName: 'custom.db',
    });

    expect(p.logDir).toBe('D:/other-logs');
    expect(p.dbPath).toBe(path.join('D:/sm', 'custom.db'));
  });

  it('individual helpers compose the same paths', () => {
    expect(dbPathFrom('D:/sm')).toBe(path.join('D:/sm', 'servermonitor.db'));
    expect(dbPathFrom('D:/sm', 'x.db')).toBe(path.join('D:/sm', 'x.db'));
    expect(logDirFrom('D:/sm')).toBe(path.join('D:/sm', 'logs'));
    expect(configPathFrom('D:/sm')).toBe(path.join('D:/sm', 'config', 'config.yaml'));
    expect(dotenvPathFrom('D:/sm')).toBe(path.join('D:/sm', 'config', '.env'));
    expect(runtimePathFrom('D:/sm')).toBe(path.join('D:/sm', 'runtime.json'));
    expect(backupsDirFrom('D:/sm')).toBe(path.join('D:/sm', 'backups'));
  });
});
