/**
 * SSRF guard for admin-triggered outbound dial-outs.
 *
 * Mirrors `servermanage/web/routes/_core.py`:
 *   - `_reject_unsafe_target(host)` resolves a hostname via `getaddrinfo` and
 *     rejects it when any resolved address is loopback / private / link-local /
 *     reserved / multicast / unspecified.
 *   - `_reject_unsafe_url(url)` extracts the hostname (`urlsplit().hostname`)
 *     then delegates to the host check.
 *   - `_ssrf_allow_private()` honours `SSRF_ALLOW_PRIVATE` /
 *     `SERVERMONITOR_ALLOW_PRIVATE_TARGETS` as an escape hatch.
 *   - configured inventory hosts are always allowed, and a host that cannot be
 *     resolved is allowed through (there is nothing to dial).
 *
 * The Python oracle returns a rejection message; `assertSafeTarget` throws an
 * {@link SSRFError} instead so a caller cannot accidentally ignore it.
 */
import { BlockList, isIP } from 'node:net';
import { lookup as defaultLookup } from 'node:dns/promises';

import { ConfigError } from '../../config/errors';

/** One resolved address (`dns.lookup`/`getaddrinfo` result). */
export interface LookupAddress {
  address: string;
  family: number;
}

/** Injectable resolver: may be sync (tests) or async (default `dns.lookup`). */
export type LookupHost = (host: string) => Promise<LookupAddress[]> | LookupAddress[];

/** Options for {@link assertSafeTarget}. */
export interface AssertSafeTargetOptions {
  /** Resolver override; defaults to `dns.promises.lookup(host, { all: true })`. */
  lookup?: LookupHost;
  /**
   * Force the private-target escape hatch on/off. When omitted, the
   * `SSRF_ALLOW_PRIVATE` / `SERVERMONITOR_ALLOW_PRIVATE_TARGETS` env vars decide.
   */
  allowPrivate?: boolean;
  /** Configured inventory hosts/names (compared case-insensitively after trim). */
  allowlist?: Iterable<string>;
  /** Environment map for the escape-hatch vars (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Raised when a target would reach an internal address.
 *
 * Extends {@link ConfigError} so callers already handling settings/config
 * failures catch it too, and keeps the oracle's exact user-facing message.
 */
export class SSRFError extends ConfigError {
  constructor(host: string) {
    super(`目标地址 ${host} 指向内网/保留地址，已拒绝访问`);
    this.name = 'SSRFError';
  }
}

/**
 * Networks Python's `ipaddress` classifies as loopback / private / link-local /
 * reserved / multicast (union of the IPv4 `ipaddress` tables plus unspecified).
 * Kept literal so the guard stays in lockstep with the oracle.
 */
const BLOCKED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // private: "this network"
  ['10.0.0.0', 8], // RFC1918
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments (minus exceptions below)
  ['192.0.0.170', 31],
  ['192.0.2.0', 24], // documentation (TEST-NET-1)
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation (TEST-NET-2)
  ['203.0.113.0', 24], // documentation (TEST-NET-3)
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
  ['255.255.255.255', 32], // broadcast
];

/** IPv6 union of `ipaddress` private + reserved + multicast + loopback + unspecified networks. */
const BLOCKED_IPV6: ReadonlyArray<readonly [string, number]> = [
  ['::', 8],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 8],
  ['200::', 7],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['400::', 6],
  ['800::', 5],
  ['1000::', 4],
  ['4000::', 3],
  ['6000::', 3],
  ['8000::', 3],
  ['a000::', 3],
  ['c000::', 3],
  ['e000::', 4],
  ['f000::', 5],
  ['f800::', 6],
  ['fe00::', 9],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

/** IPv4 addresses `ipaddress` carves out of the 192.0.0.0/24 private block. */
const IPV4_PRIVATE_EXCEPTIONS: ReadonlySet<string> = new Set(['192.0.0.9', '192.0.0.10']);

/** IPv6 addresses `ipaddress` carves out of the 2001::/23 private block. */
const BLOCKED_IPV6_EXCEPTIONS: ReadonlyArray<readonly [string, number]> = [
  ['2001:1::1', 128],
  ['2001:1::2', 128],
  ['2001:3::', 32],
  ['2001:4:112::', 48],
  ['2001:20::', 28],
  ['2001:30::', 28],
];

const blockListV4 = new BlockList();
for (const [address, prefix] of BLOCKED_IPV4) {
  blockListV4.addSubnet(address, prefix, 'ipv4');
}

const blockListV6 = new BlockList();
for (const [address, prefix] of BLOCKED_IPV6) {
  blockListV6.addSubnet(address, prefix, 'ipv6');
}

