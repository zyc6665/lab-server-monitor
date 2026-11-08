'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RELEASE_PREFIX = '服务器轮询监测工具-Windows-x64-v';

function versionParts(version) {
  const cleaned = String(version || '')
    .trim()
    .replace(/^v/i, '')
    .split('-')[0];
  return cleaned.split('.').map((part) => {
    const number = Number.parseInt(part, 10);
    return Number.isFinite(number) ? number : 0;
  });
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

function normaliseVersion(tag) {
  return String(tag || '').trim().replace(/^v/i, '');
}

function findAssets(release) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const zip = assets.find((asset) => {
    const name = String((asset && asset.name) || '');
    return /\.zip$/i.test(name) && !/\.sha256$/i.test(name);
  });
  if (!zip) return null;
  const sha =
    assets.find((asset) => String((asset && asset.name) || '') === `${zip.name}.sha256`) ||
    assets.find((asset) => /\.zip\.sha256$/i.test(String((asset && asset.name) || '')));
  return {
    name: zip.name,
    // Prefer the GitHub API asset URL: the browser_download_url redirects to
    // objects.githubusercontent.com, which is frequently blocked from mainland
    // China, while api.github.com asset downloads work through the same host as
    // release checks.
    url: zip.url || zip.browser_download_url,
    browserUrl: zip.browser_download_url || null,
    size: zip.size,
    checksumUrl: sha ? sha.url || sha.browser_download_url : null,
    checksumName: sha ? sha.name : null,
  };
}

function createUpdaterCore(options = {}) {
  const repo = options.repo || 'zyc6665/lab-server-monitor';
  const currentVersion = options.currentVersion || '0.0.0';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const fsImpl = options.fsImpl || fs;
  const pathImpl = options.pathImpl || path;
  const now = options.now || (() => Date.now());
  const checkIntervalMs = options.checkIntervalMs || 24 * 60 * 60 * 1000;
  const updatesDir = options.updatesDir;

  if (typeof fetchImpl !== 'function') {
    throw new Error('updater requires fetch');
  }

  function cachePath() {
    return pathImpl.join(updatesDir, 'update-cache.json');
  }

  function readCache() {
    try {
      return JSON.parse(fsImpl.readFileSync(cachePath(), 'utf8'));
    } catch (error) {
      return null;
    }
  }

  function writeCache(value) {
    try {
      fsImpl.mkdirSync(updatesDir, { recursive: true });
      fsImpl.writeFileSync(cachePath(), JSON.stringify(value), 'utf8');
    } catch (error) {
      // Cache is an optimisation only; never fail an update because of it.
    }
  }

  async function checkForUpdate(options = {}) {
    const force = Boolean(options.force);
    if (!force) {
      const cached = readCache();
      if (cached && now() - Number(cached.checked_at || 0) < checkIntervalMs) {
        return cached.result;
      }
    }
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'servermonitor-desktop-updater',
        },
        redirect: 'follow',
      });
    } catch (error) {
      return { status: 'error', message: String(error && error.message ? error.message : error) };
    }
    if (response.status === 403 || response.status === 429) {
      return { status: 'skipped', message: 'GitHub 请求受限，稍后再试' };
    }
    if (!response.ok) {
      return { status: 'error', message: `GitHub 返回 HTTP ${response.status}` };
    }
    let release;
    try {
      release = await response.json();
    } catch (error) {
      return { status: 'error', message: '无法解析 GitHub 版本信息' };
    }
    const version = normaliseVersion(release && release.tag_name);
    if (!version) return { status: 'error', message: '最新版本缺少 tag_name' };
    if (!isNewer(version, currentVersion)) {
      const result = { status: 'up-to-date', version, current_version: currentVersion };
      writeCache({ checked_at: now(), result });
      return result;
    }
    const assets = findAssets(release);
    if (!assets || !assets.url) {
      return { status: 'error', message: '最新版本没有可下载的 Windows 绿色包' };
    }
    const result = {
      status: 'update-available',
      version,
      current_version: currentVersion,
      notes: String(release.body || ''),
      release_url: String(release.html_url || ''),
      asset_name: assets.name,
      asset_url: assets.url,
      checksum_url: assets.checksumUrl,
      asset_size: assets.size || 0,
    };
    writeCache({ checked_at: now(), result });
    return result;
  }

  async function downloadAndVerify(update) {
    if (!update || !update.asset_url) {
      throw new Error('缺少更新包下载地址');
    }
    const downloadDir = pathImpl.join(updatesDir, 'download');
    fsImpl.mkdirSync(downloadDir, { recursive: true });
    const target = pathImpl.join(downloadDir, update.asset_name || `servermonitor-${update.version}.zip`);
    const response = await fetchImpl(update.asset_url, {
      redirect: 'follow',
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': 'servermonitor-desktop-updater',
      },
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
    if (!response.ok) throw new Error(`下载更新包失败: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());

    let expected = null;
    if (update.checksum_url) {
      const checksumResponse = await fetchImpl(update.checksum_url, {
        redirect: 'follow',
        headers: {
          Accept: 'application/octet-stream',
          'User-Agent': 'servermonitor-desktop-updater',
        },
        signal: AbortSignal.timeout(60 * 1000),
      });
      if (checksumResponse.ok) {
        const text = await checksumResponse.text();
        const match = String(text).trim().match(/[a-fA-F0-9]{64}/);
        expected = match ? match[0].toLowerCase() : null;
      }
    }
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (expected && expected !== actual) {
      throw new Error(`更新包校验失败（期望 ${expected}，实际 ${actual}）`);
    }
    fsImpl.writeFileSync(target, bytes);
    return { path: target, sha256: actual, expected_sha256: expected, size: bytes.length };
  }

  return {
    currentVersion,
    repo,
    checkForUpdate,
    downloadAndVerify,
  };
}

module.exports = {
  compareVersions,
  isNewer,
  normaliseVersion,
  findAssets,
  createUpdaterCore,
  RELEASE_PREFIX,
};
