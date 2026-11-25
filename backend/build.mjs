// Bundles the backend into a single CJS file that Electron's utilityProcess
// can fork directly: dist/main.cjs.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(backendDir, 'package.json'), 'utf8'));

await build({
  absWorkingDir: backendDir,
  platform: 'node',
  format: 'cjs',
  bundle: true,
  target: 'node22',
  // P1 will use the native better-sqlite3 module; keep it external so it is
  // never pulled into the bundle.
  external: ['better-sqlite3'],
  entryPoints: ['src/server.ts'],
  outfile: 'dist/main.cjs',
  sourcemap: false,
  // Inject the version literal at build time so the packaged bundle never has to
  // read package.json from disk (the installed resources/backend/ dir has none).
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
});
