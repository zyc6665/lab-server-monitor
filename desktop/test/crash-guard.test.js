const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mainJs = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

test('main process logs uncaught exceptions instead of dying', () => {
  assert.match(mainJs, /process\.on\('uncaughtException'/);
  assert.match(mainJs, /UNCAUGHT/);
});

test('main process logs unhandled rejections', () => {
  assert.match(mainJs, /process\.on\('unhandledRejection'/);
  assert.match(mainJs, /UNHANDLED REJECTION/);
});

test('backend recovery failure is contained and retried', () => {
  const body = mainJs.slice(mainJs.indexOf('async function attemptBackendRecovery'));
  assert.match(body, /try \{/);
  assert.match(body, /catch \(error\)/);
  assert.match(body, /scheduleBackendRecovery\(\);/);
});

test('recovery does not throw out of the timer callback', () => {
  const body = mainJs.slice(mainJs.indexOf('function scheduleBackendRecovery'), mainJs.indexOf('async function attemptBackendRecovery'));
  assert.match(body, /\.catch\(\(error\) => \{/);
  assert.match(body, /backend recovery failed/);
});
