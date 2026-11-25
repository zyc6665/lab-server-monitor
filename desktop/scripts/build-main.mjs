// Bundles the Electron main process (src/main/main.ts) into dist/main.cjs so
// the new single-stack entry can be launched without touching the legacy
// electron/main.js entrypoint. Run via `pnpm build:main`.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  absWorkingDir: desktopDir,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  bundle: true,
  external: ['electron'],
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist/main.cjs',
  sourcemap: false,
});
