import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

describe('renderer preload wiring', () => {
  it('main window loads the preload bundle with context isolation', () => {
    const main = read('src/main/main.ts');
    expect(main).toMatch(/preload:\s*path\.join\(__dirname,\s*'preload\.cjs'\)/);
    expect(main).toMatch(/contextIsolation:\s*true/);
  });

  it('build script bundles src/main/preload.ts to dist/preload.cjs', () => {
    const build = read('scripts/build-main.mjs');
    expect(build).toContain("entryPoints: ['src/main/preload.ts']");
    expect(build).toContain("outfile: 'dist/preload.cjs'");
  });

  it('preload exposes the desktopBridge updater API used by settings-update.js', () => {
    const preload = read('src/main/preload.ts');
    expect(preload).toContain("exposeInMainWorld('desktopBridge'");
    for (const key of ['checkForUpdate', 'downloadUpdate', 'installUpdate', 'onUpdateStatus']) {
      expect(preload).toContain(key);
    }
    for (const ch of ['update:check', 'update:download', 'update:install', 'update:status']) {
      expect(preload).toContain(ch);
    }
  });
});
