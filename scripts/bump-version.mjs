#!/usr/bin/env node
// Synchronise the project version across the root, backend and desktop
// package.json files. Node replacement for the removed tools/bump_version.py.
//
//   node scripts/bump-version.mjs 0.2.0     # write version
//   node scripts/bump-version.mjs --check   # verify all files agree (exit 1 if not)
//
// backend/src/version.ts reads backend/package.json (or the esbuild-injected
// __APP_VERSION__), so it needs no literal rewrite.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.BUMP_VERSION_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
export const FILES = ['package.json', 'backend/package.json', 'desktop/package.json'];
export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readPkg(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
}

export function readVersions() {
  return Object.fromEntries(FILES.map((rel) => [rel, String(readPkg(rel).version ?? '')]));
}

export function check() {
  const versions = readVersions();
  const problems = [];
  for (const [rel, v] of Object.entries(versions)) {
    if (!VERSION_RE.test(v)) problems.push(`${rel}: missing or malformed version ${JSON.stringify(v)}`);
  }
  if (problems.length === 0 && new Set(Object.values(versions)).size !== 1) {
    const detail = Object.entries(versions).map(([k, v]) => `${k}=${v}`).join(', ');
    problems.push(`version files disagree: ${detail}`);
  }
  return problems;
}

export function bump(version) {
  if (!VERSION_RE.test(version)) throw new Error(`invalid version: ${version}`);
  for (const rel of FILES) {
    const pkg = readPkg(rel);
    pkg.version = version;
    writeFileSync(join(ROOT, rel), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }
}

function main(argv) {
  const args = argv.filter((a) => a !== '--check');
  if (argv.includes('--check')) {
    const problems = check();
    if (problems.length) {
      for (const p of problems) console.error(`ERROR: ${p}`);
      return 1;
    }
    console.log(`version consistent: ${Object.values(readVersions())[0]}`);
    return 0;
  }
  if (args.length !== 1) {
    console.error('usage: node scripts/bump-version.mjs <version> | --check');
    return 2;
  }
  try {
    bump(args[0]);
  } catch (err) {
    console.error(String(err.message || err));
    return 1;
  }
  console.log(`version updated to ${args[0]}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
