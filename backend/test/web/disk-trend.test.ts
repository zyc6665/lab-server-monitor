/**
 * Disk-trend front-end module (M6): pure helpers plus a jsdom render check for
 * the status strip and temperature polyline.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const staticDir = path.join(__dirname, '..', '..', 'assets', 'web', 'static');

async function loadModule(): Promise<Record<string, any>> {
  const source = readFileSync(path.join(staticDir, 'pages', 'disk-trend.js'), 'utf8');
  const url = 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64');
  return import(/* @vite-ignore */ url);
}

function installDom(html: string): void {
  const dom = new JSDOM(html, { url: 'http://localhost/disk-health' });
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
}

afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).document;
});

describe('disk-trend helpers', () => {
  it('maps statuses to strip classes', async () => {
    installDom('<!doctype html><html><body></body></html>');
    const m = await loadModule();
    expect(m.statusClass('ok')).toBe('ok');
    expect(m.statusClass('degraded')).toBe('warning');
    expect(m.statusClass('error')).toBe('critical');
    expect(m.statusClass('no_storcli')).toBe('muted');
    expect(m.statusClass(undefined)).toBe('unknown');
  });

  it('builds one titled segment per point', async () => {
    installDom('<!doctype html><html><body></body></html>');
    const m = await loadModule();
    const segments = m.buildStatusSegments([
      { t: '2026-11-01T08:00:00+08:00', status: 'ok', drives: 2, warning: 0, critical: 0, max_temp: 33 },
      { t: '2026-11-02T08:00:00+08:00', status: 'degraded', drives: 2, healthy: 1, warning: 1, critical: 0, max_temp: 44 },
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[1].cls).toBe('warning');
    expect(segments[1].title).toContain('degraded');
    expect(segments[1].title).toContain('告警 1');
    expect(segments[1].title).toContain('最高 44 °C');
  });

  it('extracts only numeric temperature points', async () => {
    installDom('<!doctype html><html><body></body></html>');
    const m = await loadModule();
    const series = m.buildTempSeries([
      { max_temp: 30 },
      { max_temp: null },
      { max_temp: 41 },
    ]);
    expect(series.map((item: any) => item.value)).toEqual([30, 41]);
  });
});

describe('renderDiskTrend under a real DOM', () => {
  it('renders the status strip and a temperature chart', async () => {
    installDom('<!doctype html><html><body><div id="panel"></div></body></html>');
    const m = await loadModule();
    const panel = document.getElementById('panel') as HTMLElement;
    const ok = m.renderDiskTrend(panel, [
      { t: 'a', status: 'ok', drives: 1, max_temp: 30 },
      { t: 'b', status: 'ok', drives: 1, max_temp: 33 },
      { t: 'c', status: 'degraded', drives: 1, max_temp: 44 },
    ]);
    expect(ok).toBe(true);
    expect(panel.querySelectorAll('.disk-trend-seg')).toHaveLength(3);
    expect(panel.querySelector('svg.disk-trend-chart')).not.toBeNull();
    expect(panel.querySelectorAll('polyline')).toHaveLength(1);
  });

  it('renders an empty hint when there are no points', async () => {
    installDom('<!doctype html><html><body><div id="panel"></div></body></html>');
    const m = await loadModule();
    const panel = document.getElementById('panel') as HTMLElement;
    expect(m.renderDiskTrend(panel, [])).toBe(false);
    expect(panel.querySelector('.disk-trend-empty')).not.toBeNull();
  });
});
