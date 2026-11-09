'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'electron', 'main.js'),
  'utf8',
);

test('main.js destroys the dashboard window when minimized or closed to tray', () => {
  assert.match(source, /function destroyWindow\(\)/);
  assert.match(source, /win\.on\('minimize',[\s\S]*?destroyWindow\(\)/);
  assert.match(source, /win\.on\('close',[\s\S]*?destroyWindow\(\)/);
  assert.doesNotMatch(source, /win\.hide\(\)/);
});

test('main.js recreates the dashboard window from the tray', () => {
  assert.match(source, /function ensureWindow\(\)/);
  assert.match(source, /mainWindow = createWindow\(\)/);
  assert.match(source, /currentRuntimeUrl[\s\S]*?mainWindow\.loadURL/);
});

test('main.js keeps the tray and backend alive when the window is destroyed', () => {
  assert.match(source, /window-all-closed[\s\S]*?!tray \|\| quitting/);
});

test('main.js runs startup cleanup for logs, updates and cache', () => {
  assert.match(source, /runStartupCleanup\(\)/);
  assert.match(source, /pruneLogFiles\(/);
  assert.match(source, /cleanupUpdateDownloads\(/);
  assert.match(source, /cleanupElectronCache\(/);
});
