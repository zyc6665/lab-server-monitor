/**
 * Unit tests for the SSRF guard.
 *
 * Resolution is always injected, so these tests never touch the network. The
 * behaviour mirrors `servermanage/web/routes/_core.py::_reject_unsafe_target`.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError } from '../../../src/config/errors';
import {
  SSRFError,
  assertSafeTarget,
  extractHost,
  isInternalIp,
} from '../../../src/web/security/ssrf';

const lookupTo = (...addresses: string[]) => (): { address: string; family: number }[] =>
  addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

function expectReject(promise: Promise<void>, host: string): Promise<void> {
  return expect(promise).rejects.toThrow(
    new SSRFError(host),
  );
}

describe('isInternalIp', () => {
  it('flags loopback / private / reserved IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '127.8.9.10',
      '10.0.0.1',
      '172.16.5.4',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '0.1.2.3',
      '192.0.0.1',
      '192.0.0.8',
      '192.0.0.170',
      '192.0.2.5',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isInternalIp(ip), ip).toBe(true);
    }
  });

  it('matches ipaddress carve-outs and non-private ranges', () => {
    // 192.0.0.9/.10 are public exceptions inside 192.0.0.0/24.
    expect(isInternalIp('192.0.0.9')).toBe(false);
    expect(isInternalIp('192.0.0.10')).toBe(false);
    // 100.64.0.0/10 is "shared", which ipaddress does NOT treat as private.
    expect(isInternalIp('100.64.0.1')).toBe(false);
    expect(isInternalIp('192.88.99.1')).toBe(false);
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1']) {
      expect(isInternalIp(ip), ip).toBe(false);
    }
  });

  it('flags loopback / private / link-local / reserved IPv6', () => {
    for (const ip of [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '2001:db8::1',
      '100::1',
      '200::1',
      '400::1',
      '64:ff9b::1',
      '3fff::1',
    ]) {
      expect(isInternalIp(ip), ip).toBe(true);
    }
  });

  it('allows public IPv6', () => {
    expect(isInternalIp('2606:4700:4700::1111')).toBe(false);
    expect(isInternalIp('2001:4860:4860::8888')).toBe(false);
  });

  it('unwraps IPv4-mapped IPv6 (dotted and hex forms)', () => {
    expect(isInternalIp('::ffff:127.0.0.1')).toBe(true);
    expect(isInternalIp('::ffff:7f00:1')).toBe(true);
    expect(isInternalIp('::ffff:8.8.8.8')).toBe(false);
    expect(isInternalIp('::ffff:808:808')).toBe(false);
  });

  it('treats unknown input as non-internal', () => {
    expect(isInternalIp('not-an-ip')).toBe(false);
    expect(isInternalIp('')).toBe(false);
  });
});

describe('extractHost', () => {
  it('parses URLs, bare hosts, ports and bracketed IPv6', () => {
    expect(extractHost('https://example.com:8443/x?y=1')).toBe('example.com');
    expect(extractHost('HTTP://EXAMPLE.COM/')).toBe('example.com');
    expect(extractHost('example.com:443')).toBe('example.com');
    expect(extractHost('http://[::1]:8080/')).toBe('::1');
    expect(extractHost('127.0.0.1')).toBe('127.0.0.1');
    expect(extractHost('')).toBe('');
    expect(extractHost('   ')).toBe('');
  });
});

describe('assertSafeTarget', () => {
  it('rejects a literal loopback URL', async () => {
    await expectReject(assertSafeTarget('http://127.0.0.1:8080/admin', { env: {} }), '127.0.0.1');
  });

  it('rejects localhost after resolution', async () => {
    await expectReject(
      assertSafeTarget('http://localhost:3000/', { env: {}, lookup: lookupTo('127.0.0.1') }),
      'localhost',
    );
  });

  it('rejects private / link-local / reserved targets', async () => {
    for (const ip of ['10.1.2.3', '172.16.0.9', '192.168.9.9', '169.254.169.254', '240.0.0.1']) {
      await expectReject(assertSafeTarget(ip, { env: {} }), ip);
    }
  });

  it('rejects internal IPv6 targets', async () => {
    for (const ip of ['::1', 'fc00::5', 'fe80::1', 'ff05::1']) {
      await expectReject(assertSafeTarget(`http://[${ip}]/`, { env: {} }), ip);
    }
  });

  it('rejects when ANY resolved address is internal', async () => {
    await expectReject(
      assertSafeTarget('http://mixed.example/', {
        env: {},
        lookup: lookupTo('93.184.216.34', '10.0.0.5'),
      }),
      'mixed.example',
    );
  });

  it('allows public targets', async () => {
    await expect(assertSafeTarget('https://example.com/', { env: {}, lookup: lookupTo('93.184.216.34') })).resolves.toBeUndefined();
    await expect(assertSafeTarget('8.8.8.8', { env: {} })).resolves.toBeUndefined();
    await expect(assertSafeTarget('http://[2606:4700:4700::1111]/', { env: {} })).resolves.toBeUndefined();
  });

  it('allows unresolvable hosts through (nothing to dial)', async () => {
    const failing = () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    await expect(
      assertSafeTarget('http://does-not-exist.invalid/', { env: {}, lookup: failing }),
    ).resolves.toBeUndefined();
  });

  it('lets SSRF_ALLOW_PRIVATE bypass the check', async () => {
    await expect(
      assertSafeTarget('http://10.0.0.5/', { env: { SSRF_ALLOW_PRIVATE: '1' } }),
    ).resolves.toBeUndefined();
    await expect(
      assertSafeTarget('http://10.0.0.5/', {
        env: { SSRF_ALLOW_PRIVATE: 'false' },
        lookup: lookupTo('10.0.0.5'),
      }),
    ).rejects.toThrow(SSRFError);
  });

  it('honours SERVERMONITOR_ALLOW_PRIVATE_TARGETS', async () => {
    await expect(
      assertSafeTarget('http://192.168.0.1/', { env: { SERVERMONITOR_ALLOW_PRIVATE_TARGETS: 'yes' } }),
    ).resolves.toBeUndefined();
  });

  it('lets an explicit allowPrivate flag win over the env', async () => {
    await expect(
      assertSafeTarget('http://10.0.0.5/', {
        env: { SSRF_ALLOW_PRIVATE: '1' },
        allowPrivate: false,
        lookup: lookupTo('10.0.0.5'),
      }),
    ).rejects.toThrow(SSRFError);
  });

  it('allows hosts on the configured allowlist', async () => {
    await expect(
      assertSafeTarget('http://internal.example/', {
        env: {},
        allowlist: ['Internal.Example'],
        lookup: lookupTo('10.0.0.5'),
      }),
    ).resolves.toBeUndefined();
  });

  it('produces the oracle error message and type', async () => {
    const error = await assertSafeTarget('http://10.1.2.3/', { env: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SSRFError);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe('目标地址 10.1.2.3 指向内网/保留地址，已拒绝访问');
  });

  it('ignores empty input', async () => {
    await expect(assertSafeTarget('', { env: {} })).resolves.toBeUndefined();
  });
});
