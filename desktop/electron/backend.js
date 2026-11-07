'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { backendPath, configPath, dotenvPath, dataDir, logsDir } = require('./paths.js');

const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_STOP_TIMEOUT_MS = 3000;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function formatTimestamp(ms) {
  return new Date(ms).toISOString();
}

/**
 * Create a controller that owns the Python backend sidecar process.
 *
 * The controller is intentionally dependency-injected (`spawnImpl`, `fsImpl`,
 * `clock`, `delay`) so the lifecycle logic can be unit-tested without spawning
 * real processes or touching the real filesystem.
 *
 * @param {{
 *   appDir: string,
 *   spawnImpl?: Function,
 *   fsImpl?: object,
 *   logger?: object,
 *   startupTimeoutMs?: number,
 *   pollIntervalMs?: number,
 *   stopTimeoutMs?: number,
 *   onUnexpectedExit?: (code: number|null, signal: string|null) => void,
 *   executablePath?: string,
 *   isPackaged?: boolean,
 *   env?: object,
 *   clock?: {now: Function, setTimeout: Function, clearTimeout: Function},
 *   delay?: (ms: number) => Promise<void>,
 * }} options
 */
function createBackendController(options = {}) {
  const {
    appDir,
    spawnImpl = childProcess.spawn,
    fsImpl = fs,
    logger = console,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    onUnexpectedExit = null,
    executablePath,
    isPackaged = false,
    env = process.env,
    clock = {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
    },
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  if (!isNonEmptyString(appDir)) {
    throw new TypeError('appDir must be a non-empty string');
  }

  const configFile = configPath(appDir);
  const dotenvFile = dotenvPath(appDir);
  const runtimeFile = path.join(dataDir(appDir), 'runtime.json');
  const logFile = path.join(logsDir(appDir), 'desktop.log');
  const command = executablePath || backendPath({ isPackaged, appDir });

  let child = null;
  let running = false;
  let stopping = false;
  let currentExit = null;

  function ensureLogsDir() {
    try {
      fsImpl.mkdirSync(logsDir(appDir), { recursive: true });
    } catch (error) {
      logger.warn?.('failed to create logs directory', error);
    }
  }

  function writeLog(streamName, chunk) {
    const timestamp = formatTimestamp(clock.now());
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const lines = text.split(/\r?\n/);
    const payloadLines = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (index === lines.length - 1 && line === '') {
        continue;
      }
      payloadLines.push(`${timestamp} [${streamName}] ${line}`);
    }
    if (payloadLines.length === 0) {
      return;
    }
    ensureLogsDir();
    try {
      fsImpl.appendFileSync(logFile, `${payloadLines.join('\n')}\n`);
    } catch (error) {
      logger.error?.('failed to append to desktop.log', error);
    }
  }

  function buildArgs() {
    const args = ['--headless', '--parent-stdin', '--config', configFile];
    let hasDotenv = false;
    try {
      hasDotenv = Boolean(fsImpl.existsSync(dotenvFile));
    } catch (error) {
      hasDotenv = false;
    }
    if (hasDotenv) {
      args.push('--dotenv', dotenvFile);
    }
    return args;
  }

  /**
   * Remove any runtime.json left behind by a previous run. Without this a
   * restart or a second launch could read the stale port of an earlier
   * backend (especially when `auto_port_fallback` picks a different port).
   */
  function clearRuntimeFile() {
    let exists = false;
    try {
      exists = Boolean(fsImpl.existsSync?.(runtimeFile));
    } catch (error) {
      exists = false;
    }
    if (!exists && typeof fsImpl.rmSync !== 'function') {
      return;
    }
    try {
      if (typeof fsImpl.rmSync === 'function') {
        fsImpl.rmSync(runtimeFile, { force: true });
      } else if (typeof fsImpl.unlinkSync === 'function') {
        try {
          fsImpl.unlinkSync(runtimeFile);
        } catch (error) {
          if (!error || error.code !== 'ENOENT') {
            throw error;
          }
        }
      }
    } catch (error) {
      logger.warn?.('failed to clear stale runtime.json', error);
    }
  }

  function handleExit(proc, code, signal, error = null) {
    const wasCurrent = child === proc;
    if (wasCurrent) {
      child = null;
      running = false;
      currentExit = {
        code: code ?? null,
        signal: signal ?? null,
        error: error ? String(error.message || error) : null,
      };
    }
    writeLog('exit', `backend exited (code=${code}, signal=${signal})`);
    const expected = stopping;
    if (wasCurrent) {
      stopping = false;
    }
    if (wasCurrent && !expected) {
      logger.error?.(`backend exited unexpectedly (code=${code}, signal=${signal})`);
      if (typeof onUnexpectedExit === 'function') {
        try {
          onUnexpectedExit(code ?? null, signal ?? null);
        } catch (callbackError) {
          logger.error?.('onUnexpectedExit threw', callbackError);
        }
      }
    }
  }

  function start() {
    if (child) {
      return Promise.reject(new Error('Backend process is already running'));
    }
    ensureLogsDir();
    clearRuntimeFile();

    const args = buildArgs();
    const spawnOptions = {
      cwd: appDir,
      env: { ...env, PYTHONIOENCODING: 'utf-8', SERVERMONITOR_DESKTOP: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    };

    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawnImpl(command, args, spawnOptions);
      } catch (error) {
        reject(error);
        return;
      }
      if (!proc || typeof proc.once !== 'function') {
        reject(new TypeError('spawnImpl must return a ChildProcess-like object'));
        return;
      }

      child = proc;
      stopping = false;
      currentExit = null;
      let settled = false;
      let exitHandled = false;

      const onExit = (code, signal) => {
        if (exitHandled) {
          return;
        }
        exitHandled = true;
        handleExit(proc, code, signal);
      };

      proc.once('exit', onExit);
      proc.once('error', (error) => {
        if (!settled) {
          settled = true;
          child = null;
          running = false;
          try {
            proc.removeListener?.('exit', onExit);
          } catch (removeError) {
            logger.warn?.('failed to remove exit listener after spawn error', removeError);
          }
          reject(error);
          return;
        }
        writeLog('error', `backend process error: ${error && error.message ? error.message : error}`);
        logger.error?.('backend process error', error);
        if (!exitHandled) {
          exitHandled = true;
          handleExit(proc, null, null, error);
        }
      });
      proc.once('spawn', () => {
        if (settled) {
          return;
        }
        settled = true;
        running = true;
        logger.info?.(`backend started (pid=${proc.pid})`);
        resolve(proc);
      });

      if (proc.stdout && typeof proc.stdout.on === 'function') {
        proc.stdout.on('data', (chunk) => writeLog('stdout', chunk));
      }
      if (proc.stderr && typeof proc.stderr.on === 'function') {
        proc.stderr.on('data', (chunk) => writeLog('stderr', chunk));
      }
    });
  }

  async function waitForRuntime() {
    const deadline = clock.now() + startupTimeoutMs;
    let lastError = null;
    for (;;) {
      try {
        const raw = fsImpl.readFileSync(runtimeFile, 'utf8');
        const data = JSON.parse(raw);
        const port = typeof data.port === 'number' ? data.port : Number(data.port);
        if (data && isNonEmptyString(data.url) && Number.isFinite(port)) {
          return { url: data.url, port };
        }
        lastError = new Error('runtime.json exists but does not contain a valid url/port');
      } catch (error) {
        lastError = error;
      }
      if (currentExit) {
        const details = [`code=${currentExit.code}`, `signal=${currentExit.signal}`];
        if (currentExit.error) {
          details.push(`error=${currentExit.error}`);
        }
        throw new Error(
          `Backend process exited before runtime was ready (${details.join(', ')})`,
        );
      }
      if (clock.now() >= deadline) {
        const detail =
          lastError && lastError.code !== 'ENOENT' ? ` (last error: ${lastError.message})` : '';
        throw new Error(
          `Timed out waiting for backend runtime at ${runtimeFile} after ${startupTimeoutMs}ms${detail}`,
        );
      }
      await delay(pollIntervalMs);
    }
  }

  function waitForExit(proc, timeoutMs) {
    return new Promise((resolve) => {
      if (proc.exitCode !== null && proc.exitCode !== undefined) {
        resolve('exited');
        return;
      }
      let done = false;
      let timerId = null;
      const finish = (reason) => {
        if (done) {
          return;
        }
        done = true;
        if (timerId !== null) {
          try {
            clock.clearTimeout(timerId);
          } catch (clearError) {
            logger.warn?.('failed to clear stop timer', clearError);
          }
        }
        try {
          proc.removeListener?.('exit', onExit);
        } catch (removeError) {
          logger.warn?.('failed to remove exit listener after stop', removeError);
        }
        resolve(reason);
      };
      const onExit = () => finish('exited');
      proc.once('exit', onExit);
      timerId = clock.setTimeout(() => finish('timeout'), timeoutMs);
    });
  }

  function runTaskkill(proc) {
    const pid = proc && proc.pid;
    if (pid === null || pid === undefined) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) {
          return;
        }
        done = true;
        resolve();
      };
      try {
        const killer = spawnImpl(
          'taskkill',
          ['/pid', String(pid), '/t', '/f'],
          { windowsHide: true, stdio: 'ignore' },
        );
        if (killer && typeof killer.once === 'function') {
          killer.once('exit', finish);
          killer.once('close', finish);
          killer.once('error', finish);
        } else {
          finish();
        }
      } catch (error) {
        logger.warn?.('failed to spawn taskkill', error);
        finish();
      }
    });
  }

  async function stop() {
    const proc = child;
    if (!proc) {
      running = false;
      return;
    }

    stopping = true;
    try {
      if (proc.stdin && typeof proc.stdin.end === 'function') {
        proc.stdin.end();
      }
    } catch (error) {
      logger.warn?.('failed to close backend stdin', error);
    }

    let result = 'exited';
    try {
      result = await waitForExit(proc, stopTimeoutMs);
    } catch (error) {
      logger.warn?.('error while waiting for backend to exit', error);
    }

    if (result === 'timeout') {
      logger.warn?.(`backend did not exit within ${stopTimeoutMs}ms; running taskkill`);
      await runTaskkill(proc);
    }

    if (child === proc) {
      child = null;
      running = false;
    }
    stopping = false;
  }

  async function restart() {
    await stop();
    await start();
    return waitForRuntime();
  }

  function isRunning() {
    return running && Boolean(child);
  }

  return {
    start,
    waitForRuntime,
    stop,
    restart,
    isRunning,
    get pid() {
      return child ? child.pid : null;
    },
  };
}

module.exports = { createBackendController };
