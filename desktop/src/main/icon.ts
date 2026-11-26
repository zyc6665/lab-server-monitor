/**
 * App icon resolution for the Electron main process.
 *
 * `resolveIconPath` is a pure function (the filesystem probe is injected) so it
 * can be unit tested without Electron; `loadAppIcon` requires `electron` lazily
 * for the same reason — importing this module must not need the electron module.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeImage } from 'electron';

export interface ResolveIconPathOptions {
  packaged: boolean;
  dirname: string;
  resourcesPath: string;
  exists?: (path: string) => boolean;
}

/**
 * Locate the app icon file.
 *
 * Packaged: `build/icon.ico` is shipped to `resources/icon.ico` by the
 * electron-builder `extraResources` entry. Development: the bundled entry lives
 * in `desktop/dist`, so the icon is at `dist/../build/icon.ico`.
 * Returns `null` when the file is missing (caller falls back gracefully).
 */
export function resolveIconPath(opts: ResolveIconPathOptions): string | null {
  const exists = opts.exists ?? existsSync;
  const candidate = opts.packaged
    ? join(opts.resourcesPath, 'icon.ico')
    : join(opts.dirname, '..', 'build', 'icon.ico');
  return exists(candidate) ? candidate : null;
}

export interface LoadAppIconOptions {
  packaged?: boolean;
  dirname?: string;
  resourcesPath?: string;
}

/**
 * Load the app icon as a `NativeImage`, or `null` when it is unavailable
 * (missing file / empty image) so callers can fall back to `createEmpty()`.
 */
export function loadAppIcon(opts?: LoadAppIconOptions): NativeImage | null {
  // Lazy require: keeps the pure helpers above importable under vitest.
  const electron = require('electron') as typeof import('electron');
  const resolved = resolveIconPath({
    packaged: opts?.packaged ?? electron.app.isPackaged,
    dirname: opts?.dirname ?? __dirname,
    resourcesPath: opts?.resourcesPath ?? process.resourcesPath,
  });
  if (!resolved) return null;
  const image = electron.nativeImage.createFromPath(resolved);
  return image.isEmpty() ? null : image;
}