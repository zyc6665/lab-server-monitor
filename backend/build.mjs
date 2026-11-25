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
  // P1/P2 use native modules; keep them external so they are never pulled into
  // the bundle. P3 collection adds ssh2 (which itself lazily require()s the
  // optional native cpu-features binding), so it must stay external too: the
  // packaged runtime resolves it from node_modules instead of esbuild trying to
  // inline a .node binary. The composition root is imported lazily (health-only
  // boots do not require them), so the packaged main.cjs still starts without a DB.
  external: ['better-sqlite3', '@primno/dpapi', 'ssh2'],
  entryPoints: ['src/server.ts'],
  outfile: 'dist/main.cjs',
  sourcemap: false,
  // Inject the version literal at build time so the packaged bundle never has to
  // read package.json from disk (the installed resources/backend/ dir has none).
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
});
