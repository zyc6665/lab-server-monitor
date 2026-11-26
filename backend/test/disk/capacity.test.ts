/**
 * Tests for `src/disk/capacity.ts` — 1:1 port of `servermanage/disk_capacity.py:32-138`.
 *
 * The pure helpers (`normalizeMounts`, `mountStatuses`, `maxPercent`) are driven
 * against hand-built rows.  The internal `_row_value`/`_parse_percent` are
 * exercised indirectly through `mountStatuses`, which is how the Python oracle
 * uses them.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DISK_MOUNTS,
  VIRTUAL_FILESYSTEMS,
  maxPercent,
  mountStatuses,
  normalizeMounts,
  type DiskUsageRowLike,
} from '../../src/disk/capacity';

/** A realistic good row (`df -P` style strings). */
function row(overrides: DiskUsageRowLike = {}): DiskUsageRowLike {
  return {
    mountpoint: '/',
    filesystem: '/dev/sda1',
    size: '100G',
    used: '40G',
    available: '60G',
    percent: '40%',
    ...overrides,
  };
}

describe('normalizeMounts', () => {
  it('falls back to the defaults for null / undefined / empty input', () => {
    expect(normalizeMounts(null)).toEqual(['/', '/data']);
    expect(normalizeMounts(undefined)).toEqual(['/', '/data']);
    expect(normalizeMounts([])).toEqual(['/', '/data']);
    expect(DEFAULT_DISK_MOUNTS).toEqual(['/', '/data']);
  });

  it('trims, drops blanks/duplicates and preserves first-seen order', () => {
    expect(normalizeMounts([' / ', '/data', '  ', '/', '/mnt/x', '/mnt/x'])).toEqual([
      '/',
      '/data',
      '/mnt/x',
    ]);
  });

  it('skips null / undefined entries and falls back when everything is blank', () => {
    expect(normalizeMounts([null, undefined, '  '])).toEqual(['/', '/data']);
    expect(normalizeMounts(['/data', null, '/'])).toEqual(['/data', '/']);
  });
});

describe('mountStatuses — entry shape and order', () => {
  it('reports a configured-but-unreported mount as a missing entry', () => {
    const statuses = mountStatuses([row({ mountpoint: '/' })], ['/', '/data']);
    const data = statuses.find((s) => s.mountpoint === '/data');
    expect(data).toEqual({
      mountpoint: '/data',
      present: false,
      filesystem: null,
      size: null,
      used: null,
      available: null,
      percent: null,
      status: 'missing',
    });
  });

  it('returns every configured mount in order, present or not', () => {
    const statuses = mountStatuses(
      [row({ mountpoint: '/data', filesystem: '/dev/sdb1', percent: '70%' })],
      ['/', '/data', '/mnt/x'],
    );
    expect(statuses.map((s) => s.mountpoint)).toEqual(['/', '/data', '/mnt/x']);
    expect(statuses.map((s) => s.present)).toEqual([false, true, false]);
  });

  it('passes through the raw row fields and parses percent for a present mount', () => {
    const statuses = mountStatuses(
      [
        row({
          mountpoint: '/data',
          filesystem: '/dev/sdb1',
          size: '500G',
          used: '250G',
          available: '250G',
          percent: '50%',
        }),
      ],
      ['/data'],
    );
    expect(statuses[0]).toEqual({
      mountpoint: '/data',
      present: true,
      filesystem: '/dev/sdb1',
      size: '500G',
      used: '250G',
      available: '250G',
      percent: 50,
      status: 'ok',
    });
  });

  it('uses the default mount list when mounts is null', () => {
    const statuses = mountStatuses([], null);
    expect(statuses.map((s) => s.mountpoint)).toEqual(['/', '/data']);
    expect(statuses.every((s) => s.status === 'missing')).toBe(true);
  });

  it('leaves fields null when the row omits them', () => {
    const statuses = mountStatuses([{ mountpoint: '/only', percent: '10%' }], ['/only']);
    expect(statuses[0].filesystem).toBeNull();
    expect(statuses[0].size).toBeNull();
    expect(statuses[0].used).toBeNull();
    expect(statuses[0].available).toBeNull();
    expect(statuses[0].percent).toBe(10);
  });
});

describe('percent parsing (_parse_percent)', () => {
  const cases: Array<[string, unknown, number | null]> = [
    ['"12%"', '12%', 12],
    ['"12.5%"', '12.5%', 12.5],
    ['"0%"', '0%', 0],
    ['empty string', '', null],
    ['None/null', null, null],
    ['undefined', undefined, null],
    ['non-numeric "n/a"', 'n/a', null],
    ['bare percent sign "%"', '%', null],
    ['plain number 42', 42, 42],
    ['float number 12.5', 12.5, 12.5],
    ['boolean true', true, null],
    ['boolean false', false, null],
    ['malformed "12.5.6" -> null (Python float ValueError)', '12.5.6', null],
  ];

  for (const [label, raw, expected] of cases) {
    it(`parses ${label} as ${String(expected)}`, () => {
      const statuses = mountStatuses([{ mountpoint: '/', percent: raw }], ['/']);
      expect(statuses[0].percent).toBe(expected);
      expect(statuses[0].status === 'unknown').toBe(expected === null);
    });
  }
});

