'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createBackendController } = require('../electron/backend.js');

const APP_DIR = path.join(path.sep, 'apps', 'servermonitor');
const CONFIG_FILE = path.join(APP_DIR, 'config', 'config.yaml');
const DOTENV_FILE = path.join(APP_DIR, 'config', '.env');
const RUNTIME_FILE = path.join(APP_DIR, 'data', 'runtime.json');
const LOG_FILE = path.join(APP_DIR, 'logs', 'desktop.log');
const EXECUTABLE = path.join(APP_DIR, 'dist', 'backend', 'servermonitor-backend', 'servermonitor-backend.exe');

function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createFakeFs(initialFiles = {}) {
  const files = { ...initialFiles };
  const writes = [];
  const dirs = [];
  return {
    files,
    writes,
    dirs,
    existsSync(filePath) {
      return Object.prototype.hasOwnProperty.call(files, filePath);
    },
    mkdirSync(dirPath) {
      if (!dirs.includes(dirPath)) dirs.push(dirPath);
    },
    appendFileSync(filePath, data) {
      const text = String(data);
      writes.push({ path: filePath, data: text });
      files[filePath] = (files[filePath] || '') + text;
    },
    readFileSync(filePath) {
      if (!Object.prototype.hasOwnProperty.call(files, filePath)) {
        const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
        error.code = 'ENOENT';
        throw error;
      }
      return files[filePath];
    },
    writeFileSync(filePath, data) {
      files[filePath] = String(data);
    },
  };
}

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    ended: false,
    end() {
      this.ended = true;
      if (typeof child.onStdinEnd === 'function') child.onStdinEnd();
    },
  };
  child.exitCode = null;
  child.onStdinEnd = null;
  return child;
}

function createFakeSpawn() {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = createFakeChild();
    child.pid = 5000 + calls.length;
    const record = { command, args, options, child };
    calls.push(record);
    if (command === 'taskkill') {
      setImmediate(() => {
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
    } else {
      setImmediate(() => child.emit('spawn'));
    }
    return child;
  };
  spawnImpl.calls = calls;
  return spawnImpl;
}

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, delayMs) {
      const id = nextId++;
      timers.set(id, { fn, at: now + delayMs });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advance(delayMs) {
      const target = now + delayMs;
      for (;;) {
        let nextIdToRun = null;
        let nextAt = Infinity;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < nextAt) {
            nextAt = timer.at;
            nextIdToRun = id;
          }
        }
        if (nextIdToRun === null) break;
        const timer = timers.get(nextIdToRun);
        timers.delete(nextIdToRun);
        now = timer.at;
        timer.fn();
        await flushAsync();
      }
      now = target;
    },
  };
}

test('start() spawns the backend with the required headless args, cwd and env', async () => {
  const fsImpl = createFakeFs();
  const spawnImpl = createFakeSpawn();
  const controller = createBackendController({
    appDir: APP_DIR,
    executablePath: EXECUTABLE,
    spawnImpl,
    fsImpl,
  });

  await controller.start();

  assert.equal(spawnImpl.calls.length, 1);
  const call = spawnImpl.calls[0];
  assert.equal(call.command, EXECUTABLE);
  assert.deepEqual(call.args, ['--headless', '--parent-stdin', '--config', CONFIG_FILE]);
  assert.equal(call.options.cwd, APP_DIR);
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(call.options.env.PYTHONIOENCODING, 'utf-8');
  assert.equal(call.options.env.SERVERMONITOR_DESKTOP, '1');
  assert.ok(!call.args.includes('--dotenv'));
  assert.equal(controller.isRunning(), true);
});

test('start() appends --dotenv only when the file exists', async () => {
  const fsImpl = createFakeFs({ [DOTENV_FILE]: 'FOO=bar\n' });
  const spawnImpl = createFakeSpawn();
  const controller = createBackendController({
    appDir: APP_DIR,
    executablePath: EXECUTABLE,
    spawnImpl,
    fsImpl,
  });

  await controller.start();

  const call = spawnImpl.calls[0];
  assert.deepEqual(call.args, [
    '--headless',
    '--parent-stdin',
    '--config',
    CONFIG_FILE,
    '--dotenv',
    DOTENV_FILE,
  ]);
});

test('stdout and stderr chunks are appended to logs/desktop.log with timestamp and prefix', async () => {
  const fsImpl = createFakeFs();
  const spawnImpl = createFakeSpawn();
  const controller = createBackendController({
    appDir: APP_DIR,
    executablePath: EXECUTABLE,
    spawnImpl,
    fsImpl,
  });

  await controller.start();
  const child = spawnImpl.calls[0].child;
  child.stdout.emit('data', 'hello from stdout\n');
  child.stderr.emit('data', Buffer.from('something broke\n'));

  const logData = fsImpl.writes
    .filter((write) => write.path === LOG_FILE)
    .map((write) => write.data)
    .join('');
  assert.ok(logData.length > 0, 'expected a write to logs/desktop.log');
  assert.match(logData, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[stdout\] hello from stdout/);
  assert.match(logData, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[stderr\] something broke/);
  assert.ok(fsImpl.dirs.includes(path.join(APP_DIR, 'logs')));
});

test('waitForRuntime() resolves {url, port} from data/runtime.json', async () => {
  const fsImpl = createFakeFs({
    [RUNTIME_FILE]: JSON.stringify({ url: 'http://127.0.0.1:8123', port: 8123, pid: 5000 }),
  });
  const controller = createBackendController({
    appDir: APP_DIR,
    executablePath: EXECUTABLE,
    spawnImpl: createFakeSpawn(),
    fsImpl,
  });

  const runtime = await controller.waitForRuntime();
  assert.deepEqual(runtime, { url: 'http://127.0.0.1:8123', port: 8123 });
});

