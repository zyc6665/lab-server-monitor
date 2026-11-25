import { describe, it, expect } from 'vitest';
import {
  compareVersions,
  isNewer,
  isSameMajor,
  isPrerelease,
  normaliseVersion,
  pickUpdateAsset,
  decideUpdate,
  shouldCheck,
  DEFAULT_CHECK_INTERVAL_MS,
  RELEASE_PREFIX,
  type ReleaseLike,
} from '../src/main/update-policy';

/** Build a GitHub-release-like fixture with the expected Windows assets. */
function release(overrides: Partial<ReleaseLike> = {}): ReleaseLike {
  const version = overrides.tag_name ? String(overrides.tag_name).replace(/^v/i, '') : '0.1.240';
  const zipName = `${RELEASE_PREFIX}${version}.zip`;
  const assets = [
    {
      name: zipName,
      url: `https://api.github.com/assets/${version}`,
      browser_download_url: `https://github.com/dl/${zipName}`,
      size: 1234,
    },
    {
      name: `${zipName}.sha256`,
      url: `https://api.github.com/assets/${version}.sha256`,
      browser_download_url: `https://github.com/dl/${zipName}.sha256`,
      size: 64,
    },
  ];
  return { tag_name: `v${version}`, body: 'notes', html_url: 'https://x/rel', assets, ...overrides };
}

describe('compareVersions / isNewer', () => {
  it('equal versions compare 0', () => expect(compareVersions('0.1.240', '0.1.240')).toBe(0));
  it('newer left compares 1', () => expect(compareVersions('0.1.241', '0.1.240')).toBe(1));
  it('older left compares -1', () => expect(compareVersions('0.1.239', '0.1.240')).toBe(-1));
  it('strips leading v', () => expect(compareVersions('v0.2.0', '0.1.9')).toBe(1));
  it('ignores prerelease suffix', () => expect(compareVersions('0.1.240-beta.3', '0.1.240')).toBe(0));
  it('treats missing parts as zero', () => expect(compareVersions('1.2', '1.2.0')).toBe(0));
  it('isNewer true only when strictly newer', () => {
    expect(isNewer('0.1.241', '0.1.240')).toBe(true);
    expect(isNewer('0.1.240', '0.1.240')).toBe(false);
  });
});

describe('isSameMajor', () => {
  it('same 0.x major is true', () => expect(isSameMajor('0.1.239', '0.1.999')).toBe(true));
  it('stray v1.x is rejected for a 0.x build', () =>
    expect(isSameMajor('0.1.239', '1.6.1')).toBe(false));
  it('different major is false', () => expect(isSameMajor('1.2.0', '2.0.0')).toBe(false));
});

describe('isPrerelease / normaliseVersion', () => {
  it('prerelease flag true', () => expect(isPrerelease({ prerelease: true })).toBe(true));
  it('draft flag true', () => expect(isPrerelease({ draft: true })).toBe(true));
  it('stable release false', () => expect(isPrerelease({ prerelease: false, draft: false })).toBe(false));
  it('null release false', () => expect(isPrerelease(null)).toBe(false));
  it('normalise strips v', () => expect(normaliseVersion(' v0.1.240 ')).toBe('0.1.240'));
});

