/**
 * Electron main process for the single-stack build.
 *
 * Responsibilities (P6 Task 4): resolve the data directory (HKCU pointer /
 * `--data-dir` override), spawn the bundled Node backend through
 * `utilityProcess`, wait for the runtime handshake file, then load the backend
 * URL in a BrowserWindow. Adds a tray icon (with an autostart toggle), a
 * single-instance lock, graceful backend shutdown, and optional autoupdate.
 *
 * All non-trivial decision logic lives in `lifecycle.ts` (pure/testable); this
 * file supplies the real Electron + filesystem dependencies.
 */
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  utilityProcess,
  shell,
  clipboard,
  ipcMain,
} from 'electron';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  accessSync,
  constants,
} from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';

import {
  resolveInstallDir,
  logsDir,
  pickDataDir,
  readDataDirPointer,
  writeDataDirPointer,
  type PickDataDirFs,
} from './paths';
import { waitForRuntime, nextRetryDelay, type RuntimeInfo } from './backend-process';
import {
  buildBackendArgs,
  parseDataDirArg,
  startHidden,
  shouldShowWindow,
  shutdownPlan,
  legacyDbCandidates,
  detectLegacyImport,
  buildLoginItemArgs,
} from './lifecycle';
import { createUpdater, type AutoUpdaterLike, type UpdaterControl } from './updater';

type BackendProcess = ReturnType<typeof utilityProcess.fork>;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let backendProc: BackendProcess | null = null;
let updater: UpdaterControl | null = null;
let retryAttempt = 0;
let quitting = false;
let shuttingDown = false;
let currentUrl = '';
let dataDir = '';
let runtimePath = '';

const START_HIDDEN = startHidden(process.argv);

const localAppData = process.env.LOCALAPPDATA ?? '';
const existsDrive = (d: string): boolean => existsSync(d + '\\');
const installDir = resolveInstallDir({ existsDrive, localAppData });

/** Real filesystem surface for {@link pickDataDir}. */
const fsApi: PickDataDirFs = {
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  writable: (p) => {
    try {
      accessSync(p, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  // `instance.json` fallback pointer: `{ "dataDir": "D:\..." }`.
  readInstanceJson: (p) => {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { dataDir?: unknown };
      return typeof parsed.dataDir === 'string' ? parsed.dataDir : null;
    } catch {
      return null;
    }
  },
};

/**
 * Resolve the effective data directory once at startup.
 *
 * Precedence: `--data-dir` (temporary override, highest) > HKCU pointer >
 * default non-system drive. The pointer is persisted only when we fell through
 * to the default (i.e. there was no usable pointer) and this is not a temporary
 * CLI override. Any pointer-write failure is a warning, never fatal.
 */
function initDataDir(): void {
  const cliDataDir = parseDataDirArg(process.argv);
  if (cliDataDir) {
    dataDir = path.resolve(cliDataDir);
  } else {
    const picked = pickDataDir({
      pointer: readDataDirPointer(),
      installDir,
      env: process.env,
      existsDrive,
      fsApi,
    });
    dataDir = picked.dataDir;
    if (picked.warning) {
      // eslint-disable-next-line no-console
      console.warn(`[data-dir] ${picked.warning}`);
    }
    if (picked.source === 'default') {
      try {
        writeDataDirPointer(picked.dataDir);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`[data-dir] 写入数据目录指针失败（忽略）：${String(error)}`);
      }
    }
  }

  runtimePath = join(dataDir, 'runtime.json');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(logsDir(dataDir), { recursive: true });
}

/** True when this first run should import a legacy database. */
function computeImportLegacy(): boolean {
  const candidates = legacyDbCandidates({ dataDir, env: process.env, cwd: process.cwd() });
  return detectLegacyImport({ dataDir, legacyCandidates: candidates, exists: existsSync });
}

function backendEntry(): string {
  if (process.env.BACKEND_ENTRY) {
    return process.env.BACKEND_ENTRY;
  }
  if (app.isPackaged) {
    return join(process.resourcesPath, 'backend', 'main.cjs');
  }
  return path.resolve(__dirname, '..', '..', 'backend', 'dist', 'main.cjs');
}

function readRuntime(): RuntimeInfo | null {
  try {
    return JSON.parse(readFileSync(runtimePath, 'utf8')) as RuntimeInfo;
  } catch {
    return null;
  }
}

function spawnBackend(importLegacy: boolean): void {
  const entry = backendEntry();
  const args = buildBackendArgs({ dataDir, runtimePath, importLegacy });
  backendProc = utilityProcess.fork(entry, args, {
    stdio: 'pipe',
    serviceName: 'servermonitor-backend',
  });
  backendProc.on('exit', (code) => {
    backendProc = null;
    if (quitting) {
      return;
    }
    const delay = nextRetryDelay(retryAttempt++);
    setTimeout(() => {
      if (quitting) {
        return;
      }
      void launchBackend(importLegacy);
    }, delay);
    // eslint-disable-next-line no-console
    console.warn(`[backend] exited with code ${code}; restarting in ${delay}ms`);
  });
}

async function launchBackend(importLegacy: boolean): Promise<RuntimeInfo> {
  rmSync(runtimePath, { force: true });
  spawnBackend(importLegacy);
  const rt = await waitForRuntime(readRuntime, { timeoutMs: 30000 });
  retryAttempt = 0;
  currentUrl = rt.url;
  return rt;
}

function showWindow(): void {
  if (!win) {
    return;
  }
  if (win.isMinimized()) {
    win.restore();
  }
  win.show();
  win.focus();
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
  });
  w.once('ready-to-show', () => {
    // `--start-hidden` keeps the window invisible (tray only); the tray
    // double-click / second-instance handler still restores it on demand.
    if (shouldShowWindow({ startHidden: START_HIDDEN })) {
      w.show();
    }
  });
  w.on('close', (e) => {
    e.preventDefault();
    w.hide();
  });
  return w;
}

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty());
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showWindow() },
    {
      label: '复制看板地址',
      click: () => {
        if (currentUrl) {
          clipboard.writeText(currentUrl);
        }
      },
    },
    {
      label: '打开日志目录',
      click: () => {
        void shell.openPath(logsDir(dataDir));
      },
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          args: buildLoginItemArgs(),
        });
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setToolTip('实验室服务器轮询维护');
  tray.setContextMenu(menu);
  tray.on('double-click', () => showWindow());
}

