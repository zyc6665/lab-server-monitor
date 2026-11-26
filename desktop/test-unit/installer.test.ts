import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createTrayGuard, applyLoginItem } from '../src/main/lifecycle';

const root = path.resolve(__dirname, '..');
const nsh = readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8');
const yml = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');

describe('createTrayGuard (single tray)', () => {
  it('constructs the tray once across repeated window-all-closed', () => {
    const factory = vi.fn(() => ({ id: 1 }));
    const g = createTrayGuard(factory);
    expect(g.get()).toBeNull();
    const a = g.ensure();
    for (let i = 0; i < 5; i++) g.ensure();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(g.get()).toBe(a);
  });
});

describe('applyLoginItem', () => {
  it('registers --start-hidden when enabling and disabling', () => {
    const app = { setLoginItemSettings: vi.fn() };
    applyLoginItem(app, true);
    applyLoginItem(app, false);
    expect(app.setLoginItemSettings).toHaveBeenNthCalledWith(1, { openAtLogin: true, args: ['--start-hidden'] });
    expect(app.setLoginItemSettings).toHaveBeenNthCalledWith(2, { openAtLogin: false, args: ['--start-hidden'] });
  });
});

describe('installer.nsh', () => {
  it('is wired via nsis.include and keeps extraResources', () => {
    expect(yml).toMatch(/nsis:[\s\S]*include: build\/installer\.nsh/);
    expect(yml).toMatch(/extraResources:/);
  });
  it('asks before deleting data, default No, silent keeps', () => {
    expect(nsh).toMatch(/MB_YESNO\|MB_DEFBUTTON2/);
    expect(nsh).toMatch(/IfSilent sm_keep_data/);
    expect(nsh).toMatch(/RMDir \/r "\$R2"/);
    expect(nsh).toMatch(/\$\{ifNot\} \$\{isUpdated\}/);
  });
  it('cleans empty dirs, removes pointer and autostart', () => {
    expect(nsh).toMatch(/RMDir "\$INSTDIR"/);
    expect(nsh).toMatch(/DeleteRegValue HKCU "\$\{SM_REG_KEY\}" "DataDir"/);
    expect(nsh).toMatch(/CurrentVersion\\Run/);
  });
  it('detects running app and defaults install dir with fallback', () => {
    expect(nsh).toMatch(/!macro customCheckAppRunning/);
    expect(nsh).toMatch(/D:\\Tools\\ServerMonitor/);
    expect(nsh).toMatch(/\$LOCALAPPDATA\\Programs\\ServerMonitor/);
  });
});
