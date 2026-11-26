import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveIconPath } from '../src/main/icon';

const exists = (paths: string[]) => (p: string) => paths.includes(p);

describe('resolveIconPath', () => {
  it('uses resourcesPath/icon.ico when packaged', () => {
    const packagedIcon = path.join('C:/app/resources', 'icon.ico');
    const p = resolveIconPath({
      packaged: true,
      dirname: 'C:/app/dist',
      resourcesPath: 'C:/app/resources',
      exists: exists([packagedIcon]),
    });
    expect(p).toBe(packagedIcon);
  });

  it('uses build/icon.ico in development', () => {
    const devIcon = path.join('D:/repo/desktop/build', 'icon.ico');
    const p = resolveIconPath({
      packaged: false,
      dirname: 'D:/repo/desktop/dist',
      resourcesPath: 'D:/repo/desktop/node_modules/electron/dist/resources',
      exists: exists([devIcon]),
    });
    expect(p).toBe(devIcon);
  });

  it('returns null when the icon is missing', () => {
    expect(
      resolveIconPath({ packaged: true, dirname: '/a', resourcesPath: '/a/r', exists: () => false }),
    ).toBeNull();
  });
});