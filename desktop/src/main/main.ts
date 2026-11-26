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
  dialog,
} from 'electron';
import { get as httpGet } from 'node:http';
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
  createTrayGuard,
  applyLoginItem,
} from './lifecycle';
import { createUpdater, type AutoUpdaterLike, type UpdaterControl } from './updater';
import { loadAppIcon } from './icon';
import { latestCrashLog, pruneCrashLogs, writeCrashLog, type CrashEntry } from './crash-log';
import { runStartupChecks } from './startup-check';

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

/**
 * Logs directory for crash reports.
 *
 * Normally `paths.logsDir(dataDir)`. Before {@link initDataDir} has run (e.g. a
 * crash in an early `whenReady` handler) `dataDir` is still empty, so fall back
 * to Electron's per-user logs directory. Never throws: this runs inside crash
 * handlers.
 */
function crashLogsDir(): string {
  if (dataDir) {
    return logsDir(dataDir);
  }
  try {
    return app.getPath('logs');
  } catch {
    return logsDir(process.cwd());
  }
}

function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message || error.name, stack: error.stack };
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message);
    const stack = (error as { stack?: unknown }).stack;
    return { message, stack: typeof stack === 'string' ? stack : undefined };
  }
  return { message: String(error) };
}

/**
 * Persist a crash entry and prune old logs. Never throws — we may already be
 * unwinding from a fatal error, and the app must keep running / quitting
 * cleanly even when the disk is full or the logs directory is unwritable.
 */
function recordCrash(entry: Omit<CrashEntry, 'at'>): void {
  const dir = crashLogsDir();
  let written: string | null = null;
  try {
    written = writeCrashLog(dir, { ...entry, at: new Date() });
  } catch {
    written = null;
  }
  try {
    pruneCrashLogs(dir, 20);
  } catch {
    /* pruning is best-effort */
  }
  if (written) {
    // eslint-disable-next-line no-console
    console.error(`[crash] ${entry.kind}: ${entry.message}（日志：${written}）`);
  } else {
    // eslint-disable-next-line no-console
    console.error(`[crash] ${entry.kind}: ${entry.message}（无法写入崩溃日志：${dir}）`);
  }
}

/**
 * Register process-level crash handlers as early as possible (before `ready`)
 * so exceptions thrown during startup are still recorded. The app stays
 * resident in the tray instead of vanishing: a renderer/backend problem should
 * not take the whole dashboard down.
 */
function installCrashHandlers(): void {
  process.on('uncaughtException', (error) => {
    const { message, stack } = describeError(error);
    recordCrash({ kind: 'uncaughtException', message, stack });
  });
  process.on('unhandledRejection', (reason) => {
    const { message, stack } = describeError(reason);
    recordCrash({ kind: 'unhandledRejection', message, stack });
  });
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
    // Tells the backend it is hosted by the desktop shell so pages render
    // desktop-only UI (e.g. the 软件更新 / 检查更新 section).
    env: { ...process.env, SERVERMONITOR_DESKTOP: '1' },
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
    // The page renders its own title bar (servermanage base.html `#app-titlebar`)
    // with working window controls, so the OS frame must be off — otherwise the
    // user sees two stacked title bars and an extra default menu.
    frame: false,
    autoHideMenuBar: true,
    // Window/taskbar icon: packaged `resources/icon.ico`, dev `desktop/build/icon.ico`.
    icon: loadAppIcon() ?? undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  w.once('ready-to-show', () => {
    // `--start-hidden` keeps the window invisible (tray only); the tray
    // double-click / second-instance handler still restores it on demand.
    if (shouldShowWindow({ startHidden: START_HIDDEN })) {
      w.show();
    }
  });
  w.on('close', (e) => {
    // While the app is quitting (tray 退出 / update install), let the window
    // actually close — otherwise Electron's quit sequence stalls and the app
    // stays resident in the tray forever. A normal close just hides to tray.
    if (quitting) {
      return;
    }
    e.preventDefault();
    w.hide();
  });
  return w;
}

const trayGuard = createTrayGuard(() => buildTray());

/** Idempotent: at most one Tray is ever constructed per process. */
function createTray(): void {
  tray = trayGuard.ensure();
}

