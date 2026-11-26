/**
 * Pure update-policy helpers shared by the updater integration.
 *
 * These functions carry no Electron or network dependency so they can be unit
 * tested in plain Node. The real update flow uses `electron-updater` with the
 * GitHub provider (which reads `latest.yml`), but the release/asset selection
 * policy below is kept — and exercised by tests — so the legacy
 * `lab-server-monitor-Windows-x64-v<ver>.zip` + `.sha256` contract documented in
 * `release-windows.yml` stays enforced.
 */

/** Asset name prefix produced by the release workflow (normalise step). */
export const RELEASE_PREFIX = 'lab-server-monitor-Windows-x64-v';

/** Default auto-check cadence: once per day. */
export const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface AssetLike {
  name?: string | null;
  url?: string | null;
  browser_download_url?: string | null;
  size?: number | null;
}

export interface ReleaseLike {
  tag_name?: string | null;
  name?: string | null;
  body?: string | null;
  html_url?: string | null;
  prerelease?: boolean | null;
  draft?: boolean | null;
  assets?: AssetLike[] | null;
}

export interface UpdateAsset {
  /** Matched zip asset name. */
  name: string;
  /** Normalised version (leading `v` stripped). */
  version: string;
  /** Preferred download URL (GitHub API asset URL, falling back to browser URL). */
  url: string;
  /** Browser download URL, when present. */
  browserUrl: string | null;
  /** Declared asset size in bytes (0 when unknown). */
  size: number;
  /** Matching `.sha256` sidecar asset name, when present. */
  sha256Name: string | null;
  /** Matching `.sha256` sidecar download URL, when present. */
  sha256Url: string | null;
}

/** Strip a leading `v`/`V` and surrounding whitespace. */
export function normaliseVersion(version: string | null | undefined): string {
  return String(version ?? '')
    .trim()
    .replace(/^v/i, '');
}

/**
 * Split a version into numeric parts. A trailing prerelease/build label
 * (`-beta.1`, `+build`) is discarded, matching the legacy updater's behaviour.
 */
function versionParts(version: string | null | undefined): number[] {
  const cleaned = normaliseVersion(version).split('-')[0].split('+')[0];
  return cleaned.split('.').map((part) => {
    const number = Number.parseInt(part, 10);
    return Number.isFinite(number) ? number : 0;
  });
}

/**
 * Compare two versions numerically. Returns 1 when `left > right`, -1 when
 * `left < right`, and 0 when equal. Missing components count as 0.
 */
export function compareVersions(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** True when `candidate` is strictly newer than `current`. */
export function isNewer(
  candidate: string | null | undefined,
  current: string | null | undefined,
): boolean {
  return compareVersions(candidate, current) > 0;
}

/** Major version component (0 when absent/unparsable). */
export function majorOf(version: string | null | undefined): number {
  return versionParts(version)[0] ?? 0;
}

/**
 * Only releases on the same major line as the running build are eligible.
 * Guards against the stray `v1.x` release line being offered to a `0.1.x`
 * install (which would otherwise look "newer" and cause a downgrade loop).
 */
export function isSameMajor(
  current: string | null | undefined,
  candidate: string | null | undefined,
): boolean {
  return majorOf(candidate) === majorOf(current);
}

/** A release is a prerelease when flagged either prerelease or draft. */
export function isPrerelease(release: ReleaseLike | null | undefined): boolean {
  return Boolean(release && (release.prerelease || release.draft));
}

function assetName(asset: AssetLike | null | undefined): string {
  return String((asset && asset.name) || '');
}

function assetUrl(asset: AssetLike | null | undefined): string {
  return String((asset && (asset.url || asset.browser_download_url)) || '');
}

/**
 * Locate the Windows zip for a release and its `.sha256` sidecar.
 *
 * Prefers the exact `lab-server-monitor-Windows-x64-v<version>.zip` name, then
 * any zip carrying the release prefix, then (when no version hint is available)
 * the only zip present. Returns `null` when no eligible zip exists — never
 * blindly picks an arbitrary `.zip`.
 */
export function pickUpdateAsset(
  release: ReleaseLike | null | undefined,
  version?: string | null,
): UpdateAsset | null {
  const assets = Array.isArray(release && release.assets) ? release!.assets! : [];
  const zips = assets.filter((asset) => {
    const name = assetName(asset);
    return /\.zip$/i.test(name) && !/\.sha256$/i.test(name);
  });

  const resolvedVersion = normaliseVersion(version ?? (release && release.tag_name));
  const expectedName = resolvedVersion ? `${RELEASE_PREFIX}${resolvedVersion}.zip` : '';

  let zip: AssetLike | null = null;
  if (expectedName) {
    zip = zips.find((asset) => assetName(asset) === expectedName) ?? null;
  }
  if (!zip) {
    zip = zips.find((asset) => assetName(asset).startsWith(RELEASE_PREFIX)) ?? null;
  }
  if (!zip && !resolvedVersion && zips.length === 1) {
    zip = zips[0];
  }
  if (!zip) return null;

  const zipName = assetName(zip);
  const sha =
    assets.find((asset) => assetName(asset) === `${zipName}.sha256`) ??
    assets.find((asset) => /\.zip\.sha256$/i.test(assetName(asset))) ??
    null;

  return {
    name: zipName,
    version: resolvedVersion,
    url: assetUrl(zip),
    browserUrl: (zip.browser_download_url as string) || null,
    size: Number.isFinite(Number(zip.size)) ? Number(zip.size) : 0,
    sha256Name: sha ? assetName(sha) : null,
    sha256Url: sha ? assetUrl(sha) : null,
  };
}

/**
 * Decide whether an update should be offered. Pure; encodes the same
 * same-major / exclude-prerelease / strictly-newer rules the updater applies.
 */
export type ReleaseDecision =
  | {
      status: 'update-available';
      version: string;
      asset: UpdateAsset;
      notes: string;
      releaseUrl: string;
    }
  | { status: 'up-to-date'; version: string; reason?: string }
  | { status: 'error'; error: string };

export function decideUpdate(
  currentVersion: string,
  release: ReleaseLike | null | undefined,
): ReleaseDecision {
  const version = normaliseVersion(release && release.tag_name);
  if (!version) return { status: 'error', error: '最新版本缺少 tag_name' };
  if (isPrerelease(release)) return { status: 'up-to-date', version, reason: 'prerelease' };
  if (!isSameMajor(currentVersion, version)) {
    return { status: 'up-to-date', version, reason: 'major-mismatch' };
  }
  if (!isNewer(version, currentVersion)) return { status: 'up-to-date', version };

  const asset = pickUpdateAsset(release, version);
  if (!asset || !asset.url) {
    return { status: 'error', error: '最新版本没有可下载的 Windows 程序包' };
  }
  return {
    status: 'update-available',
    version,
    asset,
    notes: String((release && release.body) || ''),
    releaseUrl: String((release && release.html_url) || ''),
  };
}

/**
 * Whether enough time has elapsed since the last check. A missing/invalid
 * timestamp means "check now". `now` and `lastCheckedAt` are epoch millis.
 */
export function shouldCheck(opts: {
  lastCheckedAt?: number | null;
  now: number;
  intervalMs?: number;
}): boolean {
  const interval = Number.isFinite(opts.intervalMs as number)
    ? (opts.intervalMs as number)
    : DEFAULT_CHECK_INTERVAL_MS;
  const last = opts.lastCheckedAt == null ? NaN : Number(opts.lastCheckedAt);
  if (!Number.isFinite(last) || last <= 0) return true;
  return opts.now - last >= interval;
}