const blockListV6Exceptions = new BlockList();
for (const [address, prefix] of BLOCKED_IPV6_EXCEPTIONS) {
  blockListV6Exceptions.addSubnet(address, prefix, 'ipv6');
}

const IPV4_MAPPED_DOTTED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const IPV4_MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/** Strip surrounding brackets and any `%zone` suffix from an IP literal. */
function normalizeIp(address: string): string {
  let value = address.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }
  const zone = value.indexOf('%');
  if (zone >= 0) {
    value = value.slice(0, zone);
  }
  return value;
}

/** Extract the embedded IPv4 of an IPv4-mapped IPv6 address, if present. */
function mappedIpv4(address: string): string | null {
  const dotted = IPV4_MAPPED_DOTTED.exec(address);
  if (dotted) {
    return dotted[1];
  }
  const hex = IPV4_MAPPED_HEX.exec(address);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }
  return null;
}

function isInternalIpv4(value: string): boolean {
  if (IPV4_PRIVATE_EXCEPTIONS.has(value)) {
    return false;
  }
  return blockListV4.check(value, 'ipv4');
}

function isInternalIpv6(value: string): boolean {
  if (blockListV6Exceptions.check(value, 'ipv6')) {
    return false;
  }
  return blockListV6.check(value, 'ipv6');
}

/**
 * Whether `address` is loopback / private / link-local / reserved / multicast /
 * unspecified (IPv4 and IPv6, including IPv4-mapped IPv6).
 */
export function isInternalIp(address: string): boolean {
  const value = normalizeIp(address);
  const family = isIP(value);
  if (family === 4) {
    return isInternalIpv4(value);
  }
  if (family === 6) {
    const embedded = mappedIpv4(value);
    if (embedded !== null) {
      return isInternalIpv4(embedded);
    }
    return isInternalIpv6(value);
  }
  return false;
}

/**
 * Extract the hostname from either a URL or a bare `host[:port]` string.
 *
 * Returns `''` when the input is empty or an unparseable URL, which callers
 * treat as "nothing to dial" (mirroring `urlsplit` returning no hostname).
 */
export function extractHost(urlOrHost: string): string {
  const value = urlOrHost.trim();
  if (value === '') {
    return '';
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      return normalizeIp(new URL(value).hostname);
    } catch {
      return '';
    }
  }
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) {
    return normalizeIp(bracketed[1]);
  }
  if (isIP(value) !== 0) {
    return normalizeIp(value);
  }
  const hostPort = /^([^:]+):(\d+)$/.exec(value);
  if (hostPort) {
    return hostPort[1];
  }
  return value;
}

/** `_truthy_arg` semantics: `0/false/no/off/empty` are false, anything else true. */
function truthyEnv(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function isAllowlisted(host: string, allowlist: Iterable<string> | undefined): boolean {
  if (allowlist === undefined) {
    return false;
  }
  const target = host.trim().toLowerCase();
  for (const name of allowlist) {
    if (name.trim().toLowerCase() === target) {
      return true;
    }
  }
  return false;
}

async function resolveHost(host: string, lookup: LookupHost | undefined): Promise<LookupAddress[]> {
  const literalFamily = isIP(host);
  if (literalFamily !== 0) {
    return [{ address: host, family: literalFamily }];
  }
  try {
    const result = lookup !== undefined
      ? await lookup(host)
      : await defaultLookup(host, { all: true });
    if (!Array.isArray(result)) {
      return [];
    }
    return result.map((item) => ({
      address: item.address,
      family: item.family ?? isIP(item.address),
    }));
  } catch {
    // Unresolvable: allow through, exactly like `_reject_unsafe_target` does.
    return [];
  }
}

/**
 * Throw {@link SSRFError} when `urlOrHost` resolves to an internal address.
 *
 * @param urlOrHost a webhook URL (`http(s)://…`) or a bare host/host:port
 * @param options injectable resolver / allow-private escape hatch / allowlist
 * @throws {SSRFError} when any resolved address is internal
 */
export async function assertSafeTarget(
  urlOrHost: string,
  options: AssertSafeTargetOptions = {},
): Promise<void> {
  const host = extractHost(urlOrHost);
  if (host === '') {
    return;
  }
  const env = options.env ?? process.env;
  const allowPrivate = options.allowPrivate
    ?? truthyEnv(env.SSRF_ALLOW_PRIVATE || env.SERVERMONITOR_ALLOW_PRIVATE_TARGETS);
  if (allowPrivate) {
    return;
  }
  if (isAllowlisted(host, options.allowlist)) {
    return;
  }
  const addresses = await resolveHost(host, options.lookup);
  for (const entry of addresses) {
    if (isInternalIp(entry.address)) {
      throw new SSRFError(host);
    }
  }
}
