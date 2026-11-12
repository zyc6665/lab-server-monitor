'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  trayMenuTemplate,
  shouldHideOnClose,
  validateDashboardHost,
  isBackendUrl,
} = require('../electron/main-helpers.js');

const PRELOAD_PATH = path.join(__dirname, '..', 'electron', 'preload.js');

test('trayMenuTemplate returns the four labels in the exact order', () => {
  const calls = [];
  const template = trayMenuTemplate({
    onShow: () => calls.push('show'),
    onCopyUrl: () => calls.push('copy'),
    onOpenLogs: () => calls.push('logs'),
    onQuit: () => calls.push('quit'),
  });

  assert.deepEqual(
    template.map((item) => item.label),
    ['显示主窗口', '复制看板地址', '打开日志目录', '退出'],
  );

  template.forEach((item) => item.click());
  assert.deepEqual(calls, ['show', 'copy', 'logs', 'quit']);
});

test('trayMenuTemplate rejects missing handlers', () => {
  assert.throws(() => trayMenuTemplate({}), /onShow/);
});

test('shouldHideOnClose keeps the app alive unless it is really quitting', () => {
  assert.equal(shouldHideOnClose({ trayAvailable: true, quitting: false }), true);
  // A missing tray icon must not turn "close" into "quit".
  assert.equal(shouldHideOnClose({ trayAvailable: false, quitting: false }), true);
  assert.equal(shouldHideOnClose({ quitting: true }), false);
  assert.equal(shouldHideOnClose(), true);
});

test('validateDashboardHost accepts loopback and wildcard hosts', () => {
  assert.doesNotThrow(() => validateDashboardHost(''));
  assert.doesNotThrow(() => validateDashboardHost('0.0.0.0'));
  assert.doesNotThrow(() => validateDashboardHost('::'));
  assert.doesNotThrow(() => validateDashboardHost('127.0.0.1'));
  assert.doesNotThrow(() => validateDashboardHost('localhost'));
  assert.doesNotThrow(() => validateDashboardHost('::1'));
  assert.doesNotThrow(() => validateDashboardHost('127.1.2.3'));
});

test('validateDashboardHost throws a Chinese error for a non-loopback IP', () => {
  assert.throws(
    () => validateDashboardHost('10.0.0.5'),
    (error) => /[\u4e00-\u9fa5]/.test(error.message),
  );
  assert.throws(() => validateDashboardHost('192.168.1.10'), /[\u4e00-\u9fa5]/);
});

test('isBackendUrl only allows the backend origin', () => {
  const runtimeUrl = 'http://127.0.0.1:8377/';
  assert.equal(isBackendUrl('http://127.0.0.1:8377/', runtimeUrl), true);
  assert.equal(isBackendUrl('http://127.0.0.1:8377/settings', runtimeUrl), true);
  assert.equal(isBackendUrl('https://example.com/', runtimeUrl), false);
  assert.equal(isBackendUrl('http://127.0.0.1:9999/', runtimeUrl), false);
  assert.equal(isBackendUrl('not a url', runtimeUrl), false);
  assert.equal(isBackendUrl('http://127.0.0.1:8377/', ''), false);
});

test('preload exposes only the minimal desktop bridge', () => {
  const source = fs.readFileSync(PRELOAD_PATH, 'utf8');

  assert.match(source, /contextBridge\.exposeInMainWorld\(\s*["']desktopBridge["']/);
  assert.match(source, /isDesktop\s*:\s*true/);
  assert.match(source, /restartBackend\s*:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(\s*["']desktop:restart-backend["']\s*\)/);
  assert.match(source, /copyDashboardUrl\s*:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(\s*["']desktop:copy-url["']\s*\)/);

  assert.doesNotMatch(source, /require\(\s*["']child_process["']\s*\)/);
  assert.doesNotMatch(source, /require\(\s*["']node:child_process["']\s*\)/);
  assert.doesNotMatch(source, /require\(\s*["']fs["']\s*\)/);
  assert.doesNotMatch(source, /require\(\s*["']node:fs["']\s*\)/);
  assert.doesNotMatch(source, /ipcRenderer\.send\b/);
  assert.doesNotMatch(source, /exposeInMainWorld\(\s*["'](?!desktopBridge)/);
});
