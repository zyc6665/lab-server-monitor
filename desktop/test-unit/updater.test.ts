import { describe, it, expect } from 'vitest';
import {
  createUpdater,
  type AutoUpdaterLike,
  type IpcMainLike,
  type UpdaterEvent,
} from '../src/main/updater';

/** In-memory stand-in for `electron-updater`'s AutoUpdater. */
class FakeAutoUpdater implements AutoUpdaterLike {
  autoDownload = true;
  allowPrerelease = true;
  checkResult: unknown = null;
  checkError: Error | null = null;
  downloadError: Error | null = null;
  quitError: Error | null = null;
  downloadCalls = 0;
  quitArgs: Array<[boolean?, boolean?]> = [];
  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): this {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
    return this;
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    const arr = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      arr.filter((l) => l !== listener),
    );
    return this;
  }

  listenerCount(event: string): number {
    return (this.listeners.get(event) ?? []).length;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  async checkForUpdates(): Promise<unknown> {
    if (this.checkError) throw this.checkError;
    return this.checkResult;
  }

  async downloadUpdate(): Promise<unknown> {
    this.downloadCalls += 1;
    if (this.downloadError) throw this.downloadError;
    return null;
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    if (this.quitError) throw this.quitError;
    this.quitArgs.push([isSilent, isForceRunAfter]);
  }
}

