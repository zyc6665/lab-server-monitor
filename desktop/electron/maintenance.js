'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

const CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
];

function rotateLogFile(filePath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const maxBytes = options.maxBytes == null ? DEFAULT_LOG_MAX_BYTES : options.maxBytes;
  try {
    const stat = fsImpl.statSync(filePath);
    if (stat.size < maxBytes) {
      return false;
    }
    const rotated = `${filePath}.1`;
    try {
      fsImpl.rmSync(rotated, { force: true });
    } catch (error) {
      // A missing rotated file is expected.
    }
    fsImpl.renameSync(filePath, rotated);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    return false;
  }
}

function pruneLogFiles(directory, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const retentionMs = options.retentionMs == null ? DEFAULT_RETENTION_MS : options.retentionMs;
  const now = options.now == null ? Date.now() : options.now;
  const protectedNames = new Set(options.protectedNames || []);
  const result = { deleted: 0, bytes: 0 };
  let entries;
  try {
    entries = fsImpl.readdirSync(directory);
  } catch (error) {
    return result;
  }
  entries.forEach((name) => {
    if (protectedNames.has(name)) {
      return;
    }
    if (!name.endsWith('.log') && !name.includes('.log.')) {
      return;
    }
    const filePath = path.join(directory, name);
    try {
      const stat = fsImpl.statSync(filePath);
      if (!stat.isFile() || now - stat.mtimeMs < retentionMs) {
        return;
      }
      fsImpl.rmSync(filePath, { force: true });
      result.deleted += 1;
      result.bytes += stat.size;
    } catch (error) {
      // Ignore files that disappear or are locked.
    }
  });
  return result;
}

function cleanupUpdateDownloads(updatesDir, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const retentionMs = options.retentionMs == null ? DEFAULT_RETENTION_MS : options.retentionMs;
  const now = options.now == null ? Date.now() : options.now;
  const result = { deleted: 0, bytes: 0 };

  function walk(directory) {
    let entries;
    try {
      entries = fsImpl.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      return;
    }
    entries.forEach((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        return;
      }
      if (!entry.name.toLowerCase().endsWith('.zip')) {
        return;
      }
      try {
        const stat = fsImpl.statSync(full);
        if (retentionMs > 0 && now - stat.mtimeMs < retentionMs) {
          return;
        }
        fsImpl.rmSync(full, { force: true });
        result.deleted += 1;
        result.bytes += stat.size;
      } catch (error) {
        // Ignore locked/removed files.
      }
    });
  }

  walk(updatesDir);
  return result;
}

function cleanupElectronCache(userDataDir, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const cacheDirs = options.cacheDirs || CACHE_DIRS;
  const result = { deleted: 0, bytes: 0 };
  cacheDirs.forEach((name) => {
    const target = path.join(userDataDir, name);
    try {
      const stat = fsImpl.statSync(target);
      if (!stat.isDirectory()) {
        return;
      }
      const size = directorySize(target, { fsImpl });
      fsImpl.rmSync(target, { recursive: true, force: true });
      result.deleted += 1;
      result.bytes += size;
    } catch (error) {
      // Missing directory or files held open by Chromium.
    }
  });
  return result;
}

function directorySize(target, options = {}) {
  const fsImpl = options.fsImpl || fs;
  let total = 0;
  let entries;
  try {
    const stat = fsImpl.statSync(target);
    if (stat.isFile()) {
      return stat.size;
    }
    entries = fsImpl.readdirSync(target, { withFileTypes: true });
  } catch (error) {
    return 0;
  }
  entries.forEach((entry) => {
    total += directorySize(path.join(target, entry.name), { fsImpl });
  });
  return total;
}

module.exports = {
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_RETENTION_MS,
  CACHE_DIRS,
  rotateLogFile,
  pruneLogFiles,
  cleanupUpdateDownloads,
  cleanupElectronCache,
  directorySize,
};
