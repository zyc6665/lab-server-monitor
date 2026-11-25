'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Must match the asset name produced by release-windows.yml (step "Normalise
// release asset name"), which renames the build artifact to
// `lab-server-monitor-Windows-x64-v<version>.zip` before publishing.
const RELEASE_PREFIX = 'lab-server-monitor-Windows-x64-v';

// Hard ceiling for a downloaded update package. The portable build is a few
// hundred MB at most; anything larger is a red flag (corrupt or hostile asset).
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

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

function majorOf(version) {
  return versionParts(version)[0] || 0;
}

/**
 * Only releases on the same major line as the running build are eligible.
 * The repository historically carried a stray `v1.x` release line while the
 * package stayed on `0.1.x`; without this guard a 0.1.x install would see
 * `v1.6.1` as newer, download it, and then "downgrade" back on the next run.
 */
function isSameMajorLine(candidate, current) {
  return majorOf(candidate) === majorOf(current);
}

function isPrerelease(release) {
  return Boolean(release && (release.prerelease || release.draft));
}

function normaliseVersion(tag) {
  return String(tag || '').trim().replace(/^v/i, '');
}

function findAssets(release, options = {}) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const zips = assets.filter((asset) => {
    const name = String((asset && asset.name) || '');
    return /\.zip$/i.test(name) && !/\.sha256$/i.test(name);
  });
  const version = options.version ? normaliseVersion(options.version) : '';
  const expectedName = version ? `${RELEASE_PREFIX}${version}.zip` : '';
  // Match the exact expected asset name first, then the release prefix, instead
  // of blindly taking the first `*.zip` (which could pick a wrong artifact).
  let zip = null;
  if (expectedName) {
    zip = zips.find((asset) => String((asset && asset.name) || '') === expectedName) || null;
  }
  if (!zip) {
    zip = zips.find((asset) => String((asset && asset.name) || '').startsWith(RELEASE_PREFIX)) || null;
  }
  if (!zip && !version && zips.length === 1) {
    // Legacy call without a version hint: fall back to the single zip.
    zip = zips[0];
  }
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
    if (isPrerelease(release)) {
      const result = {
        status: 'up-to-date',
        version,
        current_version: currentVersion,
        reason: 'prerelease',
      };
      writeCache({ checked_at: now(), result });
      return result;
    }
    if (!isSameMajorLine(version, currentVersion)) {
      const result = {
        status: 'up-to-date',
        version,
        current_version: currentVersion,
        reason: 'major-mismatch',
      };
      writeCache({ checked_at: now(), result });
      return result;
    }
    if (!isNewer(version, currentVersion)) {
      const result = { status: 'up-to-date', version, current_version: currentVersion };
      writeCache({ checked_at: now(), result });
      return result;
    }
    const assets = findAssets(release, { version });
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
    if (!update.checksum_url) {
      throw new Error('更新包缺少校验文件地址，已中止更新（fail-closed）');
    }

    // 1. Resolve the expected checksum BEFORE downloading or applying anything.
    //    If no usable hash is obtainable we fail closed and never apply the zip.
    const checksumResponse = await fetchImpl(update.checksum_url, {
      redirect: 'follow',
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': 'servermonitor-desktop-updater',
      },
      signal: AbortSignal.timeout(60 * 1000),
    });
    if (!checksumResponse.ok) {
      throw new Error(
        `获取更新包校验文件失败: HTTP ${checksumResponse.status}（fail-closed，已中止更新）`,
      );
    }
    const checksumText = await checksumResponse.text();
    const checksumMatch = String(checksumText).trim().match(/[a-fA-F0-9]{64}/);
    const expected = checksumMatch ? checksumMatch[0].toLowerCase() : null;
    if (!expected) {
      throw new Error('更新包校验文件格式无效，已中止更新（fail-closed）');
    }

    // 2. Reject oversized packages before buffering the body into memory.
    const declaredSize = Number(update.asset_size);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_DOWNLOAD_BYTES) {
      throw new Error(
        `更新包过大（声明 ${declaredSize} 字节，上限 ${MAX_DOWNLOAD_BYTES} 字节）`,
      );
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

    const contentLength =
      response.headers && typeof response.headers.get === 'function'
        ? Number(response.headers.get('content-length'))
        : NaN;
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(
        `更新包过大（Content-Length ${contentLength} 字节，上限 ${MAX_DOWNLOAD_BYTES} 字节）`,
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD_BYTES) {
      throw new Error(
        `更新包过大（实际 ${bytes.length} 字节，上限 ${MAX_DOWNLOAD_BYTES} 字节）`,
      );
    }

    // 3. Verify the hash. Because `expected` is guaranteed above, this is now a
    //    real gate: without a matching checksum the zip is never written/applied.
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (expected !== actual) {
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
  isSameMajorLine,
  isPrerelease,
  normaliseVersion,
  findAssets,
  createUpdaterCore,
  RELEASE_PREFIX,
  MAX_DOWNLOAD_BYTES,
};
