'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  compareVersions,
  isNewer,
  normaliseVersion,
  findAssets,
  createUpdaterCore,
} = require('../electron/updater-core.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'updater-core-'));
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
  };
}

function release(version = '1.5.1') {
  return {
    tag_name: `v${version}`,
    body: 'fixes',
    html_url: `https://github.com/zyc6665/lab-server-monitor/releases/tag/v${version}`,
    assets: [
      {
        name: `服务器轮询监测工具-Windows-x64-v${version}.zip`,
        browser_download_url: `https://example.test/v${version}.zip`,
        size: 100,
      },
      {
        name: `服务器轮询监测工具-Windows-x64-v${version}.zip.sha256`,
        browser_download_url: `https://example.test/v${version}.zip.sha256`,
      },
    ],
  };
}

test('compareVersions and isNewer order numeric segments', () => {
  assert.equal(compareVersions('1.5.10', '1.5.9'), 1);
  assert.equal(compareVersions('v1.5.0', '1.5.0'), 0);
  assert.equal(isNewer('1.5.1', '1.5.0'), true);
  assert.equal(isNewer('1.5.0', '1.5.0'), false);
  assert.equal(normaliseVersion('v1.5.1'), '1.5.1');
});

test('findAssets requires a zip and prefers matching sha256', () => {
  const assets = findAssets(release('1.5.1'));
  assert.match(assets.name, /\.zip$/);
  assert.equal(assets.checksumUrl, 'https://example.test/v1.5.1.zip.sha256');
});

test('checkForUpdate returns update-available and caches result', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(release('1.5.1'));
  };
  const dir = tempDir();
  const core = createUpdaterCore({
    repo: 'zyc6665/lab-server-monitor',
    currentVersion: '1.5.0',
    fetchImpl,
    updatesDir: dir,
    now: () => 1000,
  });
  const first = await core.checkForUpdate();
  assert.equal(first.status, 'update-available');
  assert.equal(first.version, '1.5.1');
  assert.match(first.asset_url, /\.zip$/);
  assert.match(first.checksum_url, /\.sha256$/);

  const second = await core.checkForUpdate();
  assert.equal(second.status, 'update-available');
  assert.equal(calls, 1, 'second call within 24h should use cache');
});

test('checkForUpdate returns up-to-date for same or older version', async () => {
  const core = createUpdaterCore({
    currentVersion: '1.5.1',
    fetchImpl: async () => jsonResponse(release('1.5.0')),
    updatesDir: tempDir(),
    now: () => 1000,
  });
  assert.equal((await core.checkForUpdate()).status, 'up-to-date');
});

test('checkForUpdate handles 403 as skipped', async () => {
  const core = createUpdaterCore({
    currentVersion: '1.5.0',
    fetchImpl: async () => jsonResponse({}, 403),
    updatesDir: tempDir(),
  });
  assert.equal((await core.checkForUpdate()).status, 'skipped');
});

test('downloadAndVerify checks sha256 and writes the zip', async () => {
  const content = Buffer.from('fake-zip-bytes');
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  const dir = tempDir();
  const fetchImpl = async (url) => {
    if (String(url).endsWith('.sha256')) {
      return {
        ok: true,
        status: 200,
        text: async () => `${digest}  package.zip\n`,
      };
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => content,
    };
  };
  const core = createUpdaterCore({
    currentVersion: '1.5.0',
    fetchImpl,
    updatesDir: dir,
  });
  const result = await core.downloadAndVerify({
    version: '1.5.1',
    asset_name: 'package.zip',
    asset_url: 'https://example.test/package.zip',
    checksum_url: 'https://example.test/package.zip.sha256',
  });
  assert.equal(result.sha256, digest);
  assert.equal(fs.readFileSync(result.path).toString(), content.toString());
});

test('downloadAndVerify rejects a checksum mismatch', async () => {
  const dir = tempDir();
  const core = createUpdaterCore({
    currentVersion: '1.5.0',
    updatesDir: dir,
    fetchImpl: async (url) => {
      if (String(url).endsWith('.sha256')) {
        return { ok: true, status: 200, text: async () => 'a'.repeat(64) };
      }
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('bytes') };
    },
  });
  await assert.rejects(
    () =>
      core.downloadAndVerify({
        version: '1.5.1',
        asset_name: 'package.zip',
        asset_url: 'https://example.test/package.zip',
        checksum_url: 'https://example.test/package.zip.sha256',
      }),
    /校验失败/,
  );
});
