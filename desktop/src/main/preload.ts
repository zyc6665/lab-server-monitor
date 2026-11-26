/**
 * Renderer bridge for the single-stack desktop shell.
 *
 * Exposes `window.desktopBridge` (contract inherited from the removed legacy
 * `desktop/electron/preload.js`) so `backend/assets/web/static/settings-update.js`
 * can drive electron-updater through the `update:*` IPC channels registered in
 * `./updater.ts`. Nothing from Node or Electron internals leaks to the page.
 */
import { contextBridge, ipcRenderer } from 'electron';

function subscribe(channel: string, callback: (payload: unknown) => void): () => void {
  const listener = (_event: unknown, payload: unknown) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const update = {
  check: (force?: boolean) => ipcRenderer.invoke('update:check', Boolean(force)),
  download: () => ipcRenderer.invoke('update:download'),
  install: () => ipcRenderer.invoke('update:install'),
  onStatus: (callback: (payload: unknown) => void) => subscribe('update:status', callback),
};

contextBridge.exposeInMainWorld('desktopBridge', {
  isDesktop: true,
  windowAction: (action: 'minimize' | 'maximize' | 'close') =>
    ipcRenderer.invoke('window:action', action),
  checkForUpdate: (force?: boolean) => ipcRenderer.invoke('update:check', Boolean(force)),
  downloadUpdate: (payload?: unknown) => ipcRenderer.invoke('update:download', payload),
  installUpdate: (payload?: unknown) => ipcRenderer.invoke('update:install', payload),
  onUpdateStatus: (callback: (payload: unknown) => void) => subscribe('update:status', callback),
  update,
});
