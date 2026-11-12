'use strict';

const net = require('node:net');

const TRAY_LABELS = ['显示主窗口', '复制看板地址', '打开日志目录', '退出'];

function requireHandler(handler, name) {
  if (typeof handler !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
  return handler;
}

/**
 * Build the tray context-menu template in the exact order the UI expects.
 *
 * Returns plain `{label, click}` objects so the caller can attach them to an
 * Electron `Menu.buildFromTemplate` without the helper depending on Electron.
 *
 * @param {{onShow: Function, onCopyUrl: Function, onOpenLogs: Function, onQuit: Function}} handlers
 * @returns {Array<{label: string, click: Function}>}
 */
function trayMenuTemplate(handlers = {}) {
  const onShow = requireHandler(handlers.onShow, 'onShow');
  const onCopyUrl = requireHandler(handlers.onCopyUrl, 'onCopyUrl');
  const onOpenLogs = requireHandler(handlers.onOpenLogs, 'onOpenLogs');
  const onQuit = requireHandler(handlers.onQuit, 'onQuit');

  return [
    { label: TRAY_LABELS[0], click: () => onShow() },
    { label: TRAY_LABELS[1], click: () => onCopyUrl() },
    { label: TRAY_LABELS[2], click: () => onOpenLogs() },
    { label: TRAY_LABELS[3], click: () => onQuit() },
  ];
}

/**
 * Closing the window must never stop the monitor: it only hides the window and
 * keeps the backend running in the tray.  The single exception is a real quit
 * (tray menu "退出" or Cmd+Q), where `quitting` is already true.
 *
 * A missing tray icon is not a reason to exit -- the caller recreates it, and
 * launching the exe again focuses the existing window.
 *
 * @param {{trayAvailable?: boolean, quitting?: boolean}} options
 * @returns {boolean}
 */
function shouldHideOnClose(options = {}) {
  return !options.quitting;
}

function isLoopbackHost(host) {
  if (host === 'localhost') {
    return true;
  }
  if (net.isIPv4(host)) {
    return host.startsWith('127.');
  }
  if (net.isIPv6(host)) {
    return host === '::1' || host === '0:0:0:0:0:0:0:1';
  }
  return false;
}

/**
 * Validate the host the dashboard may bind to. Accept only wildcard or loopback
 * hosts so the desktop build never exposes the UI on a public interface.
 *
 * @param {string} host
 * @returns {string} the original host when valid
 */
function validateDashboardHost(host) {
  if (typeof host !== 'string') {
    throw new TypeError('看板地址必须是字符串');
  }
  const value = host.trim();
  if (value === '' || value === '0.0.0.0' || value === '::') {
    return value;
  }
  if (isLoopbackHost(value)) {
    return value;
  }
  throw new Error(`不支持的看板地址：${host}，仅允许本机回环或通配地址`);
}

/**
 * True when `url` shares the backend's origin (protocol + host + port).
 *
 * @param {string} url
 * @param {string} runtimeUrl
 * @returns {boolean}
 */
function isBackendUrl(url, runtimeUrl) {
  if (typeof url !== 'string' || typeof runtimeUrl !== 'string') {
    return false;
  }
  let target;
  let base;
  try {
    target = new URL(url);
    base = new URL(runtimeUrl);
  } catch (error) {
    return false;
  }
  return target.origin === base.origin;
}

module.exports = {
  TRAY_LABELS,
  trayMenuTemplate,
  shouldHideOnClose,
  validateDashboardHost,
  isBackendUrl,
};
