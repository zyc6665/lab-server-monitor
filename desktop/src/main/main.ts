/**
 * Electron main process for the single-stack build: spawns the bundled Node
 * backend through `utilityProcess`, waits for the runtime handshake file,
 * then loads the backend URL in a BrowserWindow. Adds a tray icon and a
 * single-instance lock. Legacy `electron/main.js` is untouched; this entry
 * is built to `dist/main.cjs` and launched via `pnpm start:scaffold`.
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
} from 'electron';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';

import { resolveInstallDir, resolveDataDir, logsDir } from './paths';
import {
  waitForRuntime,
  nextRetryDelay,
  type RuntimeInfo,
} from './backend-process';

type BackendProcess = ReturnType<typeof utilityProcess.fork>;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let backendProc: BackendProcess | null = null;
let retryAttempt = 0;
let quitting = false;
let currentUrl = '';

const localAppData = process.env.LOCALAPPDATA ?? '';
const existsDrive = (d: string): boolean => existsSync(d + '\\');
const readDataDirPointer = (): string | null => null; // P0 stub; P6 wires real HKCU.

const installDir = resolveInstallDir({ existsDrive, localAppData });
const dataDir = resolveDataDir({
  installDir,
  existsDrive,
  localAppData,
  readDataDirPointer,
});
mkdirSync(dataDir, { recursive: true });
mkdirSync(logsDir(dataDir), { recursive: true });

const runtimePath = join(dataDir, 'runtime.json');

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

function spawnBackend(): void {
  const entry = backendEntry();
  backendProc = utilityProcess.fork(
    entry,
    ['--port', '0', '--runtime', runtimePath],
    { stdio: 'pipe', serviceName: 'servermonitor-backend' },
  );
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
      void launchBackend();
    }, delay);
    // eslint-disable-next-line no-console
    console.warn(`[backend] exited with code ${code}; restarting in ${delay}ms`);
  });
}

async function launchBackend(): Promise<RuntimeInfo> {
  rmSync(runtimePath, { force: true });
  spawnBackend();
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
  w.once('ready-to-show', () => w.show());
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
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setToolTip('实验室服务器轮询维护');
  tray.setContextMenu(menu);
  tray.on('double-click', () => showWindow());
}

async function main(): Promise<void> {
  win = createWindow();
  createTray();
  const rt = await launchBackend();
  await win.loadURL(rt.url);
}

// Single-instance lock: a second launch focuses the existing window instead of
// starting another backend.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  app.on('window-all-closed', () => {
    // Resident in the tray: do not quit when the window is closed.
  });

  app.on('before-quit', () => {
    quitting = true;
    backendProc?.kill();
  });

  app.whenReady().then(() => {
    main().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[main] failed to start:', err);
      app.quit();
    });
  });
}
