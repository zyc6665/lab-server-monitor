import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

describe('quit wiring', () => {
  it('window close is allowed while quitting so 退出 cannot be swallowed', () => {
    const main = read('src/main/main.ts');
    // The close handler must early-return instead of preventDefault when the
    // app is quitting; otherwise Electron's quit sequence stalls in the tray.
    const close = main.slice(main.indexOf("w.on('close'"), main.indexOf("w.on('close'") + 400);
    expect(close).toMatch(/if \(quitting\)/);
    expect(close).toMatch(/e\.preventDefault\(\)/);
  });

  it('quit has a hard exit fallback so it never hangs', () => {
    const main = read('src/main/main.ts');
    expect(main).toContain('app.exit(0)');
  });

  it('installer force-closes a running app instead of only prompting', () => {
    const nsh = read('build/installer.nsh');
    expect(nsh).toContain('taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}"');
    expect(nsh).toContain('taskkill.exe" /IM "servermonitor.exe"');
  });
});