describe('virtual filesystems', () => {
  it('exposes the Python VIRTUAL_FILESYSTEMS set', () => {
    expect(VIRTUAL_FILESYSTEMS.has('tmpfs')).toBe(true);
    expect(VIRTUAL_FILESYSTEMS.has('overlay')).toBe(true);
    expect(VIRTUAL_FILESYSTEMS.has('ext4')).toBe(false);
  });

  it('treats a tmpfs-backed mount as absent (missing)', () => {
    const statuses = mountStatuses(
      [row({ mountpoint: '/', filesystem: 'tmpfs', percent: '85%' })],
      ['/'],
    );
    expect(statuses[0].present).toBe(false);
    expect(statuses[0].status).toBe('missing');
    expect(statuses[0].percent).toBeNull();
  });

  it('keeps the first non-virtual row when a mount is reported twice', () => {
    const first = row({ mountpoint: '/', filesystem: 'tmpfs', percent: '99%' });
    const second = row({ mountpoint: '/', filesystem: '/dev/sda1', percent: '30%' });
    const third = row({ mountpoint: '/', filesystem: '/dev/sdz9', percent: '80%' });
    const statuses = mountStatuses([first, second, third], ['/']);
    expect(statuses[0].present).toBe(true);
    expect(statuses[0].filesystem).toBe('/dev/sda1');
    expect(statuses[0].percent).toBe(30);
  });

  it('skips a row whose mountpoint is null/undefined', () => {
    const statuses = mountStatuses(
      [{ mountpoint: null, percent: '99%' }, { percent: '99%' }, row({ mountpoint: '/', percent: '10%' })],
      ['/'],
    );
    expect(statuses[0].present).toBe(true);
    expect(statuses[0].percent).toBe(10);
  });
});

describe('thresholds (status verdict)', () => {
  it('defaults: <90 ok, =90 warning, 90..<95 warning, =95 critical, >95 critical', () => {
    const value = (percent: string): string =>
      mountStatuses([row({ mountpoint: '/', percent })], ['/'])[0].status;
    expect(value('89.9%')).toBe('ok');
    expect(value('90%')).toBe('warning');
    expect(value('94.9%')).toBe('warning');
    expect(value('95%')).toBe('critical');
    expect(value('99%')).toBe('critical');
  });

  it('honours custom warning/critical thresholds (inclusive at the boundary)', () => {
    const opts = { thresholds: { warning: 80, critical: 90 } };
    const value = (percent: string): string =>
      mountStatuses([row({ mountpoint: '/', percent })], ['/'], opts)[0].status;
    expect(value('79.9%')).toBe('ok');
    expect(value('80%')).toBe('warning');
    expect(value('89.9%')).toBe('warning');
    expect(value('90%')).toBe('critical');
  });

  it('reports a present mount without a usable percent as unknown', () => {
    const statuses = mountStatuses([row({ mountpoint: '/', percent: 'n/a' })], ['/'], {
      thresholds: { warning: 10, critical: 20 },
    });
    expect(statuses[0].present).toBe(true);
    expect(statuses[0].percent).toBeNull();
    expect(statuses[0].status).toBe('unknown');
  });
});

describe('maxPercent', () => {
  it('returns the highest usage across the configured present mounts', () => {
    const rows = [
      row({ mountpoint: '/', percent: '40%' }),
      row({ mountpoint: '/data', filesystem: '/dev/sdb1', percent: '75%' }),
    ];
    expect(maxPercent(rows, ['/', '/data'])).toBe(75);
  });

  it('ignores missing, unknown-percent and virtual mounts', () => {
    const rows = [
      row({ mountpoint: '/', filesystem: 'tmpfs', percent: '99%' }),
      row({ mountpoint: '/data', filesystem: '/dev/sdb1', percent: 'n/a' }),
    ];
    // only /mnt/a is present with a usable percent
    rows.push(row({ mountpoint: '/mnt/a', filesystem: '/dev/sdc1', percent: '55%' }));
    expect(maxPercent(rows, ['/', '/data', '/mnt/a'])).toBe(55);
  });

  it('returns null when no configured mount is present with a usable percent', () => {
    expect(maxPercent([], ['/'])).toBeNull();
    expect(maxPercent([row({ mountpoint: '/', percent: 'n/a' })], ['/'])).toBeNull();
  });

  it('falls back to the default mounts when mounts is null', () => {
    const rows = [
      row({ mountpoint: '/', percent: '20%' }),
      row({ mountpoint: '/data', filesystem: '/dev/sdb1', percent: '88%' }),
      row({ mountpoint: '/ignored', percent: '100%' }),
    ];
    expect(maxPercent(rows, null)).toBe(88);
  });
});

describe('_row_value duck typing', () => {
  it('reads plain dict-like rows', () => {
    const statuses = mountStatuses([{ mountpoint: '/', filesystem: '/dev/sda1', percent: '12%' }], ['/']);
    expect(statuses[0].present).toBe(true);
    expect(statuses[0].percent).toBe(12);
  });

  it('reads class-instance rows (getattr path)', () => {
    class UsageRow {
      constructor(
        readonly mountpoint: string,
        readonly filesystem: string,
        readonly size: string,
        readonly used: string,
        readonly available: string,
        readonly percent: string,
      ) {}
    }
    const statuses = mountStatuses(
      [new UsageRow('/data', '/dev/sdb1', '200G', '120G', '80G', '60%')],
      ['/data'],
    );
    expect(statuses[0].present).toBe(true);
    expect(statuses[0].filesystem).toBe('/dev/sdb1');
    expect(statuses[0].percent).toBe(60);
    expect(statuses[0].status).toBe('ok');
  });

  it('ignores null rows in the input list', () => {
    const statuses = mountStatuses(
      [null as unknown as DiskUsageRowLike, row({ mountpoint: '/', percent: '10%' })],
      ['/'],
    );
    expect(statuses[0].present).toBe(true);
    expect(statuses[0].percent).toBe(10);
  });
});