/** In-memory stand-in for Electron's ipcMain. */
class FakeIpcMain implements IpcMainLike {
  handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();

  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  invoke(channel: string, ...args: any[]): unknown {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no handler registered for ${channel}`);
    return handler({}, ...args);
  }
}

function setup(currentVersion = '0.1.239', logDir?: string) {
  const autoUpdater = new FakeAutoUpdater();
  const ipcMain = new FakeIpcMain();
  const events: UpdaterEvent[] = [];
  const control = createUpdater({
    autoUpdater,
    currentVersion,
    ipcMain,
    logDir,
    notify: (event) => events.push(event),
  });
  return { autoUpdater, ipcMain, events, control };
}

describe('createUpdater wiring', () => {
  it('forces autoDownload and allowPrerelease off', () => {
    const { autoUpdater } = setup();
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.allowPrerelease).toBe(false);
  });

  it('registers update:check / update:download / update:install IPC handlers', () => {
    const { ipcMain } = setup();
    expect([...ipcMain.handlers.keys()].sort()).toEqual([
      'update:check',
      'update:download',
      'update:install',
    ]);
  });
});

describe('update:check', () => {
  it('reports update-available for a newer same-major version', async () => {
    const { autoUpdater, ipcMain } = setup();
    autoUpdater.checkResult = { updateInfo: { version: '0.1.240' } };
    const result = await ipcMain.invoke('update:check');
    expect(result).toMatchObject({ status: 'update-available', version: '0.1.240' });
  });

  it('reports up-to-date when the version is not newer', async () => {
    const { autoUpdater, ipcMain } = setup();
    autoUpdater.checkResult = { updateInfo: { version: '0.1.239' } };
    await expect(ipcMain.invoke('update:check')).resolves.toMatchObject({ status: 'up-to-date' });
  });

  it('reports up-to-date (not update-available) across a major mismatch', async () => {
    const { autoUpdater, ipcMain } = setup();
    autoUpdater.checkResult = { updateInfo: { version: '1.6.1' } };
    const result = (await ipcMain.invoke('update:check')) as UpdaterEvent;
    expect(result.status).toBe('up-to-date');
    expect(result.version).toBe('1.6.1');
  });

  it('reports up-to-date when checkForUpdates resolves null', async () => {
    const { autoUpdater, ipcMain } = setup();
    autoUpdater.checkResult = null;
    const result = (await ipcMain.invoke('update:check')) as UpdaterEvent;
    expect(result).toMatchObject({ status: 'up-to-date', version: '0.1.239' });
  });

  it('carries legacy {ok, result} aliases for the existing settings UI', async () => {
    const { autoUpdater, ipcMain } = setup();
    autoUpdater.checkResult = { updateInfo: { version: '0.1.240' } };
    const result = (await ipcMain.invoke('update:check')) as UpdaterEvent & {
      ok: boolean;
      result: { status: string; version?: string; current_version?: string };
    };
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      status: 'update-available',
      version: '0.1.240',
      current_version: '0.1.239',
    });
  });

  it('returns {status:error} instead of throwing when the check rejects', async () => {
    const { autoUpdater, ipcMain } = setup();
    autoUpdater.checkError = new Error('network down');
    const result = (await ipcMain.invoke('update:check')) as UpdaterEvent & { ok: boolean };
    expect(result).toMatchObject({ status: 'error', error: 'network down', ok: false });
  });

  it('emits a checking event before the final status', async () => {
    const { autoUpdater, ipcMain, events } = setup();
    autoUpdater.checkResult = { updateInfo: { version: '0.1.240' } };
    await ipcMain.invoke('update:check');
    expect(events[0]).toEqual({ status: 'checking' });
    expect(events.some((e) => e.status === 'update-available')).toBe(true);
  });
});

describe('update:download', () => {
  it('calls downloadUpdate and reports downloaded', async () => {
    const { autoUpdater, ipcMain } = setup();
    const result = (await ipcMain.invoke('update:download')) as UpdaterEvent;
    expect(result.status).toBe('downloaded');
    expect(autoUpdater.downloadCalls).toBe(1);
  });

  it('returns {status:error} instead of throwing when download rejects', async () => {
    const { autoUpdater, ipcMain } = setup();
    autoUpdater.downloadError = new Error('disk full');
    const result = (await ipcMain.invoke('update:download')) as UpdaterEvent;
    expect(result).toMatchObject({ status: 'error', error: 'disk full' });
  });
});

describe('update:install', () => {
  it('calls quitAndInstall(false, true) and reports installing', async () => {
    const { autoUpdater, ipcMain } = setup();
    const result = (await ipcMain.invoke('update:install')) as UpdaterEvent;
    expect(result.status).toBe('installing');
    expect(autoUpdater.quitArgs).toEqual([[false, true]]);
  });

  it('returns {status:error} instead of throwing when quitAndInstall throws', async () => {
    const { autoUpdater, ipcMain } = setup();
    autoUpdater.quitError = new Error('cannot quit');
    const result = (await ipcMain.invoke('update:install')) as UpdaterEvent;
    expect(result).toMatchObject({ status: 'error', error: 'cannot quit' });
  });
});

describe('event forwarding', () => {
  it('forwards download-progress as a downloading event with percent', () => {
    const { autoUpdater, events } = setup();
    autoUpdater.emit('download-progress', {
      percent: 42.5,
      transferred: 100,
      total: 200,
      bytesPerSecond: 10,
    });
    expect(events.at(-1)).toMatchObject({ status: 'downloading', percent: 42.5 });
  });

  it('forwards update-available events', () => {
    const { autoUpdater, events } = setup();
    autoUpdater.emit('update-available', { version: '0.1.240' });
    expect(events.at(-1)).toEqual({ status: 'update-available', version: '0.1.240' });
  });

  it('forwards error events with a message', () => {
    const { autoUpdater, events } = setup();
    autoUpdater.emit('error', new Error('boom'));
    expect(events.at(-1)).toEqual({ status: 'error', error: 'boom' });
  });

  it('survives a throwing notify sink', async () => {
    const autoUpdater = new FakeAutoUpdater();
    const ipcMain = new FakeIpcMain();
    createUpdater({
      autoUpdater,
      currentVersion: '0.1.239',
      ipcMain,
      notify: () => {
        throw new Error('sink down');
      },
    });
    autoUpdater.checkResult = { updateInfo: { version: '0.1.240' } };
    await expect(ipcMain.invoke('update:check')).resolves.toMatchObject({
      status: 'update-available',
    });
  });
});

describe('dispose', () => {
  it('removes handlers/listeners through the returned control', () => {
    const { autoUpdater, ipcMain, control } = setup();
    expect(ipcMain.handlers.size).toBe(3);
    expect(autoUpdater.listenerCount('update-available')).toBe(1);
    control.dispose();
    expect(ipcMain.handlers.size).toBe(0);
    expect(autoUpdater.listenerCount('update-available')).toBe(0);
    expect(autoUpdater.listenerCount('download-progress')).toBe(0);
  });
});

describe('failure diagnostics (M11)', () => {
  const LOG_DIR = 'D:\\ServerMonitorData\\logs';

  it('appends the logs directory to check failures without changing the IPC shape', async () => {
    const { autoUpdater, ipcMain, events } = setup('0.1.239', LOG_DIR);
    autoUpdater.checkError = new Error('network down');

    const result = (await ipcMain.invoke('update:check')) as UpdaterEvent & {
      ok: boolean;
      result: { status: string; error?: string };
    };

    expect(result.status).toBe('error');
    expect(result.error).toContain('network down');
    expect(result.error).toContain(`日志：${LOG_DIR}`);
    // Notify sink carries the same diagnostic.
    expect(events.at(-1)?.error).toContain(`日志：${LOG_DIR}`);
    // Payload keys are unchanged (only the error text got richer).
    expect(Object.keys(result).sort()).toEqual(['error', 'ok', 'result', 'status']);
    expect(Object.keys(result.result).sort()).toEqual(['current_version', 'error', 'status']);
  });

  it('appends the logs directory to download failures', async () => {
    const { autoUpdater, ipcMain, events } = setup('0.1.239', LOG_DIR);
    autoUpdater.downloadError = new Error('disk full');

    const result = (await ipcMain.invoke('update:download')) as UpdaterEvent;

    expect(result.status).toBe('error');
    expect(result.error).toContain('disk full');
    expect(result.error).toContain(`日志：${LOG_DIR}`);
    expect(events.at(-1)?.error).toBe(result.error);
  });

  it('appends the logs directory to forwarded autoUpdater error events', () => {
    const { autoUpdater, events } = setup('0.1.239', LOG_DIR);
    autoUpdater.emit('error', new Error('boom'));
    expect(events.at(-1)?.error).toBe(`boom\n日志：${LOG_DIR}`);
  });

  it('keeps the plain message when no log dir is injected', async () => {
    const { autoUpdater, ipcMain } = setup();
    autoUpdater.checkError = new Error('network down');
    const result = (await ipcMain.invoke('update:check')) as UpdaterEvent;
    expect(result.error).toBe('network down');
  });
});