test('waitForRuntime() rejects with a clear timeout error', async () => {
  const fsImpl = createFakeFs();
  const clock = createFakeClock();
  const controller = createBackendController({
    appDir: APP_DIR,
    executablePath: EXECUTABLE,
    spawnImpl: createFakeSpawn(),
    fsImpl,
    startupTimeoutMs: 750,
    pollIntervalMs: 250,
    clock,
    delay: (delayMs) => clock.advance(delayMs),
  });

  await assert.rejects(controller.waitForRuntime(), /Timed out waiting for backend runtime .* after 750ms/);
});

test('stop() closes stdin and resolves when the child exits in time', async () => {
  const fsImpl = createFakeFs();
  const spawnImpl = createFakeSpawn();
  const controller = createBackendController({
    appDir: APP_DIR,
    executablePath: EXECUTABLE,
    spawnImpl,
    fsImpl,
  });

  await controller.start();
  const child = spawnImpl.calls[0].child;
  child.onStdinEnd = () => setImmediate(() => child.emit('exit', 0, null));

  await controller.stop();

  assert.equal(child.stdin.ended, true);
  assert.equal(controller.isRunning(), false);
  assert.equal(spawnImpl.calls.length, 1, 'taskkill must not run when the child exits gracefully');
});

test('stop() falls back to taskkill /pid <pid> /t /f after the stop timeout', async () => {
  const fsImpl = createFakeFs();
  const spawnImpl = createFakeSpawn();
  const clock = createFakeClock();
  const controller = createBackendController({
    appDir: APP_DIR,
    executablePath: EXECUTABLE,
    spawnImpl,
    fsImpl,
    stopTimeoutMs: 3000,
    clock,
  });

  await controller.start();
  const child = spawnImpl.calls[0].child;

  const stopPromise = controller.stop();
  await flushAsync();
  await clock.advance(3000);
  await stopPromise;

  const killCall = spawnImpl.calls.find((call) => call.command === 'taskkill');
  assert.ok(killCall, 'expected taskkill to be spawned');
  assert.deepEqual(killCall.args, ['/pid', String(child.pid), '/t', '/f']);
  assert.equal(controller.isRunning(), false);
});

test('an unexpected exit invokes onUnexpectedExit exactly once', async () => {
  const fsImpl = createFakeFs();
  const spawnImpl = createFakeSpawn();
  const exits = [];
  const controller = createBackendController({
    appDir: APP_DIR,
    executablePath: EXECUTABLE,
    spawnImpl,
    fsImpl,
    onUnexpectedExit: (code, signal) => exits.push([code, signal]),
  });

  await controller.start();
  const child = spawnImpl.calls[0].child;
  child.emit('exit', 1, null);
  child.emit('exit', 1, null);
  await flushAsync();

  assert.deepEqual(exits, [[1, null]]);
  assert.equal(controller.isRunning(), false);
});

test('restart() does not duplicate exit listeners across restarts', async () => {
  const fsImpl = createFakeFs({
    [RUNTIME_FILE]: JSON.stringify({ url: 'http://127.0.0.1:8124', port: 8124 }),
  });
  const spawnImpl = createFakeSpawn();
  let unexpectedCount = 0;
  const controller = createBackendController({
    appDir: APP_DIR,
    executablePath: EXECUTABLE,
    spawnImpl,
    fsImpl,
    onUnexpectedExit: () => {
      unexpectedCount += 1;
    },
  });

  await controller.start();
  spawnImpl.calls[0].child.onStdinEnd = () =>
    setImmediate(() => spawnImpl.calls[0].child.emit('exit', 0, null));

  await controller.restart();
  const secondChild = spawnImpl.calls[1].child;
  secondChild.onStdinEnd = () => setImmediate(() => secondChild.emit('exit', 0, null));

  await controller.restart();
  const latestChild = spawnImpl.calls[2].child;

  assert.equal(latestChild.listenerCount('exit'), 1);
  latestChild.emit('exit', 1, null);
  await flushAsync();

  assert.equal(unexpectedCount, 1);
});

test('start() rejects when the spawned process emits an error', async () => {
  const fsImpl = createFakeFs();
  const spawnImpl = () => {
    const child = createFakeChild();
    child.pid = 9001;
    setImmediate(() => {
      const error = new Error('spawn ENOENT');
      error.code = 'ENOENT';
      child.emit('error', error);
    });
    return child;
  };
  const controller = createBackendController({
    appDir: APP_DIR,
    executablePath: EXECUTABLE,
    spawnImpl,
    fsImpl,
  });

  await assert.rejects(controller.start(), /ENOENT/);
  assert.equal(controller.isRunning(), false);
});

test('start() rejects when spawnImpl throws synchronously', async () => {
  const fsImpl = createFakeFs();
  const controller = createBackendController({
    appDir: APP_DIR,
    executablePath: EXECUTABLE,
    spawnImpl: () => {
      throw new Error('boom');
    },
    fsImpl,
  });

  await assert.rejects(controller.start(), /boom/);
});

test('stop() resolves immediately when no backend is running', async () => {
  const controller = createBackendController({
    appDir: APP_DIR,
    executablePath: EXECUTABLE,
    spawnImpl: createFakeSpawn(),
    fsImpl: createFakeFs(),
  });

  await controller.stop();
  assert.equal(controller.isRunning(), false);
});
