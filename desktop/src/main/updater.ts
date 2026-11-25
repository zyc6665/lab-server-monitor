/**
 * `electron-updater` integration for the single-stack desktop app.
 *
 * `createUpdater` wires the injected `autoUpdater` (the real `electron-updater`
 * `autoUpdater` in production, a fake in tests) to the three IPC channels the
 * renderer uses — `update:check`, `update:download`, `update:install` — and
 * forwards the autoUpdater lifecycle events to an optional `notify` sink.
 *
 * Design notes:
 * - `autoUpdater` is *injected* (not imported here) so this module stays free of
 *   Electron/`electron-updater` runtime deps and is unit-testable in plain Node.
 * - Every handler catches its own exceptions and resolves `{ status: 'error',
 *   error }`; nothing is allowed to reject out of an IPC call.
 * - `autoDownload` is forced off so the renderer explicitly drives download and
 *   install; prerelease channels are excluded.
 */

import { isNewer, isSameMajor, normaliseVersion } from './update-policy';

export type UpdaterStatus =
  | 'checking'
  | 'update-available'
  | 'up-to-date'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

/** Payload returned by the IPC handlers and pushed via `notify`. */
export interface UpdaterEvent {
  status: UpdaterStatus;
  version?: string;
  /** Download progress percentage (0–100) when `status === 'downloading'`. */
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  /** Human-readable error message when `status === 'error'`. */
  error?: string;
}

/** Minimal structural view of `electron-updater`'s AutoUpdater. */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  allowPrerelease: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** Minimal structural view of Electron's `ipcMain`. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void;
  removeHandler?(channel: string): void;
}

export interface CreateUpdaterOptions {
  autoUpdater: AutoUpdaterLike;
  currentVersion: string;
  ipcMain: IpcMainLike;
  log?: (message: string) => void;
  /** Sink for lifecycle events (main.ts forwards these to the window). */
  notify?: (event: UpdaterEvent) => void;
  now?: () => number;
}

export interface UpdaterControl {
  check: () => Promise<UpdaterEvent>;
  download: () => Promise<UpdaterEvent>;
  install: () => UpdaterEvent;
  dispose: () => void;
}

const IPC_CHANNELS = ['update:check', 'update:download', 'update:install'] as const;

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function versionOf(info: unknown): string {
  if (info && typeof info === 'object' && 'version' in info) {
    return normaliseVersion((info as { version?: unknown }).version as string);
  }
  return '';
}

export function createUpdater(options: CreateUpdaterOptions): UpdaterControl {
  const { autoUpdater, currentVersion, ipcMain } = options;
  const log = options.log ?? (() => {});
  const notify = options.notify ?? (() => {});

  // Renderer drives download/install explicitly; never auto-download or offer a
  // prerelease channel.
  autoUpdater.autoDownload = false;
  autoUpdater.allowPrerelease = false;

  let disposed = false;

  function emit(event: UpdaterEvent): void {
    if (disposed) return;
    try {
      notify(event);
    } catch (error) {
      // A broken notify sink must never break the update flow.
      log(`update notify failed: ${toMessage(error)}`);
    }
  }

  async function check(): Promise<UpdaterEvent> {
    emit({ status: 'checking' });
    try {
      const result = await autoUpdater.checkForUpdates();
      const info = result && typeof result === 'object' ? (result as { updateInfo?: unknown }).updateInfo : null;
      const version = versionOf(info);
      if (!version || !isNewer(version, currentVersion) || !isSameMajor(currentVersion, version)) {
        const event: UpdaterEvent = { status: 'up-to-date', version: version || currentVersion };
        emit(event);
        return event;
      }
      const event: UpdaterEvent = { status: 'update-available', version };
      emit(event);
      return event;
    } catch (error) {
      const event: UpdaterEvent = { status: 'error', error: toMessage(error) };
      emit(event);
      return event;
    }
  }

  async function download(): Promise<UpdaterEvent> {
    emit({ status: 'downloading' });
    try {
      await autoUpdater.downloadUpdate();
      const event: UpdaterEvent = { status: 'downloaded' };
      emit(event);
      return event;
    } catch (error) {
      const event: UpdaterEvent = { status: 'error', error: toMessage(error) };
      emit(event);
      return event;
    }
  }

  function install(): UpdaterEvent {
    try {
      // isSilent=false (show installer UI), isForceRunAfter=true (relaunch app).
      autoUpdater.quitAndInstall(false, true);
      const event: UpdaterEvent = { status: 'installing' };
      emit(event);
      return event;
    } catch (error) {
      const event: UpdaterEvent = { status: 'error', error: toMessage(error) };
      emit(event);
      return event;
    }
  }

  // --- Forward autoUpdater lifecycle events to the notify sink -------------
  const registered: Array<[string, (...args: any[]) => void]> = [];
  function bind(event: string, handler: (...args: any[]) => void): void {
    registered.push([event, handler]);
    autoUpdater.on(event, handler);
  }

  bind('update-available', (info: unknown) => {
    emit({ status: 'update-available', version: versionOf(info) });
  });
  bind('update-not-available', (info: unknown) => {
    emit({ status: 'up-to-date', version: versionOf(info) || currentVersion });
  });
  bind('error', (error: unknown) => {
    emit({ status: 'error', error: toMessage(error) });
  });
  bind('download-progress', (progress: unknown) => {
    const p = (progress ?? {}) as Record<string, unknown>;
    emit({
      status: 'downloading',
      percent: typeof p.percent === 'number' ? p.percent : undefined,
      transferred: typeof p.transferred === 'number' ? p.transferred : undefined,
      total: typeof p.total === 'number' ? p.total : undefined,
      bytesPerSecond: typeof p.bytesPerSecond === 'number' ? p.bytesPerSecond : undefined,
    });
  });
  bind('update-downloaded', (info: unknown) => {
    emit({ status: 'downloaded', version: versionOf(info) });
  });

  // --- IPC registration ----------------------------------------------------
  // Results always carry the Task3 contract (`status`, `version?`, `error?`).
  // They additionally carry legacy `ok` / `result` aliases so the existing
  // settings-update.js UI (which checks `response.ok` and reads `response.result`)
  // keeps working through the unchanged flat preload fields.
  ipcMain.handle('update:check', async () => {
    const event = await check();
    return {
      ...event,
      ok: event.status !== 'error',
      result: { ...event, current_version: currentVersion },
    };
  });
  ipcMain.handle('update:download', async () => {
    const event = await download();
    return { ...event, ok: event.status !== 'error' };
  });
  ipcMain.handle('update:install', () => {
    const event = install();
    return { ...event, ok: event.status !== 'error' };
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const [event, handler] of registered) {
      try {
        autoUpdater.removeListener?.(event, handler);
      } catch {
        /* best effort */
      }
    }
    registered.length = 0;
    for (const channel of IPC_CHANNELS) {
      try {
        ipcMain.removeHandler?.(channel);
      } catch {
        /* best effort */
      }
    }
  }

  return { check, download, install, dispose };
}