/**
 * Wire `electron-updater` in packaged builds only. In development (and in tests)
 * this is a no-op so the module is never loaded. A packaged build checks once,
 * 10s after startup; every failure is logged and never crashes the app.
 */
function initUpdater(): void {
  if (!app.isPackaged) {
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { autoUpdater } = require('electron-updater') as { autoUpdater: AutoUpdaterLike };
    updater = createUpdater({
      autoUpdater,
      currentVersion: app.getVersion(),
      ipcMain,
      log: (message) => {
        // eslint-disable-next-line no-console
        console.log(`[update] ${message}`);
      },
      notify: (event) => {
        if (event.status === 'error') {
          // eslint-disable-next-line no-console
          console.warn(`[update] error: ${event.error ?? 'unknown'}`);
        }
      },
    });
    setTimeout(() => {
      void updater?.check();
    }, 10000);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[update] 初始化失败（忽略）：${String(error)}`);
  }
}

/** Resolve true when the backend process exits within `timeoutMs`. */
function waitForBackendExit(timeoutMs: number): Promise<boolean> {
  const proc = backendProc;
  if (!proc) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(exited);
    };
    try {
      proc.once('exit', () => finish(true));
    } catch {
      /* fall through to the timeout */
    }
    setTimeout(() => finish(false), timeoutMs);
  });
}

/** Graceful backend shutdown: terminate → wait ≤7s → force kill. */
function requestGracefulShutdown(): Promise<'graceful' | 'forced'> {
  return shutdownPlan({
    kill: () => {
      backendProc?.kill();
    },
    waitExit: waitForBackendExit,
    forceKill: () => {
      const pid = backendProc?.pid;
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    },
    timeoutMs: 7000,
  }).run();
}

async function main(): Promise<void> {
  initDataDir();
  const importLegacy = computeImportLegacy();

  win = createWindow();
  createTray();
  initUpdater();

  const rt = await launchBackend(importLegacy);
  await win.loadURL(rt.url);
}

// Single-instance lock: a second launch focuses the existing window instead of
// starting another backend. `--start-hidden` on the primary does not stop a
// later manual launch from surfacing the window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  app.on('window-all-closed', () => {
    // Resident in the tray: do not quit when the window is closed. Re-create
    // the tray if it was somehow lost so the dashboard can always be reopened.
    if (quitting) {
      app.quit();
      return;
    }
    if (!tray) {
      try {
        createTray();
      } catch {
        /* tray is best-effort */
      }
    }
  });

  app.on('activate', () => {
    showWindow();
  });

  app.on('before-quit', (event) => {
    quitting = true;
    if (shuttingDown || !backendProc) {
      return;
    }
    // Hold the quit until the backend has been shut down gracefully (or
    // force-killed after the 7s budget) so SQLite is never left half-written.
    event.preventDefault();
    shuttingDown = true;
    void requestGracefulShutdown()
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.warn(`[main] backend shutdown failed: ${String(error)}`);
      })
      .finally(() => {
        app.quit();
      });
  });

  app.whenReady().then(() => {
    main().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[main] failed to start:', err);
      app.quit();
    });
  });
}
