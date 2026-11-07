'use strict';

// Static contract tests for the portable desktop assembly scripts.
//
// These tests deliberately assert on the *text* of the PowerShell scripts
// (structure, required commands and paths) instead of executing electron-
// builder, so they run anywhere without a network connection.  The real build
// is exercised separately via `powershell -File scripts/build-portable.ps1`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scriptsDir = path.join(__dirname, '..', 'scripts');

function readScript(name) {
  const file = path.join(scriptsDir, name);
  assert.ok(fs.existsSync(file), `expected script to exist: ${file}`);
  // Strip a UTF-8 BOM so leading-token assertions stay reliable.
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

const build = readScript('build-portable.ps1');
const verify = readScript('verify-package.ps1');

function assertContains(haystack, needle, label) {
  assert.ok(haystack.includes(needle), `${label || JSON.stringify(needle)} should appear in the script`);
}

// ---------------------------------------------------------------------------
// build-portable.ps1
// ---------------------------------------------------------------------------

test('build-portable.ps1 stops on errors and resolves the project root by walking up', () => {
  assertContains(build, '$ErrorActionPreference', 'ErrorActionPreference');
  assertContains(build, "'Stop'", 'Stop preference');
  // The script must locate the project by this nested marker, not assume cwd.
  assertContains(build, 'servermonitor-main/servermonitor-main', 'project-root marker');
});

test('build-portable.ps1 installs dependencies and builds the Electron app', () => {
  assertContains(build, 'pnpm install');
  assertContains(build, 'pnpm run build');
});

test('build-portable.ps1 builds the backend first when the exe is missing, and fails clearly', () => {
  assertContains(build, 'dist/backend/servermonitor-backend', 'backend dist dir');
  assertContains(build, 'servermonitor-backend.exe', 'backend exe');
  assertContains(build, 'build-backend.ps1');
  // A clear failure (throw) when the exe is still missing after the build.
  assert.match(build, /throw[^\n]*[Bb]ackend/i, 'should throw a clear backend-missing error');
});

test('build-portable.ps1 stages electron output and the backend resources', () => {
  assert.match(build, /release-electron[\\/]win-unpacked/i, 'win-unpacked staging source');
  assert.match(build, /resources[\\/]backend/i, 'resources/backend target');
  assert.match(build, /build[\\/]portable[\\/]servermonitor/i, 'staging directory');
});

test('build-portable.ps1 seeds config from the example, and always creates data/logs', () => {
  assert.match(build, /config[\\/]config\.yaml\.example/i, 'config example');
  assert.match(build, /config[\\/]config\.yaml\b/i, 'config target');
  assert.match(build, /['"]data['"]/i, 'data dir literal');
  assert.match(build, /['"]logs['"]/i, 'logs dir literal');
});

test('build-portable.ps1 copies the root launchers and docs', () => {
  for (const name of [
    '启动.bat',
    '停止.bat',
    '注册开机自启.ps1',
    '允许局域网访问.ps1',
    '使用说明.txt',
    'README.md',
  ]) {
    assertContains(build, name, name);
  }
});

test('build-portable.ps1 compresses to the v1.3 release zip', () => {
  assertContains(build, 'Compress-Archive');
  assertContains(build, '服务器轮询监测工具-Windows-x64-v1.3.zip');
  assertContains(build, 'release', 'release output dir');
});

test('build-portable.ps1 cleans ONLY the staging directory on upgrade', () => {
  const removeLines = build
    .split(/\r?\n/)
    .filter((line) => /^\s*Remove-Item\b/i.test(line));
  assert.equal(
    removeLines.length,
    1,
    `expected exactly one Remove-Item (staging cleanup), got ${removeLines.length}: ${removeLines.join(' | ')}`,
  );
  assert.match(removeLines[0], /\$stagingDir/i, 'Remove-Item must target $stagingDir');
  // The staging dir must be scoped under desktop/build/portable/servermonitor.
  assert.match(build, /\$stagingDir\s*=\s*Join-Path[^\n]*build[\\/]portable[\\/]servermonitor/i);
});

test('build-portable.ps1 preserves existing config/data/logs on upgrade (copy-over, never clobber)', () => {
  // config.yaml must be seeded only when absent...
  assert.match(
    build,
    /if\s*\(\s*-not\s*\(\s*Test-Path[^\n]*[Cc]onfig\s*\)\s*\)/i,
    'config seed guarded by Test-Path',
  );
  // ...and all copy operations overwrite in place instead of deleting sources.
  assert.match(build, /Copy-Item[^\n]*-Force/i, 'copy-over with -Force');
  // No Remove-Item may reference the source config/data/logs directories.
  const removeLines = build
    .split(/\r?\n/)
    .filter((line) => /^\s*Remove-Item\b/i.test(line));
  for (const line of removeLines) {
    assert.doesNotMatch(line, /(^|[\\/'"\s])(config|data|logs)([\\/'"\s]|$)/i, `Remove-Item must not touch source data: ${line.trim()}`);
  }
});

// ---------------------------------------------------------------------------
// verify-package.ps1
// ---------------------------------------------------------------------------

test('verify-package.ps1 asserts every required staged artifact', () => {
  assert.match(verify, /servermonitor\.exe/i, 'main executable');
  assert.match(verify, /resources[\\/]backend[\\/]servermonitor-backend\.exe/i, 'backend exe');
  assert.match(verify, /config[\\/]config\.yaml\b/i, 'config file');
  assertContains(verify, '启动.bat', '启动.bat');
});

test('verify-package.ps1 exits non-zero with a clear message on failure', () => {
  assertContains(verify, '$ErrorActionPreference', 'ErrorActionPreference');
  assert.match(verify, /throw|exit\s+1/i, 'non-zero exit on failure');
});

// ---------------------------------------------------------------------------
// Encoding guard: Windows PowerShell 5.1 needs a UTF-8 BOM to read the
// Chinese literals (launcher names, zip name) in build-portable.ps1.
// ---------------------------------------------------------------------------

test('build-portable.ps1 keeps its UTF-8 BOM', () => {
  const buf = fs.readFileSync(path.join(scriptsDir, 'build-portable.ps1'));
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'build-portable.ps1 must start with UTF-8 BOM');
});
