/**
 * DOM 级测试基线（jsdom）：验证从前端模块迁出的“带 DOM 的”函数在真实 DOM 下行为正确，
 * 为后续拆分告警页渲染/概览轮询提供可复用的测试脚手架。
 */
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Mod = Record<string, any>;

async function loadModule(rel: string): Promise<Mod> {
  const url = new URL(`../../assets/web/static/${rel}`, import.meta.url).href;
  return import(/* @vite-ignore */ url);
}

function installDom(html: string): void {
  const dom = new JSDOM(html, { url: 'http://localhost/alerts' });
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).localStorage = dom.window.localStorage;
}

beforeEach(() => installDom('<!doctype html><html><body></body></html>'));
afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).localStorage;
});

describe('alert-table-prefs under a real DOM', () => {
  it('applies stored column widths to table headers', async () => {
    installDom(`
      <table id="alerts-table"><thead><tr>
        <th>级别</th><th>主机</th><th>消息</th>
      </tr></thead><tbody></tbody></table>`);
    localStorage.setItem('alerts:colwidths', JSON.stringify([120, 80]));
    const m = await loadModule('pages/alert-table-prefs.js');
    m.applyTableWidths('alerts-table', 'alerts:colwidths');
    const ths = document.querySelectorAll('#alerts-table thead th');
    expect((ths[0] as HTMLElement).style.width).toBe('120px');
    expect((ths[1] as HTMLElement).style.width).toBe('80px');
  });
});

describe('host-prefs under a real DOM', () => {
  it('toggles table/cards visibility from stored view', async () => {
    installDom(`
      <div id="host-table-wrap"></div>
      <div id="host-cards" hidden></div>
      <button data-host-view="table" class="active"></button>
      <button data-host-view="cards"></button>`);
    localStorage.setItem('overview:host-view', 'cards');
    const m = await loadModule('pages/host-prefs.js');
    expect(m.readHostView()).toBe('cards');
    m.applyHostView('cards');
    const wrap = document.getElementById('host-table-wrap') as HTMLElement;
    const grid = document.getElementById('host-cards') as HTMLElement;
    expect(wrap.hidden).toBe(true);
    expect(grid.hidden).toBe(false);
  });
});

describe('page-status under a real DOM', () => {
  it('shows/hides banner and writes freshness stamp', async () => {
    installDom(`
      <div id="banner" hidden><span class="load-banner-text"></span></div>
      <div id="skel"></div>
      <div id="data-freshness"></div>`);
    const m = await loadModule('pages/page-status.js');
    m.showLoadBanner('banner', '加载失败');
    const banner = document.getElementById('banner') as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.querySelector('.load-banner-text')!.textContent).toBe('加载失败');
    m.hideLoadBanner('banner');
    expect(banner.hidden).toBe(true);
    m.hideSkeleton('skel');
    expect((document.getElementById('skel') as HTMLElement).hidden).toBe(true);
    m.markFreshness(new Date('2026-01-02T03:04:05'));
    const fresh = document.getElementById('data-freshness') as HTMLElement;
    expect(fresh.textContent).toBe('更新于 03:04:05');
    expect(fresh.getAttribute('data-updated-at')).toBeTruthy();
  });
});

describe('alert-row under a real DOM', () => {
  const deps = () => ({
    selectedIds: { 7: true },
    textCell: (text: string, cls?: string) => {
      const td = document.createElement('td');
      td.textContent = text == null ? '' : String(text);
      if (cls) cls.split(' ').forEach((c) => c && td.classList.add(c));
      return td;
    },
    formatRelative: () => '1 分钟前',
    formatStamp: () => '2026-01-01 00:00:00',
    statusText: { active: '未处理', resolved: '已恢复' },
  });

  it('renders active row with checkbox, host link and action buttons', async () => {
    installDom('<table><tbody></tbody></table>');
    const m = await loadModule('pages/alert-row.js');
    const tr = m.buildAlertRow({ id: 7, severity: 'critical', status: 'active', host_name: 'a b', title: 'T', message: 'M' }, deps());
    expect(tr.getAttribute('data-alert-row')).toBe('7');
    expect(tr.querySelector('input.alert-select')!.checked).toBe(true);
    expect(tr.querySelector('a.host-link')!.getAttribute('href')).toBe('/host/a%20b');
    expect(tr.querySelectorAll('button.ack-btn').length).toBe(1);
    expect(tr.querySelectorAll('button.silence-btn').length).toBe(1);
  });

  it('renders resolved rows without checkbox or action buttons', async () => {
    installDom('<div></div>');
    const m = await loadModule('pages/alert-row.js');
    const tr = m.buildAlertRow({ id: 9, severity: 'info', status: 'resolved', host_name: null }, deps());
    expect(tr.querySelector('input.alert-select')).toBeNull();
    expect(tr.querySelectorAll('button').length).toBe(0);
    expect(tr.textContent).toContain('已恢复');
  });
});
