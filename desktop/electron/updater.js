'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const { createUpdaterCore } = require('./updater-core.js');

function createUpdater(options) {
  const {
    app,
    appDir,
    updatesDir,
    ipcMain,
    logger,
    currentVersion,
    getWindow,
    requestQuit,
    spawnImpl = spawn,
    platform = process.platform,
    autoCheckDelayMs = 10000,
  } = options;

  const core = createUpdaterCore({
    repo: options.repo || 'zyc6665/lab-server-monitor',
    currentVersion,
    updatesDir,
    fetchImpl: options.fetchImpl,
  });
  let lastUpdate = null;
  let autoTimer = null;

  function log(message) {
    if (logger && typeof logger.info === 'function') logger.info(message);
  }

  function send(channel, payload) {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  async function check(force = false) {
    send('update:status', { state: 'checking' });
    const result = await core.checkForUpdate({ force });
    send('update:status', { state: 'checked', result });
    return result;
  }

  async function download(update) {
    const payload = update || lastUpdate;
    if (!payload) return { ok: false, error: '请先检查更新' };
    send('update:status', { state: 'downloading', version: payload.version });
    const result = await core.downloadAndVerify(payload);
    lastUpdate = { ...payload, ...result };
    send('update:status', { state: 'downloaded', result });
    return { ok: true, ...result };
  }

  function install(update) {
    const payload = update || lastUpdate;
    if (!payload || !payload.path) return { ok: false, error: '请先下载更新包' };
    const resolved = path.resolve(payload.path);
    const root = path.resolve(updatesDir) + path.sep;
    if (!resolved.startsWith(root)) {
      return { ok: false, error: '更新包路径无效' };
    }
    if (platform !== 'win32') {
      return { ok: false, error: '自动安装仅支持 Windows' };
    }
    const script = path.join(appDir, 'apply-update.ps1');
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-ZipPath',
      resolved,
      '-AppDir',
      appDir,
      '-WaitPid',
      String(process.pid),
    ];
    log(`launching updater for ${payload.version}`);
    const child = spawnImpl('powershell.exe', args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child && typeof child.unref === 'function') child.unref();
    setTimeout(() => {
      if (typeof requestQuit === 'function') requestQuit();
    }, 150);
    return { ok: true, restarting: true };
  }

  function registerIpc() {
    if (!ipcMain || typeof ipcMain.handle !== 'function') return;
    ipcMain.handle('update:check', async (_event, force) => {
      try {
        return { ok: true, result: await check(Boolean(force)) };
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) };
      }
    });
    ipcMain.handle('update:download', async (_event, update) => {
      try {
        return await download(update);
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) };
      }
    });
    ipcMain.handle('update:install', (_event, update) => {
      try {
        return install(update);
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) };
      }
    });
  }

  function startAutoCheck() {
    if (!app || !app.isPackaged) return;
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      check(false).catch((error) => log(`auto update check failed: ${error.message}`));
    }, autoCheckDelayMs);
    if (autoTimer.unref) autoTimer.unref();
  }

  function stopAutoCheck() {
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = null;
  }

  return {
    init() {
      registerIpc();
      startAutoCheck();
    },
    check,
    download,
    install,
    stopAutoCheck,
  };
}

module.exports = { createUpdater };
