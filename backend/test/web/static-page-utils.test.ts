/**
 * Runtime smoke for extracted browser-side pure utilities (P3-1).
 * The files under assets/web/static are browser ES modules; load them through a
 * data: URL so Node can evaluate them without a bundler or DOM.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const staticDir = join(__dirname, '..', '..', 'assets', 'web', 'static');

async function loadModule(relative: string): Promise<Record<string, any>> {
  const source = readFileSync(join(staticDir, relative), 'utf8');
  const url = 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64');
  return import(url);
}

describe('alert-utils', () => {
  it('labels categories and falls back to the raw value', async () => {
    const m = await loadModule('pages/alert-utils.js');
    expect(m.alertCategoryLabel('cpu')).toBe('CPU');
    expect(m.alertCategoryLabel('unknown-x')).toBe('unknown-x');
  });

  it('buckets timestamps to the range step', async () => {
    const m = await loadModule('pages/alert-utils.js');
    const range = '24h';
    const stepMs = m.TIMELINE_RANGES[range].stepHours * 3600 * 1000;
    const stamp = Date.UTC(2026, 0, 2, 5, 30, 0);
    expect(m.bucketStartFor(stamp, range)).toBe(Math.floor(stamp / stepMs) * stepMs);
    expect(m.bucketStartFor('not-a-date', range)).toBe(0);
  });

  it('builds a fixed-length timeline and counts severities', async () => {
    const m = await loadModule('pages/alert-utils.js');
    const buckets = m.timelineBuckets('7d');
    expect(buckets).toHaveLength(7);
    const sample = buckets[buckets.length - 1];
    const alerts = [
      { created_at: new Date(sample.start + 1000).toISOString(), severity: 'critical' },
      { created_at: new Date(sample.start + 2000).toISOString(), severity: 'warning' },
      { created_at: new Date(sample.start + 3000).toISOString(), severity: 'info' },
    ];
    const built = m.buildAlertTimeline(alerts, '7d');
    expect(built[built.length - 1].critical).toBe(1);
    expect(built[built.length - 1].warning).toBe(1);
    expect(built[built.length - 1].total).toBe(3);
  });
});

describe('view-utils', () => {
  it('maps sort keys to comparable values', async () => {
    const m = await loadModule('pages/view-utils.js');
    expect(m.hostSortValue({ cpu_percent: '12.5' }, 'cpu')).toBe(12.5);
    expect(m.hostSortValue({ online: true }, 'status')).toBe(1);
    expect(m.hostSortValue({ disk_health: { status: 'critical' } }, 'health')).toBe(3);
    expect(m.hostSortValue({ group: 'GPU' }, 'group')).toBe('gpu');
  });

  it('serialises safely and tolerates cycles', async () => {
    const m = await loadModule('pages/view-utils.js');
    expect(m.payloadSignature({ a: 1 })).toBe('{"a":1}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(m.payloadSignature(cyclic)).toBe('');
  });
});

describe('alert-table-prefs', () => {
  it('reads stored widths and tolerates missing document', async () => {
    const store = new Map<string, string>();
    (globalThis as any).window = {
      localStorage: {
        getItem: (k: string) => (store.has(k) ? store.get(k) : null),
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      },
    };
    store.set('alerts:colwidths', JSON.stringify([100, 200]));
    (globalThis as any).document = { getElementById: () => null };
    const m = await loadModule('pages/alert-table-prefs.js');
    expect(m.readTableWidths('alerts:colwidths')).toEqual([100, 200]);
    expect(m.readTableWidths('missing')).toEqual([]);
    expect(() => m.applyTableWidths('alerts-table', 'alerts:colwidths')).not.toThrow();
  });
});

describe('host-prefs', () => {
  it('round-trips filters and matches rows by status/keyword', async () => {
    const store = new Map<string, string>();
    (globalThis as any).window = {
      localStorage: {
        getItem: (k: string) => (store.has(k) ? store.get(k) : null),
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      },
    };
    (globalThis as any).localStorage = (globalThis as any).window.localStorage;
    (globalThis as any).document = { documentElement: { setAttribute() {}, removeAttribute() {}, getAttribute() { return null; } }, querySelectorAll: () => [] };
    const m = await loadModule('pages/host-prefs.js');
    m.saveHostFilters('group-a', 'online', '');
    expect(m.readHostFilters()).toEqual({ group: 'group-a', status: 'online', tag: '' });
    m.saveHostFilters('', '', '');
    expect(m.readHostFilters()).toEqual({});

    const attrs: Record<string, string> = { 'data-group': 'g1', 'data-online': '1', 'data-alert-count': '0', 'data-attention': '0', 'data-silenced': '0', 'data-uptime': '0.99', 'data-search': 'alpha host' };
    const tr = { getAttribute: (k: string) => (k in attrs ? attrs[k] : null), textContent: 'alpha host' };
    expect(m.hostRowMatches(tr, 'g1', 'online', 'alpha', '')).toBe(true);
    expect(m.hostRowMatches(tr, 'g2', '', '', '')).toBe(false);
    expect(m.hostRowMatches(tr, '', 'offline', '', '')).toBe(false);
    expect(m.hostRowMatches(tr, '', '', 'beta', '')).toBe(false);
  });
});

describe('csv-export', () => {
  it('quotes cells and counts rows', async () => {
    const m = await loadModule('pages/csv-export.js');
    expect(m.csvCell('a"b')).toBe('"a""b"');
    expect(m.csvCell(null)).toBe('""');
    const built = m.buildCsv(['a', 'b'], [['1', 'x"y'], ['2', null]]);
    expect(built.count).toBe(2);
    expect(built.text).toBe('"a","b"\r\n"1","x""y"\r\n"2",""');
  });

  it('triggers a download through injected DOM/Blob/URL', async () => {
    const m = await loadModule('pages/csv-export.js');
    const created: any[] = [];
    const doc = {
      body: { appendChild: (n: any) => created.push(n), removeChild: () => {} },
      createElement: () => ({ href: '', download: '', click() { this.clicked = true; } }),
    };
    let revoked = false;
    const URLstub = { createObjectURL: () => 'blob:x', revokeObjectURL: () => { revoked = true; } };
    const Blobstub = class { parts: any[]; opts: any; constructor(parts: any[], opts: any) { this.parts = parts; this.opts = opts; } };
    m.downloadTextFile('t.csv', 'a,b', 'text/csv', { document: doc, URL: URLstub, Blob: Blobstub });
    expect(created.length).toBe(1);
    expect(created[0].download).toBe('t.csv');
    expect(created[0].clicked).toBe(true);
    expect(revoked).toBe(true);
  });
});

describe('alert-filter', () => {
  const alerts = [
    { id: 1, severity: 'critical', host_name: 'h1', title: 'A', message: 'disk full', category: 'system', created_at: '2026-01-01T10:00:00+00:00' },
    { id: 2, severity: 'warning', host_name: 'h2', title: 'B', message: 'cpu high', category: 'system', created_at: '2026-01-01T11:00:00+00:00' },
    { id: 3, severity: 'warning', host_name: 'h1', title: 'C', message: 'mem', category: 'user', created_at: '2026-01-01T09:00:00+00:00' },
  ];

  it('filters by severity/host/group/category/keyword', async () => {
    const m = await loadModule('pages/alert-filter.js');
    const keys = (rows: any[]) => rows.map((r) => r.id).join(',');
    expect(keys(m.matchAlerts(alerts, { severity: 'warning' }))).toBe('2,3');
    expect(keys(m.matchAlerts(alerts, { host: 'h1' }))).toBe('1,3');
    expect(keys(m.matchAlerts(alerts, { category: 'user' }))).toBe('3');
    expect(keys(m.matchAlerts(alerts, { keyword: 'CPU' }))).toBe('2');
    expect(keys(m.matchAlerts(alerts, { group: 'g1' }, { hostGroups: { h2: 'g1' } }))).toBe('2');
    expect(keys(m.matchAlerts(alerts, { group: '未分组' }, { hostGroups: {} }))).toBe('1,2,3');
  });

  it('sorts by created_at in requested order', async () => {
    const m = await loadModule('pages/alert-filter.js');
    expect(m.sortAlerts(alerts, 'desc').map((r: any) => r.id)).toEqual([2, 1, 3]);
    expect(m.sortAlerts(alerts, 'asc').map((r: any) => r.id)).toEqual([3, 1, 2]);
  });

  it('builds a query string, omitting default status', async () => {
    const m = await loadModule('pages/alert-filter.js');
    expect(m.buildAlertsQuery({ status: 'active' })).toBe('');
    expect(m.buildAlertsQuery({ status: 'resolved', severity: 'critical', keyword: 'x y' }))
      .toBe('status=resolved&severity=critical&q=x+y');
  });
});
