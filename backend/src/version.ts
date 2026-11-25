import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface PackageJson {
  version: string;
}

/**
 * Reads the version from backend/package.json.
 *
 * Works from both `src/` (vitest, ts-node) and `dist/` (compiled output) because
 * package.json always sits one level above the file's own directory.
 */
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as PackageJson;

export const APP_VERSION: string = packageJson.version;
