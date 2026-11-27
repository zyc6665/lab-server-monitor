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
