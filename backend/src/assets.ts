/**
 * Locates runtime assets (web templates, static files, report templates)
 * shipped under `backend/assets/`.
 *
 * - Source / tests: `backend/src/<x>/*.ts` -> `backend/assets`.
 * - Bundled: `dist/main.cjs` (or packaged `resources/backend/main.cjs`)
 *   -> sibling `assets/` (`resources/backend/assets`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export function assetsRoot(): string {
  const override = process.env.SERVERMONITOR_ASSETS_DIR;
  if (override && override.trim() !== '') {
    return path.resolve(override);
  }
  const base = typeof __dirname === 'string' ? __dirname : process.cwd();
  const candidates = [
    path.join(base, 'assets'),
    path.resolve(base, '../assets'),
    path.resolve(base, '../../assets'),
  ];
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (typeof resourcesPath === 'string') {
    candidates.push(path.join(resourcesPath, 'backend', 'assets'));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'web', 'templates'))) {
      return candidate;
    }
  }
  return path.resolve(base, '../../assets');
}

export function assetPath(...segments: string[]): string {
  return path.join(assetsRoot(), ...segments);
}
