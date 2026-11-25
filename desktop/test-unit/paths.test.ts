import { describe, it, expect } from 'vitest';
import { resolveInstallDir, resolveDataDir, logsDir } from '../src/main/paths';

const LA = 'C:/Users/u/AppData/Local';

describe('paths', () => {
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
