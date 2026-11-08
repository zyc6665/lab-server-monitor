'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createUpdater } = require('../electron/updater.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'updater-int-'));
}

function fakeIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle(name, fn) {
      handlers.set(name, fn);
    },
  };
}

function fakeWindow() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
}

test('init registers update IPC handlers and check sends status events', async () => {
  const ipc = fakeIpc();
  const win = fakeWindow();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ tag_name: 'v1.5.1', assets: [] }),
  });
  const updater = createUpdater({
    app: { isPackaged: false },
    appDir: tempDir(),
    updatesDir: tempDir(),
    ipcMain: ipc,
    currentVersion: '1.5.0',
    fetchImpl,
    getWindow: () => win,
  });
  updater.init();
  assert.ok(ipc.handlers.has('update:check'));
  assert.ok(ipc.handlers.has('update:download'));
  assert.ok(ipc.handlers.has('update:install'));

  const result = await ipc.handlers.get('update:check')({}, true);
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'error'); // no Windows zip in this fixture
  assert.equal(win.sent[0].payload.state, 'checking');
});

test('install rejects paths outside the updates directory', () => {
  const updater = createUpdater({
    app: { isPackaged: false },
    appDir: tempDir(),
    updatesDir: tempDir(),
    ipcMain: null,
    currentVersion: '1.5.0',
    platform: 'win32',
  });
  const result = updater.install({ path: 'C:/somewhere/else.zip', version: '1.5.1' });
  assert.equal(result.ok, false);
});

test('install launches apply-update.ps1 when the package path is valid', async () => {
  const updatesDir = tempDir();
  const appDir = tempDir();
  const zip = path.join(updatesDir, 'download', 'package.zip');
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  fs.writeFileSync(zip, 'x');
  const calls = [];
  let quit = false;
  const updater = createUpdater({
    app: { isPackaged: false },
    appDir,
    updatesDir,
    ipcMain: null,
    currentVersion: '1.5.0',
    platform: 'win32',
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { unref() {} };
    },
    requestQuit: () => {
      quit = true;
    },
  });
  const result = updater.install({ path: zip, version: '1.5.1' });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.ok(calls[0].args.includes('-File'));
  assert.ok(calls[0].args.includes(path.join(appDir, 'apply-update.ps1')));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(quit, true);
});
