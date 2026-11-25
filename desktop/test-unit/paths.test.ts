import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  resolveInstallDir,
  resolveDataDir,
  logsDir,
  defaultDataDir,
  instanceJsonPath,
  isUsableDataDir,
  pickDataDir,
  readDataDirPointer,
  writeDataDirPointer,
  REGISTRY_KEY,
  REGISTRY_VALUE_NAME,
  type PickDataDirFs,
} from '../src/main/paths';

const LA = 'C:\\Users\\u\\AppData\\Local';

describe('paths (legacy exports)', () => {
  it('install -> D when D exists', () =>
    expect(resolveInstallDir({ existsDrive: d => d === 'D:', localAppData: LA })).toBe('D:\\Tools\\ServerMonitor'));
  it('install -> LOCALAPPDATA when no D', () =>
    expect(resolveInstallDir({ existsDrive: () => false, localAppData: LA })).toBe('C:\\Users\\u\\AppData\\Local\\Programs\\ServerMonitor'));
  it('data honors pointer', () =>
    expect(resolveDataDir({ installDir: 'D:\\Tools\\ServerMonitor', existsDrive: () => true, localAppData: LA, readDataDirPointer: () => 'E:\\MyData' })).toBe('E:\\MyData'));
  it('data -> D default', () =>
    expect(resolveDataDir({ installDir: 'D:\\Tools\\ServerMonitor', existsDrive: d => d === 'D:', localAppData: LA, readDataDirPointer: () => null })).toBe('D:\\ServerMonitorData'));
  it('data -> LOCALAPPDATA when no D', () =>
    expect(resolveDataDir({ installDir: 'D:\\Tools\\ServerMonitor', existsDrive: () => false, localAppData: LA, readDataDirPointer: () => null })).toBe('C:\\Users\\u\\AppData\\Local\\ServerMonitor'));
  it('logs under data', () =>
    expect(logsDir('D:\\ServerMonitorData')).toBe('D:\\ServerMonitorData\\logs'));
});

function fakeFs(opts: {
  dirs?: string[];
  writable?: string[];
  removable?: (p: string) => boolean;
  instanceJson?: (p: string) => string | null;
}): PickDataDirFs {
  const dirs = opts.dirs ?? [];
  const writable = opts.writable ?? [];
  return {
    isDirectory: (p: string) => dirs.includes(p),
    writable: (p: string) => writable.includes(p),
    isRemovable: opts.removable,
    readInstanceJson: opts.instanceJson,
  };
}

describe('defaultDataDir', () => {
  it('picks the first existing non-system fixed drive', () => {
    expect(defaultDataDir({ existsDrive: d => d === 'D:', env: { LOCALAPPDATA: LA } })).toBe('D:\\ServerMonitorData');
  });

  it('skips a missing D: and uses E:', () => {
    expect(defaultDataDir({ existsDrive: d => d === 'E:', env: { LOCALAPPDATA: LA } })).toBe('E:\\ServerMonitorData');
  });

  it('falls back to LOCALAPPDATA when no fixed drive exists', () => {
    expect(defaultDataDir({ existsDrive: () => false, env: { LOCALAPPDATA: LA } })).toBe(path.join(LA, 'ServerMonitor'));
  });

  it('never selects the C: system drive even when present', () => {
    expect(defaultDataDir({ existsDrive: () => true, env: { LOCALAPPDATA: LA }, drives: ['C:'] })).toBe(path.join(LA, 'ServerMonitor'));
    expect(defaultDataDir({ existsDrive: () => true, env: { LOCALAPPDATA: LA }, drives: ['C:', 'D:', 'E:'] })).toBe('D:\\ServerMonitorData');
  });

  it('honors the injected drive order', () => {
    expect(defaultDataDir({ existsDrive: d => d === 'D:' || d === 'F:', env: { LOCALAPPDATA: LA }, drives: ['F:', 'D:'] })).toBe('F:\\ServerMonitorData');
  });
});

describe('isUsableDataDir', () => {
  it('true for an existing writable directory', () => {
    expect(isUsableDataDir('D:\\Data', fakeFs({ dirs: ['D:\\Data'], writable: ['D:\\Data'] }))).toBe(true);
  });
  it('false when the directory does not exist', () => {
    expect(isUsableDataDir('D:\\Missing', fakeFs({ dirs: [], writable: ['D:\\Missing'] }))).toBe(false);
  });
  it('false when not writable', () => {
    expect(isUsableDataDir('D:\\ReadOnly', fakeFs({ dirs: ['D:\\ReadOnly'], writable: [] }))).toBe(false);
  });
  it('false for empty or non-string values', () => {
    const fs = fakeFs({ dirs: [''], writable: [''] });
    expect(isUsableDataDir('', fs)).toBe(false);
    expect(isUsableDataDir('   ', fs)).toBe(false);
  });
});

describe('instanceJsonPath', () => {
  it('joins instance.json under the install dir', () => {
    expect(instanceJsonPath('D:\\Tools\\ServerMonitor')).toBe('D:\\Tools\\ServerMonitor\\instance.json');
  });
});

