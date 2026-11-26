// Stage the runtime dependencies that build.mjs keeps external (native or
// otherwise unbundleable) into dist/vendor/node_modules, dereferenced so that
// electron-builder can copy them as plain files into the packaged app.
//
// require('better-sqlite3') / '@primno/dpapi' / 'ssh2' / 'nodemailer' from
// resources/backend/main.cjs then resolves through resources/backend/node_modules.
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const require = createRequire(path.join(pkgRoot, 'package.json'));
const outRoot = path.join(pkgRoot, 'dist', 'vendor', 'node_modules');

const ROOTS = ['better-sqlite3', '@primno/dpapi', 'ssh2', 'nodemailer'];

/** Resolve a package's directory from a starting package dir. */
function resolvePkgDir(name, fromPkgDir) {
  try {
    const pkgJson = require.resolve(`${name}/package.json`, { paths: [fromPkgDir] });
    return path.dirname(realpathSync(pkgJson));
  } catch {
    return null;
  }
}

const copied = new Set();

function copyPkg(name, fromPkgDir) {
  if (copied.has(name)) return;
  const dir = resolvePkgDir(name, fromPkgDir);
  if (!dir) return;
  copied.add(name);
  const dest = path.join(outRoot, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(dir, dest, { recursive: true, dereference: true });

  // Walk runtime deps declared in the package's package.json.
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies || {})) {
    copyPkg(dep, dir);
  }
}

fs.rmSync(path.join(pkgRoot, 'dist', 'vendor'), { recursive: true, force: true });
fs.mkdirSync(outRoot, { recursive: true });
for (const name of ROOTS) copyPkg(name, pkgRoot);

// Trim better-sqlite3 to the Windows x64 prebuilt binary only: the package
// ships prebuilds for six platforms plus C++ sources, none needed on Windows.
const bsq = path.join(outRoot, 'better-sqlite3');
if (fs.existsSync(bsq)) {
  const keep = 'win32-x64.node';
  for (const f of fs.readdirSync(path.join(bsq, 'prebuilds'))) {
    if (f !== keep) fs.rmSync(path.join(bsq, 'prebuilds', f), { force: true });
  }
  for (const dir of ['deps', 'src', 'build', 'binding.gyp']) {
    fs.rmSync(path.join(bsq, dir), { recursive: true, force: true });
  }
}

console.log(`[stage-vendor] staged ${copied.size} packages -> ${path.relative(pkgRoot, outRoot)}`);
for (const name of [...copied].sort()) console.log(`  - ${name}`);

// electron-builder copies extraResources relative to the app (desktop) dir and
// skips sources outside it, so also stage a copy there.
const desktopVendor = path.resolve(pkgRoot, '..', 'desktop', '.vendor-stage');
fs.rmSync(desktopVendor, { recursive: true, force: true });
fs.mkdirSync(path.dirname(desktopVendor), { recursive: true });
fs.cpSync(path.join(pkgRoot, 'dist', 'vendor', 'node_modules'), path.join(desktopVendor, 'pkgs'), { recursive: true, dereference: true });
console.log(`[stage-vendor] mirrored -> ${path.relative(path.resolve(pkgRoot, '..'), desktopVendor)}`);
