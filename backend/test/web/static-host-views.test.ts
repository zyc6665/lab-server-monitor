import { describe, expect, it } from 'vitest';

class El {
  tagName: string; children: any[] = []; attrs: Record<string, string> = {}; className = ''; textContent = '';
  style: any = {}; dataset: any = {}; hidden = false; title = ''; href = ''; type = '';
  constructor(tag: string) { this.tagName = tag; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  appendChild(c: any) { this.children.push(c); return c; }
  removeChild(c: any) { this.children = this.children.filter((x) => x !== c); return c; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener() {}
  append() {}
  get firstChild() { return this.children[0] ?? null; }
  classList = { add: () => {}, remove: () => {}, toggle: () => {} };
}
(globalThis as any).document = {
  createElement: (t: string) => new El(t),
  createElementNS: (_ns: string, t: string) => new El(t),
  createTextNode: (t: string) => ({ nodeValue: t, textContent: t }),
  getElementById: () => null,
};

describe('host row builds without reference errors', () => {
  it('builds a row', async () => {
    const { buildHostRow, buildHostCard } = await import('../../assets/web/static/pages/host-views.js' as any);
    const payload = { name: 'h1', host: '1.2.3.4', online: true, cpu_percent: 5, memory_percent: 10, disk_percent: 20, gpu_memory_percent: 30, checks: {}, disk_health: { status: 'ok' }, collection_uptime: { samples: 1, expected: 1 } };
    expect(buildHostRow(payload)).toBeTruthy();
    expect(buildHostCard(payload)).toBeTruthy();
  });
});
