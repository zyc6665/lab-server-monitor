'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit bridge. Nothing from Node or Electron internals is exposed:
// the renderer may only ask the main process to restart, copy the URL, or drive
// the updater.
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Grouped updater surface (P6 Task3). `check`/`download`/`install` return
// `{ status, version?, error? }`; `onStatus` streams lifecycle events
// (`checking`/`downloading`/`update-available`/`downloaded`/`error`…).
const update = {
  check: (force) => ipcRenderer.invoke('update:check', Boolean(force)),
  download: () => ipcRenderer.invoke('update:download'),
  install: () => ipcRenderer.invoke('update:install'),
  onStatus: (callback) => subscribe('update:status', callback),
};

contextBridge.exposeInMainWorld('desktopBridge', {
  isDesktop: true,
  restartBackend: () => ipcRenderer.invoke('desktop:restart-backend'),
  copyDashboardUrl: () => ipcRenderer.invoke('desktop:copy-url'),
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  // Legacy flat updater fields kept unchanged for the existing settings UI.
  checkForUpdate: (force) => ipcRenderer.invoke('update:check', Boolean(force)),
  downloadUpdate: (payload) => ipcRenderer.invoke('update:download', payload),
  installUpdate: (payload) => ipcRenderer.invoke('update:install', payload),
  onBackendState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('desktop:backend-state', listener);
    return () => ipcRenderer.removeListener('desktop:backend-state', listener);
  },
  onUpdateStatus: (callback) => subscribe('update:status', callback),
  // Grouped updater surface (P6 Task3).
  update,
});
