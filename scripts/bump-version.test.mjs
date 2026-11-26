// node --test scripts/bump-version.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'bump-version.mjs');

function fixture(versions) {
  const root = mkdtempSync(join(tmpdir(), 'bump-'));
  for (const [rel, v] of Object.entries(versions)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), JSON.stringify({ name: rel, version: v }, null, 2) + '\n');
  }
  return root;
}
const run = (root, ...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, BUMP_VERSION_ROOT: root }, encoding: 'utf8' });

test('--check passes when consistent', () => {
  const root = fixture({ 'package.json': '0.2.0', 'backend/package.json': '0.2.0', 'desktop/package.json': '0.2.0' });
  const r = run(root, '--check');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /version consistent: 0\.2\.0/);
});

test('--check exits 1 when inconsistent', () => {
  const root = fixture({ 'package.json': '0.2.0', 'backend/package.json': '0.1.9', 'desktop/package.json': '0.2.0' });
  const r = run(root, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /disagree/);
});

test('bump writes all three package.json', () => {
  const root = fixture({ 'package.json': '0.1.0', 'backend/package.json': '0.1.0', 'desktop/package.json': '0.1.0' });
  assert.equal(run(root, '0.2.0-rc.1').status, 0);
  for (const rel of ['package.json', 'backend/package.json', 'desktop/package.json']) {
    assert.equal(JSON.parse(readFileSync(join(root, rel), 'utf8')).version, '0.2.0-rc.1');
  }
});

test('rejects invalid version', () => {
  const root = fixture({ 'package.json': '0.1.0', 'backend/package.json': '0.1.0', 'desktop/package.json': '0.1.0' });
  assert.equal(run(root, 'v1').status, 1);
});
