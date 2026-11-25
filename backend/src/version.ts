import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface PackageJson {
  version: string;
}

/**
 * Build-time injected version literal.
 *
 * `backend/build.mjs` passes `define: { __APP_VERSION__: JSON.stringify(version) }`
 * to esbuild, so in the packaged single-file bundle this identifier is replaced
 * with a string literal and the code below never touches the filesystem. This is
 * essential: the installed layout is `<install>/resources/backend/main.cjs`,
 * which has no `package.json` beside it — reading one at startup used to crash
 * with ENOENT before the server could bind a port.
 *
 * Under vitest / ts-node the global is not defined, so `typeof` yields
 * 'undefined' and we fall back to reading `backend/package.json` from disk.
 */
declare const __APP_VERSION__: string | undefined;

function readPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
  ) as PackageJson;
  return packageJson.version;
}

export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : readPackageVersion();
