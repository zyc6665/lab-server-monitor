'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  resolveAppDir,
  backendPath,
  configPath,
  dotenvPath,
  dataDir,
  logsDir,
  electronUserData,
} = require('../electron/paths.js');

test('resolveAppDir returns appRoot in development mode', () => {
  const appRoot = path.join(path.sep, 'work', 'servermonitor');
  assert.equal(resolveAppDir({ isPackaged: false, appRoot }), appRoot);
});

test('resolveAppDir returns the executable directory in packaged mode', () => {
  assert.equal(
    resolveAppDir({ isPackaged: true, execPath: 'C:/app/servermonitor.exe' }),
    'C:/app',
  );
});

test('backendPath points at resources/backend in packaged mode', () => {
  const appDir = path.join(path.sep, 'apps', 'servermonitor');
  assert.equal(
    backendPath({ isPackaged: true, appDir }),
    path.join(appDir, 'resources', 'backend', 'servermonitor-backend.exe'),
  );
});

test('backendPath points at dist/backend in development mode', () => {
  const repoRoot = path.join(path.sep, 'repo', 'servermonitor');
  assert.equal(
    backendPath({ isPackaged: false, appDir: repoRoot }),
    path.join(repoRoot, 'dist', 'backend', 'servermonitor-backend', 'servermonitor-backend.exe'),
  );
});

test('configPath resolves config/config.yaml under the app directory', () => {
  const appDir = path.join(path.sep, 'apps', 'servermonitor');
  assert.equal(configPath(appDir), path.join(appDir, 'config', 'config.yaml'));
});

test('dotenvPath resolves config/.env under the app directory', () => {
  const appDir = path.join(path.sep, 'apps', 'servermonitor');
  assert.equal(dotenvPath(appDir), path.join(appDir, 'config', '.env'));
});

test('dataDir resolves data under the app directory', () => {
  const appDir = path.join(path.sep, 'apps', 'servermonitor');
  assert.equal(dataDir(appDir), path.join(appDir, 'data'));
});

test('logsDir resolves logs under the app directory', () => {
  const appDir = path.join(path.sep, 'apps', 'servermonitor');
  assert.equal(logsDir(appDir), path.join(appDir, 'logs'));
});

test('electronUserData resolves data/electron under the app directory', () => {
  const appDir = path.join(path.sep, 'apps', 'servermonitor');
  assert.equal(electronUserData(appDir), path.join(appDir, 'data', 'electron'));
});

test('resolveAppDir rejects packaged mode without execPath', () => {
  assert.throws(() => resolveAppDir({ isPackaged: true }), /execPath/);
});

test('resolveAppDir rejects development mode without appRoot', () => {
  assert.throws(() => resolveAppDir({ isPackaged: false }), /appRoot/);
});