describe('pickUpdateAsset', () => {
  it('picks the exact versioned zip and its sha256 sidecar', () => {
    const asset = pickUpdateAsset(release());
    expect(asset).not.toBeNull();
    expect(asset!.name).toBe(`${RELEASE_PREFIX}0.1.240.zip`);
    expect(asset!.version).toBe('0.1.240');
    expect(asset!.url).toBe('https://api.github.com/assets/0.1.240');
    expect(asset!.sha256Name).toBe(`${RELEASE_PREFIX}0.1.240.zip.sha256`);
    expect(asset!.sha256Url).toBe('https://api.github.com/assets/0.1.240.sha256');
    expect(asset!.size).toBe(1234);
  });

  it('returns null when the release has no zip', () => {
    expect(pickUpdateAsset({ tag_name: 'v0.1.240', assets: [] })).toBeNull();
  });

  it('ignores a lone .sha256 asset (no zip present)', () => {
    expect(
      pickUpdateAsset({
        tag_name: 'v0.1.240',
        assets: [{ name: `${RELEASE_PREFIX}0.1.240.zip.sha256`, url: 'u' }],
      }),
    ).toBeNull();
  });

  it('falls back to the release-prefix zip when the exact name differs', () => {
    const asset = pickUpdateAsset({
      tag_name: 'v0.1.240',
      assets: [{ name: `${RELEASE_PREFIX}0.1.240-custom.zip`, url: 'https://dl/x.zip' }],
    });
    expect(asset).not.toBeNull();
    expect(asset!.name).toBe(`${RELEASE_PREFIX}0.1.240-custom.zip`);
  });

  it('leaves sha256 fields null when the sidecar is absent', () => {
    const asset = pickUpdateAsset({
      tag_name: 'v0.1.240',
      assets: [{ name: `${RELEASE_PREFIX}0.1.240.zip`, url: 'https://dl/x.zip' }],
    });
    expect(asset!.sha256Name).toBeNull();
    expect(asset!.sha256Url).toBeNull();
  });

  it('returns null for an empty release', () => expect(pickUpdateAsset(null)).toBeNull());
});

describe('decideUpdate', () => {
  it('offers a newer same-major release with its asset', () => {
    const decision = decideUpdate('0.1.239', release({ tag_name: 'v0.1.240' }));
    expect(decision.status).toBe('update-available');
    if (decision.status === 'update-available') {
      expect(decision.version).toBe('0.1.240');
      expect(decision.asset.name).toBe(`${RELEASE_PREFIX}0.1.240.zip`);
    }
  });

  it('excludes prereleases', () => {
    const decision = decideUpdate('0.1.239', release({ tag_name: 'v0.1.240', prerelease: true }));
    expect(decision).toEqual({ status: 'up-to-date', version: '0.1.240', reason: 'prerelease' });
  });

  it('rejects a different major', () => {
    const decision = decideUpdate('0.1.239', release({ tag_name: 'v1.6.1' }));
    expect(decision).toEqual({ status: 'up-to-date', version: '1.6.1', reason: 'major-mismatch' });
  });

  it('is up-to-date when not newer', () => {
    expect(decideUpdate('0.1.240', release({ tag_name: 'v0.1.240' }))).toEqual({
      status: 'up-to-date',
      version: '0.1.240',
    });
  });

  it('errors when the matching asset is missing', () => {
    const decision = decideUpdate('0.1.239', { tag_name: 'v0.1.240', assets: [] });
    expect(decision.status).toBe('error');
  });

  it('errors when tag_name is missing', () => {
    expect(decideUpdate('0.1.239', { assets: [] }).status).toBe('error');
  });
});

describe('shouldCheck', () => {
  const DAY = DEFAULT_CHECK_INTERVAL_MS;
  it('default interval is 24h', () => expect(DAY).toBe(24 * 60 * 60 * 1000));
  it('checks when never checked', () => expect(shouldCheck({ lastCheckedAt: null, now: 1000 })).toBe(true));
  it('skips within the interval', () =>
    expect(shouldCheck({ lastCheckedAt: 1000, now: 1000 + DAY - 1 })).toBe(false));
  it('checks at exactly the interval boundary', () =>
    expect(shouldCheck({ lastCheckedAt: 1000, now: 1000 + DAY })).toBe(true));
  it('honours a custom interval (too soon)', () =>
    expect(shouldCheck({ lastCheckedAt: 1000, now: 1500, intervalMs: 1000 })).toBe(false));
  it('honours a custom interval (elapsed)', () =>
    expect(shouldCheck({ lastCheckedAt: 1000, now: 2500, intervalMs: 1000 })).toBe(true));
});
