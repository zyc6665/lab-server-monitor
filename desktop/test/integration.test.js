'use strict';

// Task 9: end-to-end integration for the packaged backend controller.
//
// Unlike backend.test.js (which uses an in-memory fake filesystem), these tests
// exercise the *real* filesystem: the controller writes/reads a genuine
// runtime.json on disk. Process spawning is still faked so the suite never
// launches a real backend or taskkill.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBackendController } = require('../electron/backend.js');

function makeTmpAppDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servermonitor-int-'));
  return dir;
}

function makeFakeChild({ exitOnStdinEnd = true } = {}) {
  const child = new EventEmitter();
  child.pid = 4321;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    ended: false,
    end() {
      this.ended = true;
      if (exitOnStdinEnd) {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      }
    },
  };
  return child;
}

function makeFakeSpawn(child) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'taskkill') {
      const killer = new EventEmitter();
      killer.pid = 9999;
      queueMicrotask(() => killer.emit('exit', 0, null));
      return killer;
    }
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  return { spawnImpl, calls };
}

function runtimeFileFor(appDir) {
  return path.join(appDir, 'data', 'runtime.json');
}

test('real fs: backend writes runtime.json, appears on disk, stop closes stdin', async () => {
  const appDir = makeTmpAppDir();
  const child = makeFakeChild({ exitOnStdinEnd: true });
  const { spawnImpl, calls } = makeFakeSpawn(child);

  const controller = createBackendController({
    appDir,
    executablePath: path.join(appDir, 'resources', 'backend', 'servermonitor-backend.exe'),
    spawnImpl,
    startupTimeoutMs: 2000,
    pollIntervalMs: 5,
    stopTimeoutMs: 1000,
  });

  try {
    await controller.start();

    // The controller spawned our fake with the headless/parent-stdin contract.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.cwd, appDir);
    assert.equal(calls[0].options.env.SERVERMONITOR_DESKTOP, '1');
    assert.deepEqual(calls[0].args.slice(0, 2), ['--headless', '--parent-stdin']);

    // Simulate the real Python backend publishing its runtime state.
    const runtimeFile = runtimeFileFor(appDir);
    fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
    fs.writeFileSync(
      runtimeFile,
      JSON.stringify({ url: 'http://127.0.0.1:18765', port: 18765, pid: child.pid }),
      'utf8',
    );
    assert.ok(fs.existsSync(runtimeFile), 'runtime.json must be written to disk');

    const runtime = await controller.waitForRuntime();
    assert.deepEqual(runtime, { url: 'http://127.0.0.1:18765', port: 18765 });

    await controller.stop();
    assert.equal(child.stdin.ended, true, 'stop() must close backend stdin');
    assert.equal(controller.isRunning(), false);
    // Graceful path must not invoke taskkill.
    assert.equal(calls.filter((c) => c.command === 'taskkill').length, 0);
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('real fs: stop falls back to taskkill when the child ignores stdin EOF', async () => {
  const appDir = makeTmpAppDir();
  const child = makeFakeChild({ exitOnStdinEnd: false });
  const { spawnImpl, calls } = makeFakeSpawn(child);

  const controller = createBackendController({
    appDir,
    executablePath: path.join(appDir, 'resources', 'backend', 'servermonitor-backend.exe'),
    spawnImpl,
    startupTimeoutMs: 2000,
    pollIntervalMs: 5,
    stopTimeoutMs: 40,
  });

  try {
    await controller.start();

    const runtimeFile = runtimeFileFor(appDir);
    fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
    fs.writeFileSync(
      runtimeFile,
      JSON.stringify({ url: 'http://127.0.0.1:18766', port: 18766 }),
      'utf8',
    );
    await controller.waitForRuntime();

    await controller.stop();

    assert.equal(child.stdin.ended, true);
    const taskkillCalls = calls.filter((c) => c.command === 'taskkill');
    assert.equal(taskkillCalls.length, 1, 'timeout must invoke taskkill exactly once');
    assert.deepEqual(taskkillCalls[0].args, ['/pid', String(child.pid), '/t', '/f']);
    assert.equal(controller.isRunning(), false);
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});
