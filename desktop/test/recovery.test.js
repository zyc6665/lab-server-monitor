'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = path.join(__dirname, '..', 'electron', 'main.js');

function source() {
  return fs.readFileSync(MAIN, 'utf8');
}

test('backend exit schedules automatic recovery', () => {
  const code = source();
  assert.match(code, /const RECOVERY_DELAYS_MS = \[2000, 5000, 10000, 20000, 30000\];/);
  assert.match(code, /function scheduleBackendRecovery\(\)/);
  assert.match(code, /function attemptBackendRecovery\(\)/);
  assert.match(code, /onUnexpectedExit: \(code, signal\) => {[\s\S]*?scheduleBackendRecovery\(\);/);
});

test('recovery backs off and never gives up', () => {
  const code = source();
  assert.match(code, /const index = Math\.min\(recoveryAttempts, RECOVERY_DELAYS_MS\.length - 1\);/);
  assert.match(code, /recoveryAttempts \+= 1;/);
  assert.match(code, /attemptBackendRecovery\(\)\.catch/);
  assert.match(code, /scheduleBackendRecovery\(\);\r?\n    \}\);/);
});

test('recovery reloads the window and resets the backoff', () => {
  const code = source();
  assert.match(code, /recoveryAttempts = 0;/);
  assert.match(code, /await mainWindow\.loadURL\(runtime\.url\);/);
});

test('recovery is skipped while quitting or cleaning up', () => {
  const code = source();
  assert.match(code, /if \(quitting \|\| cleanupDone \|\| recoveryTimer\) {\r?\n    return;/);
  assert.match(code, /if \(quitting \|\| cleanupDone \|\| !backend\) {\r?\n    return;/);
  assert.match(code, /clearTimeout\(recoveryTimer\);/);
});
