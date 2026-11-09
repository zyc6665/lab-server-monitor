'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  rotateLogFile,
  pruneLogFiles,
  cleanupUpdateDownloads,
  cleanupElectronCache,
  directorySize,
} = require('../electron/maintenance.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'servermonitor-maint-test-'));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function ageFile(filePath, hours) {
  const when = new Date(Date.now() - hours * 60 * 60 * 1000);
  fs.utimesSync(filePath, when, when);
}

test('rotateLogFile moves a full log to .1 and leaves small files alone', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'desktop.log');
  writeFile(file, 'x'.repeat(64));
  writeFile(`${file}.1`, 'old');

  assert.equal(rotateLogFile(file, { maxBytes: 10 }), true);
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'x'.repeat(64));
  assert.equal(fs.existsSync(file), false);

  writeFile(file, 'small');
  assert.equal(rotateLogFile(file, { maxBytes: 100 }), false);
});

test('pruneLogFiles removes expired logs but keeps protected and recent ones', () => {
  const dir = makeTempDir();
  writeFile(path.join(dir, 'servermonitor.log.1'), 'old backup');
  writeFile(path.join(dir, 'desktop.log'), 'current');
  writeFile(path.join(dir, 'desktop.log.1'), 'old desktop');
  writeFile(path.join(dir, 'servermonitor.log'), 'protected even if old');
  ageFile(path.join(dir, 'servermonitor.log.1'), 30);
  ageFile(path.join(dir, 'desktop.log.1'), 30);
  ageFile(path.join(dir, 'servermonitor.log'), 40);
  ageFile(path.join(dir, 'desktop.log'), 2);

  const result = pruneLogFiles(dir, {
    retentionMs: 24 * 60 * 60 * 1000,
    protectedNames: ['servermonitor.log', 'desktop.log'],
  });

  assert.equal(result.deleted, 2);
  assert.ok(result.bytes > 0);
  assert.equal(fs.existsSync(path.join(dir, 'servermonitor.log.1')), false);
  assert.equal(fs.existsSync(path.join(dir, 'desktop.log.1')), false);
  assert.equal(fs.existsSync(path.join(dir, 'servermonitor.log')), true);
  assert.equal(fs.existsSync(path.join(dir, 'desktop.log')), true);
});

test('cleanupUpdateDownloads removes old zips recursively and keeps recent', () => {
  const dir = makeTempDir();
  const oldZip = path.join(dir, 'download', 'old.zip');
  const newZip = path.join(dir, 'download', 'new.zip');
  writeFile(oldZip, 'old');
  writeFile(newZip, 'new');
  writeFile(path.join(dir, 'update-cache.json'), '{}');
  ageFile(oldZip, 30);

  const result = cleanupUpdateDownloads(dir, {
    retentionMs: 24 * 60 * 60 * 1000,
  });

  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(oldZip), false);
  assert.equal(fs.existsSync(newZip), true);
  assert.equal(fs.existsSync(path.join(dir, 'update-cache.json')), true);
});

test('cleanupUpdateDownloads with zero retention removes every zip', () => {
  const dir = makeTempDir();
  const zip = path.join(dir, 'download', 'current.zip');
  writeFile(zip, 'current');

  const result = cleanupUpdateDownloads(dir, { retentionMs: 0 });

  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(zip), false);
});

test('cleanupElectronCache removes Chromium cache dirs but keeps Local Storage', () => {
  const dir = makeTempDir();
  writeFile(path.join(dir, 'Cache', 'data.bin'), 'cache');
  writeFile(path.join(dir, 'GPUCache', 'gpu.bin'), 'gpu');
  writeFile(path.join(dir, 'Local Storage', 'leveldb', 'data'), 'keep');

  const result = cleanupElectronCache(dir, { cacheDirs: ['Cache', 'GPUCache'] });

  assert.equal(result.deleted, 2);
  assert.ok(result.bytes > 0);
  assert.equal(fs.existsSync(path.join(dir, 'Cache')), false);
  assert.equal(fs.existsSync(path.join(dir, 'GPUCache')), false);
  assert.equal(fs.existsSync(path.join(dir, 'Local Storage', 'leveldb', 'data')), true);
});

test('directorySize sums nested files and ignores missing paths', () => {
  const dir = makeTempDir();
  writeFile(path.join(dir, 'a', 'one.txt'), '1234');
  writeFile(path.join(dir, 'b', 'two.txt'), '12');

  assert.equal(directorySize(dir), 6);
  assert.equal(directorySize(path.join(dir, 'missing')), 0);
});
