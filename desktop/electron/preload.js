'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit bridge. Nothing from Node or Electron internals is exposed:
// the renderer may only ask the main process to restart or copy the URL.
contextBridge.exposeInMainWorld('desktopBridge', {
  isDesktop: true,
  restartBackend: () => ipcRenderer.invoke('desktop:restart-backend'),
  copyDashboardUrl: () => ipcRenderer.invoke('desktop:copy-url'),
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
});
