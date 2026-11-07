'use strict';

const path = require('node:path');

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

/**
 * Resolve the application directory.
 *
 * - Development: the repository root is passed explicitly as `appRoot`.
 * - Packaged: the directory that contains the Electron executable.
 *
 * @param {{isPackaged?: boolean, appRoot?: string, execPath?: string}} options
 * @returns {string}
 */
function resolveAppDir(options = {}) {
  const { isPackaged, appRoot, execPath } = options;
  if (isPackaged) {
    return path.dirname(requireNonEmptyString(execPath, 'execPath'));
  }
  return requireNonEmptyString(appRoot, 'appRoot');
}

/**
 * Resolve the Python backend executable.
 *
 * Packaged builds ship the backend under <appDir>/resources/backend.
 * Development runs use the PyInstaller output inside the repository.
 *
 * @param {{isPackaged?: boolean, appDir: string}} options
 * @returns {string}
 */
function backendPath(options = {}) {
  const { isPackaged, appDir } = options;
  const base = requireNonEmptyString(appDir, 'appDir');
  if (isPackaged) {
    return path.join(base, 'resources', 'backend', 'servermonitor-backend.exe');
  }
  return path.join(base, 'dist', 'backend', 'servermonitor-backend', 'servermonitor-backend.exe');
}

/** @param {string} appDir */
function configPath(appDir) {
  return path.join(requireNonEmptyString(appDir, 'appDir'), 'config', 'config.yaml');
}

/** @param {string} appDir */
function dotenvPath(appDir) {
  return path.join(requireNonEmptyString(appDir, 'appDir'), 'config', '.env');
}

/** @param {string} appDir */
function dataDir(appDir) {
  return path.join(requireNonEmptyString(appDir, 'appDir'), 'data');
}

/** @param {string} appDir */
function logsDir(appDir) {
  return path.join(requireNonEmptyString(appDir, 'appDir'), 'logs');
}

/** @param {string} appDir */
function electronUserData(appDir) {
  return path.join(requireNonEmptyString(appDir, 'appDir'), 'data', 'electron');
}

module.exports = {
  resolveAppDir,
  backendPath,
  configPath,
  dotenvPath,
  dataDir,
  logsDir,
  electronUserData,
};