describe('pickDataDir', () => {
  const defaultExists = (d: string) => d === 'D:';

  it('uses a usable, non-network pointer', () => {
    const res = pickDataDir({
      pointer: 'E:\\MyData',
      installDir: 'D:\\Tools\\ServerMonitor',
      env: { LOCALAPPDATA: LA },
      existsDrive: defaultExists,
      fsApi: fakeFs({ dirs: ['E:\\MyData'], writable: ['E:\\MyData'] }),
    });
    expect(res).toEqual({ dataDir: 'E:\\MyData', source: 'pointer' });
  });

  it('falls back to the default when the pointer is unusable, with a warning', () => {
    const res = pickDataDir({
      pointer: 'E:\\Gone',
      installDir: 'D:\\Tools\\ServerMonitor',
      env: { LOCALAPPDATA: LA },
      existsDrive: defaultExists,
      fsApi: fakeFs({ dirs: [], writable: [] }),
    });
    expect(res.source).toBe('fallback');
    expect(res.dataDir).toBe('D:\\ServerMonitorData');
    expect(res.warning).toBeTruthy();
    expect(res.warning).toContain('E:\\Gone');
  });

  it('uses the default when there is no pointer', () => {
    const res = pickDataDir({
      pointer: null,
      installDir: 'D:\\Tools\\ServerMonitor',
      env: { LOCALAPPDATA: LA },
      existsDrive: defaultExists,
      fsApi: fakeFs({}),
    });
    expect(res).toEqual({ dataDir: 'D:\\ServerMonitorData', source: 'default' });
  });

  it('allows a network (UNC) pointer but warns', () => {
    const res = pickDataDir({
      pointer: '\\\\server\\share\\data',
      installDir: 'D:\\Tools\\ServerMonitor',
      env: { LOCALAPPDATA: LA },
      existsDrive: defaultExists,
      fsApi: fakeFs({ dirs: ['\\\\server\\share\\data'], writable: ['\\\\server\\share\\data'] }),
    });
    expect(res.source).toBe('pointer');
    expect(res.dataDir).toBe('\\\\server\\share\\data');
    expect(res.warning).toMatch(/网络盘/);
  });

  it('allows a removable-drive pointer but warns', () => {
    const res = pickDataDir({
      pointer: 'E:\\USBData',
      installDir: 'D:\\Tools\\ServerMonitor',
      env: { LOCALAPPDATA: LA },
      existsDrive: defaultExists,
      fsApi: fakeFs({ dirs: ['E:\\USBData'], writable: ['E:\\USBData'], removable: () => true }),
    });
    expect(res.source).toBe('pointer');
    expect(res.warning).toMatch(/可移动盘/);
  });

  it('reads a fallback pointer from instance.json when the registry pointer is empty', () => {
    const installDir = 'D:\\Tools\\ServerMonitor';
    const res = pickDataDir({
      pointer: null,
      installDir,
      env: { LOCALAPPDATA: LA },
      existsDrive: defaultExists,
      fsApi: fakeFs({
        dirs: ['F:\\AltData'],
        writable: ['F:\\AltData'],
        instanceJson: p => (p === instanceJsonPath(installDir) ? 'F:\\AltData' : null),
      }),
    });
    expect(res).toEqual({ dataDir: 'F:\\AltData', source: 'pointer' });
  });

  it('falls back to default when the instance.json pointer is unusable', () => {
    const installDir = 'D:\\Tools\\ServerMonitor';
    const res = pickDataDir({
      pointer: null,
      installDir,
      env: { LOCALAPPDATA: LA },
      existsDrive: () => false,
      fsApi: fakeFs({ instanceJson: () => 'F:\\Missing' }),
    });
    expect(res.source).toBe('fallback');
    expect(res.dataDir).toBe(path.join(LA, 'ServerMonitor'));
    expect(res.warning).toBeTruthy();
  });
});

describe('readDataDirPointer / writeDataDirPointer', () => {
  it('parses a REG_SZ value from reg query output', () => {
    const calls: string[][] = [];
    const value = readDataDirPointer({
      runReg: args => {
        calls.push(args);
        return {
          status: 0,
          stdout: '\r\nHKEY_CURRENT_USER\\Software\\ServerMonitor\r\n    DataDir    REG_SZ    E:\\MyData\r\n\r\n',
        };
      },
    });
    expect(value).toBe('E:\\MyData');
    expect(calls[0]).toEqual(['query', REGISTRY_KEY, '/v', REGISTRY_VALUE_NAME]);
  });

  it('returns null when the key is missing (non-zero exit)', () => {
    expect(readDataDirPointer({ runReg: () => ({ status: 1, stdout: '' }) })).toBeNull();
  });

  it('returns null when the value is empty', () => {
    expect(
      readDataDirPointer({ runReg: () => ({ status: 0, stdout: '    DataDir    REG_SZ    \r\n' }) }),
    ).toBeNull();
  });

  it('writes the pointer via reg add with /f', () => {
    const calls: string[][] = [];
    writeDataDirPointer('E:\\MyData', {
      runReg: args => {
        calls.push(args);
        return { status: 0, stdout: '' };
      },
    });
    expect(calls[0]).toEqual([
      'add',
      REGISTRY_KEY,
      '/v',
      REGISTRY_VALUE_NAME,
      '/t',
      'REG_SZ',
      '/d',
      'E:\\MyData',
      '/f',
    ]);
  });

  it('throws when reg add fails', () => {
    expect(() => writeDataDirPointer('E:\\MyData', { runReg: () => ({ status: 1, stdout: '' }) })).toThrow();
  });

  it('rejects an empty pointer on write', () => {
    expect(() => writeDataDirPointer('   ', { runReg: () => ({ status: 0, stdout: '' }) })).toThrow(TypeError);
  });
});