function buildTray(): Tray {
  const appIcon = loadAppIcon();
  const tray = new Tray(appIcon ?? nativeImage.createEmpty());
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
        const dir = crashLogsDir();
        // The directory normally exists (created by initDataDir); re-create it
        // here so the menu still works after a user deletes it by hand.
        try {
          mkdirSync(dir, { recursive: true });
        } catch {
          /* shell.openPath reports the failure to the user below */
        }
        void shell.openPath(dir);
      },
    },
    {
      label: '打开最近崩溃日志',
      click: () => {
        const dir = crashLogsDir();
        try {
          mkdirSync(dir, { recursive: true });
        } catch {
          /* fall through: openPath will surface the problem */
        }
        const latest = latestCrashLog(dir);
        if (latest) {
          // Select the newest crash log in Explorer so it is obvious which file
          // to attach to a bug report.
          shell.showItemInFolder(latest);
          return;
        }
        // No crash recorded yet: opening the directory is more useful than a
        // silent no-op.
        void shell.openPath(dir);
      },
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        applyLoginItem(app, item.checked);
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setToolTip('实验室服务器轮询维护');
  tray.setContextMenu(menu);
  tray.on('double-click', () => showWindow());
  return tray;
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
      logDir: logsDir(dataDir),
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

/** Wire the custom title bar's window buttons (minimize/maximize/close). */
function registerWindowControls(): void {
  ipcMain.handle('window:action', (event, action: unknown) => {
    const target = BrowserWindow.fromWebContents(event.sender) ?? win;
    if (!target) {
      return { ok: false };
    }
    switch (action) {
      case 'minimize':
        target.minimize();
        break;
      case 'maximize':
        if (target.isMaximized()) {
          target.unmaximize();
        } else {
          target.maximize();
        }
        break;
      case 'close':
        target.close();
        break;
      default:
        return { ok: false };
    }
    return { ok: true, maximized: target.isMaximized() };
  });
}

/**
 * Backend liveness probe used by the startup self-check.
 *
 * Any HTTP response (even 401/428 from the auth/setup middleware) proves the
 * backend is serving; only a connection error/timeout counts as unhealthy.
 */
function probeBackend(url: string): Promise<boolean> {
  const healthUrl = `${url.replace(/\/+$/, '')}/api/system/health`;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (healthy: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(healthy);
    };
    try {
      const request = httpGet(healthUrl, (response) => {
        response.resume();
        response.on('end', () => finish(true));
        response.on('error', () => finish(false));
      });
      request.on('error', () => finish(false));
      request.setTimeout(2000, () => {
        request.destroy();
        finish(false);
      });
    } catch {
      finish(false);
    }
  });
}

async function main(): Promise<void> {
  // No native application menu — the in-page title bar is the only chrome.
  Menu.setApplicationMenu(null);
  registerWindowControls();
  initDataDir();
  const importLegacy = computeImportLegacy();

  win = createWindow();
  createTray();
  initUpdater();

  const rt = await launchBackend(importLegacy);
  // M11 startup self-check: run once after the backend answered its runtime
  // handshake, in parallel with the first page load. `port` is intentionally
  // omitted — the backend is launched with `--port 0` (OS-assigned), so there
  // is no pre-known port to probe and probing our own port would false-alarm.
  const logDir = logsDir(dataDir);
  const [selfCheck] = await Promise.all([
    runStartupChecks({
      dataDir,
      health: () => probeBackend(rt.url),
      logDir,
      retries: 3,
      delayMs: 500,
    }),
    win.loadURL(rt.url),
  ]);
  if (!selfCheck.ok) {
    recordCrash({ kind: 'startup-check', message: selfCheck.failures.join('；') });
    dialog.showErrorBox(
      '启动自检失败',
      `${selfCheck.failures.join('\n')}\n日志目录：${logDir}`,
    );
  }
}

// Single-instance lock: a second launch focuses the existing window instead of
// starting another backend. `--start-hidden` on the primary does not stop a
// later manual launch from surfacing the window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  installCrashHandlers();

  app.on('second-instance', () => {
    showWindow();
  });

  // Renderer crash: keep the main process alive (the window can be reloaded or
  // recreated) but leave a crash log with the Chromium reason for diagnosis.
  app.on('render-process-gone', (_event, _webContents, details) => {
    recordCrash({
      kind: 'render-process-gone',
      message: `reason=${details.reason} exitCode=${details.exitCode}`,
    });
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
    // Hard guarantee: even if graceful shutdown wedges, exit within budget so
    // 退出 and update-install always terminate the app.
    const forceExit = setTimeout(() => app.exit(0), 8500);
    void requestGracefulShutdown()
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.warn(`[main] backend shutdown failed: ${String(error)}`);
      })
      .finally(() => {
        clearTimeout(forceExit);
        app.exit(0);
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
