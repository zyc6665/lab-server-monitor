import * as path from 'node:path';

/**
 * Resolve the installation directory for the desktop application.
 * Prefers D:\Tools\ServerMonitor when a D: drive exists; otherwise falls
 * back to %LOCALAPPDATA%\Programs\ServerMonitor.
 */
export function resolveInstallDir(opts: {
  existsDrive: (d: string) => boolean;
  localAppData: string;
}): string {
  if (opts.existsDrive('D:')) {
    return 'D:\\Tools\\ServerMonitor';
  }
  return path.join(opts.localAppData, 'Programs', 'ServerMonitor');
}

/**
 * Resolve the data directory. A non-empty pointer value always wins.
 * Otherwise prefer D:\ServerMonitorData when a D: drive exists, else
 * %LOCALAPPDATA%\ServerMonitor.
 */
export function resolveDataDir(opts: {
  installDir: string;
  existsDrive: (d: string) => boolean;
  localAppData: string;
  readDataDirPointer: () => string | null;
}): string {
  const pointer = opts.readDataDirPointer();
  if (pointer) {
    return pointer;
  }
  if (opts.existsDrive('D:')) {
    return 'D:\\ServerMonitorData';
  }
  return path.join(opts.localAppData, 'ServerMonitor');
}

/** Resolve the logs directory under a data directory. */
export function logsDir(dataDir: string): string {
  return path.join(dataDir, 'logs');
}
