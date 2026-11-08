'use strict';

const path = require('node:path');
const fs = require('node:fs');

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  clipboard,
  shell,
  dialog,
  ipcMain,
  nativeImage,
} = require('electron');

const { resolveAppDir, electronUserData, logsDir } = require('./paths.js');
const { createBackendController } = require('./backend.js');
const { createUpdater } = require('./updater.js');
const {
  trayMenuTemplate,
  shouldHideOnClose,
  isBackendUrl,
} = require('./main-helpers.js');

const APP_TITLE = '服务器轮询监测工具';
const START_HIDDEN = process.argv.includes('--start-hidden');

const isPackaged = app.isPackaged;
const appDir = resolveAppDir({
  isPackaged,
  appRoot: path.join(__dirname, '..', '..'),
  execPath: process.execPath,
});

// Keep Chromium's cache/user data next to the app so the folder stays portable.
app.setPath('userData', electronUserData(appDir));

let mainWindow = null;
let tray = null;
let backend = null;
let updater = null;
let quitting = false;
let cleanupDone = false;
let currentRuntimeUrl = '';

function logFilePath() {
  return path.join(logsDir(appDir), 'desktop.log');
}

function appendLog(message) {
  const line = `${new Date().toISOString()} [main] ${message}\n`;
  try {
    fs.mkdirSync(logsDir(appDir), { recursive: true });
    fs.appendFileSync(logFilePath(), line);
  } catch (error) {
    console.error('failed to append desktop.log', error);
  }
}

function trayIconPath() {
  return path.join(__dirname, '..', 'build', 'icon.ico');
}

function showWindow() {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function quitApp() {
  quitting = true;
  app.quit();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    title: APP_TITLE,
    show: false,
    frame: false,
    backgroundColor: '#f6f8fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.on('close', (event) => {
    if (shouldHideOnClose({ trayAvailable: Boolean(tray), quitting })) {
      event.preventDefault();
      win.hide();
    }
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!isBackendUrl(url, currentRuntimeUrl)) {
      event.preventDefault();
      appendLog(`blocked navigation to ${url}`);
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

function createTray() {
  let image = nativeImage.createEmpty();
  try {
    const loaded = nativeImage.createFromPath(trayIconPath());
    if (loaded && !loaded.isEmpty()) {
      image = loaded;
    }
  } catch (error) {
    appendLog(`failed to load tray icon: ${error.message}`);
  }

  try {
    tray = new Tray(image);
  } catch (error) {
    appendLog(`failed to create tray: ${error.message}`);
    tray = null;
    return;
  }

  tray.setToolTip(APP_TITLE);

  const template = trayMenuTemplate({
    onShow: showWindow,
    onCopyUrl: () => {
      if (currentRuntimeUrl) {
        clipboard.writeText(currentRuntimeUrl);
      }
    },
    onOpenLogs: () => {
      shell.openPath(logsDir(appDir));
    },
    onQuit: quitApp,
  });

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.on('double-click', showWindow);
}

function registerIpc() {
  ipcMain.handle('desktop:restart-backend', async () => {
    try {
      if (!backend) {
        throw new Error('后端尚未初始化');
      }
      await backend.stop();
      await backend.start();
      const runtime = await backend.waitForRuntime();
      currentRuntimeUrl = runtime.url;
      if (mainWindow) {
        await mainWindow.loadURL(runtime.url);
      }
      return { ok: true, url: runtime.url };
    } catch (error) {
      appendLog(`restart backend failed: ${error.stack || error.message}`);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('desktop:copy-url', () => {
    if (!currentRuntimeUrl) {
      return { ok: false, error: '看板地址尚未就绪' };
    }
    clipboard.writeText(currentRuntimeUrl);
    return { ok: true, url: currentRuntimeUrl };
  });

  ipcMain.handle('window:action', (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return { ok: false };
    }
    if (action === 'minimize') {
      win.minimize();
    } else if (action === 'maximize') {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
      return { ok: true, maximized: win.isMaximized() };
    } else if (action === 'close') {
      win.close();
    }
    return { ok: true };
  });
}

async function startBackendAndLoad() {
  backend = createBackendController({
    appDir,
    isPackaged,
    logger: {
      info: (message) => appendLog(String(message)),
      warn: (message) => appendLog(`WARN ${message}`),
      error: (message, error) => appendLog(`ERROR ${message}${error ? ` ${error.message || error}` : ''}`),
    },
    onUnexpectedExit: (code, signal) => {
      appendLog(`backend exited unexpectedly (code=${code}, signal=${signal})`);
    },
  });

  await backend.start();
  const runtime = await backend.waitForRuntime();
  currentRuntimeUrl = runtime.url;

  if (!mainWindow) {
    return;
  }
  await mainWindow.loadURL(runtime.url);
  if (!START_HIDDEN) {
    mainWindow.show();
  }
}

async function bootstrap() {
  mainWindow = createWindow();
  createTray();
  registerIpc();

  updater = createUpdater({
    app,
    appDir,
    updatesDir: path.join(appDir, 'data', 'updates'),
    ipcMain,
    currentVersion: app.getVersion(),
    getWindow: () => mainWindow,
    requestQuit: quitApp,
    logger: {
      info: (message) => appendLog(String(message)),
    },
  });
  updater.init();

  try {
    await startBackendAndLoad();
  } catch (error) {
    appendLog(`failed to start backend: ${error.stack || error.message}`);
    dialog.showErrorBox(APP_TITLE, `后端启动失败：${error.message}`);
    quitting = true;
    app.quit();
  }
}

app.on('second-instance', () => {
  showWindow();
});

app.on('before-quit', (event) => {
  quitting = true;
  if (cleanupDone || !backend) {
    return;
  }
  event.preventDefault();
  cleanupDone = true;
  backend
    .stop()
    .catch((error) => appendLog(`failed to stop backend: ${error.stack || error.message}`))
    .finally(() => {
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    quitting = true;
    app.quit();
  }
});

app.on('activate', () => {
  showWindow();
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.whenReady().then(bootstrap);
}
