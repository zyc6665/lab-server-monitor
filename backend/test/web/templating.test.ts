/**
 * Tests for the Nunjucks compatibility layer (`backend/src/web/templating.ts`).
 *
 * Two layers are exercised:
 *   1. Filters/globals through `Environment.renderString`, asserting the exact
 *      Python/Jinja input→output behaviour of `stamp`, `anchor`, `rate`,
 *      `format`, `tojson`, `min`, `max`, `asset_url` and `csrf_token`.
 *   2. Full template rendering (base/login/overview/hosts) through a real
 *      Express app, proving the reused Jinja templates compile and render 200
 *      HTML with the injected request/session/app_version context.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { SessionManager } from '../../src/web/session';
import { configureNunjucks, createTemplating } from '../../src/web/templating';

const env = configureNunjucks({ appVersion: '0.0.0' });

/** Renders a one-liner through the registered filter set. */
function render(src: string, ctx: Record<string, unknown> = {}): string {
  return env.renderString(src, ctx);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

describe('filter: stamp (ISO -> %m-%d %H:%M)', () => {
  it('renders em dash for empty values', () => {
    expect(render('{{ v|stamp }}', { v: null })).toBe('—');
    expect(render('{{ v|stamp }}', { v: undefined })).toBe('—');
    expect(render('{{ v|stamp }}', { v: '' })).toBe('—');
    expect(render('{{ v|stamp }}', { v: 0 })).toBe('—');
  });

  it('formats a timezone-naive timestamp using its wall clock', () => {
    expect(render('{{ v|stamp }}', { v: '2024-03-05T07:08:09' })).toBe('03-05 07:08');
    expect(render('{{ v|stamp }}', { v: '2024-12-31 23:59:00' })).toBe('12-31 23:59');
    expect(render('{{ v|stamp }}', { v: '2024-01-02T03:04:05.123456' })).toBe('01-02 03:04');
  });

  it('converts a timezone-aware timestamp to local time', () => {
    const d = new Date('2024-03-05T07:08:09Z');
    const expected = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    expect(render('{{ v|stamp }}', { v: '2024-03-05T07:08:09Z' })).toBe(expected);
    expect(render('{{ v|stamp }}', { v: '2024-03-05T07:08:09+00:00' })).toBe(expected);
  });

  it('passes unparseable strings through unchanged', () => {
    expect(render('{{ v|stamp }}', { v: 'not-a-date' })).toBe('not-a-date');
  });
});

describe('filter: anchor (slug)', () => {
  it('slugifies names', () => {
    expect(render('{{ v|anchor }}', { v: 'web 01' })).toBe('web-01');
    expect(render('{{ v|anchor }}', { v: 'a/b:c' })).toBe('a-b-c');
    expect(render('{{ v|anchor }}', { v: 'abc' })).toBe('abc');
    expect(render('{{ v|anchor }}', { v: '  --x--  ' })).toBe('x');
    expect(render('{{ v|anchor }}', { v: '服务器 A' })).toBe('A');
  });

  it('falls back to "host" for empty values', () => {
    expect(render('{{ v|anchor }}', { v: '' })).toBe('host');
    expect(render('{{ v|anchor }}', { v: null })).toBe('host');
  });
});

describe('filter: rate (bytes/s)', () => {
  it('renders em dash for invalid / negative values', () => {
    expect(render('{{ v|rate }}', { v: null })).toBe('—');
    expect(render('{{ v|rate }}', { v: '' })).toBe('—');
    expect(render('{{ v|rate }}', { v: 'abc' })).toBe('—');
    expect(render('{{ v|rate }}', { v: -1 })).toBe('—');
  });

  it('formats whole bytes at index 0 via int(round(...))', () => {
    expect(render('{{ v|rate }}', { v: 0 })).toBe('0 B/s');
    expect(render('{{ v|rate }}', { v: 512 })).toBe('512 B/s');
    expect(render('{{ v|rate }}', { v: 1023 })).toBe('1023 B/s');
    expect(render('{{ v|rate }}', { v: 99.5 })).toBe('100 B/s');
  });

  it('scales by 1024 into KB/MB/GB/TB', () => {
    expect(render('{{ v|rate }}', { v: 1024 })).toBe('1.0 KB/s');
    expect(render('{{ v|rate }}', { v: 1536 })).toBe('1.5 KB/s');
    expect(render('{{ v|rate }}', { v: 1024 * 1024 })).toBe('1.0 MB/s');
    expect(render('{{ v|rate }}', { v: 100 * 1024 })).toBe('100 KB/s');
    expect(render('{{ v|rate }}', { v: 1024 * 1024 * 1024 * 1024 })).toBe('1.0 TB/s');
    expect(render('{{ v|rate }}', { v: 2048 * 1024 * 1024 * 1024 * 1024 })).toBe('2048 TB/s');
  });

  it('accepts numeric strings', () => {
    expect(render('{{ v|rate }}', { v: '1536' })).toBe('1.5 KB/s');
  });
});

describe('filter: format (printf)', () => {
  it('implements the printf subset used by the templates', () => {
    expect(render("{{ '%.1f'|format(3.14159) }}")).toBe('3.1');
    expect(render("{{ '%.0f'|format(99.6) }}")).toBe('100');
    expect(render("{{ '%.2f'|format(1.234) }}")).toBe('1.23');
    expect(render("{{ '%d'|format(42.9) }}")).toBe('42');
    expect(render("{{ '%s'|format('x') }}")).toBe('x');
    expect(render("{{ '%05.1f'|format(3.5) }}")).toBe('003.5');
    expect(render("{{ '100%%'|format() }}")).toBe('100%');
  });
});

describe('filter: tojson', () => {
  it('serialises with HTML-safe escaping and marks output safe', () => {
    expect(render('{{ v|tojson }}', { v: { a: '<b>', c: '&' } })).toBe(
      '{"a":"\\u003cb\\u003e","c":"\\u0026"}',
    );
    expect(render('{{ v|tojson }}', { v: [1, 2] })).toBe('[1,2]');
    expect(render('{{ v|tojson }}', { v: "a'b" })).toBe('"a\\u0027b"');
    expect(render('{{ v|tojson }}', { v: null })).toBe('null');
  });
});

describe('filters: min / max (missing from Nunjucks)', () => {
  it('reduces a list like Jinja', () => {
    expect(render('{{ [3, 1, 2]|min }}')).toBe('1');
    expect(render('{{ [3, 1, 2]|max }}')).toBe('3');
    // The disk_health template composes `[[pct, 0]|max, 100]|min`; keep the
    // arithmetic literal so this stays a pure min/max filter assertion (Nunjucks'
    // `//` precedence differs from Python — see the module report).
    expect(render('{{ [[112, 0]|max, 100]|min }}')).toBe('100');
  });
});

describe('globals: asset_url / csrf_token', () => {
  it('asset_url appends ?v=<APP_VERSION>', () => {
    const versioned = configureNunjucks({ appVersion: '1.2.3' });
    expect(versioned.renderString("{{ asset_url('style.css') }}", {})).toBe('/static/style.css?v=1.2.3');
    expect(versioned.renderString("{{ asset_url('js/app.js') }}", {})).toBe('/static/js/app.js?v=1.2.3');
  });

  it('csrf_token is empty outside a renderPage call', () => {
    expect(render('{{ csrf_token() }}')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Full-template smoke tests
// ---------------------------------------------------------------------------

const SESSION = new SessionManager({ secret: 'templating-test-secret' });

function loggedInCookie(): string {
  return SESSION.createCookie({ logged_in: true, username: 'admin', csrf_token: 'csrf-abc' });
}

function buildApp(renderer: ReturnType<typeof createTemplating>): Express {
  const app = express();
  app.locals.session = SESSION;
  app.locals.webSettings = { mode: 'admin' };

  app.get('/login', (req, res) => {
    renderer.renderPage(res, 'login.html', { active_page: 'login' });
  });
  app.get('/base', (req, res) => {
    renderer.renderPage(res, 'base.html', { active_page: 'overview' });
  });
  app.get('/overview', (req, res) => {
    renderer.renderPage(res, 'overview.html', {
      active_page: 'overview',
      hosts: [],
      summary: { online: 0, offline: 0, active_alerts: 0 },
      meta: { groups: [], tags: [], has_tags: false, has_groups: false },
    });
  });
  app.get('/hosts', (req, res) => {
    renderer.renderPage(res, 'hosts.html', {
      active_page: 'hosts',
      hosts: [
        {
          name: 'web-01',
          host: '10.0.0.1',
          group: 'prod',
          owner: 'alice',
          location: 'lab',
          online: true,
          silenced: false,
          active_alert_count: 2,
          tags: ['Prod', 'GPU'],
          cpu_percent: 42.5,
          memory_percent: 61,
          disk_percent: 80,
          gpu_memory_percent: 0,
          logged_in_user_count: 3,
          checks: { ok: 4, total: 5, failed: 1, unknown: 0 },
          disk_health: { status: 'healthy', healthy: 2, warning: 0, critical: 0 },
          collected_at: '2024-03-05T07:08:09',
        },
      ],
      summary: { online: 1, offline: 0 },
      meta: { groups: ['prod'], tags: ['Prod', 'GPU'], has_tags: true, has_groups: true },
    });
  });
  return app;
}

const renderer = createTemplating({ appVersion: '1.2.3' });
const app = buildApp(renderer);

/** Temporary template root exercising request/session/app_version injection. */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'templating-probe-'));
fs.writeFileSync(
  path.join(tmpDir, 'probe.html'),
  '<p>{{ request.args.get("q", "none") }}|{{ request.query.q }}|{{ request.path }}|{{ request.url }}|{{ session.get("username") }}|{{ app_version }}</p>',
);
const probeTpl = createTemplating({ templatesDir: tmpDir, appVersion: '2.0' });
const probeApp = express();
probeApp.locals.session = SESSION;
probeApp.locals.webSettings = { mode: 'admin' };
probeApp.get('/probe', (req, res) => {
  probeTpl.renderPage(res, 'probe.html', {});
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('template smoke: base.html', () => {
  it('renders the document shell with the static asset cache-buster', async () => {
    const res = await request(app).get('/base').set('Cookie', loggedInCookie());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<!doctype html>');
    expect(res.text).toContain('服务器监控');
    expect(res.text).toContain('/static/style.css?v=1.2.3');
    expect(res.text).toContain('/static/app.js?v=1.2.3');
    expect(res.text).toContain('csrf-abc');
    expect(res.text).toContain('class="sidebar"');
  });
});

describe('template smoke: login.html', () => {
  it('renders the login form and issues a CSRF token cookie', async () => {
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<!doctype html>');
    expect(res.text).toContain('登录控制台');
    expect(res.text).toContain('auth-card');
    expect(res.text).toMatch(/<meta name="csrf-token" content="[^"]+">/);
    expect(res.headers['set-cookie']?.join(';')).toContain('servermonitor_session=');
  });
});

describe('template smoke: overview.html', () => {
  it('renders with the full navigation and page title from page_titles.get()', async () => {
    const res = await request(app).get('/overview').set('Cookie', loggedInCookie());
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="summary-total"');
    expect(res.text).toContain('href="/hosts"');
    expect(res.text).toContain('href="/settings"');
    expect(res.text).toContain('>概览<');
  });
});

describe('template smoke: hosts.html', () => {
  it('renders a host row through pctbar/format/stamp/url_for', async () => {
    const res = await request(app).get('/hosts').set('Cookie', loggedInCookie());
    expect(res.status).toBe(200);
    expect(res.text).toContain('web-01');
    expect(res.text).toContain('href="/host/web-01"');
    expect(res.text).toContain('42.5%');
    expect(res.text).toContain('03-05 07:08');
    expect(res.text).toContain('在线');
    expect(res.text).toContain('data-tags="prod|gpu"');
    expect(res.text).toContain('4/5');
  });
});

describe('renderPage context injection', () => {
  it('exposes request.args.get / request.query / request.path / session / app_version', async () => {
    const res = await request(probeApp).get('/probe?q=hello').set('Cookie', loggedInCookie());
    expect(res.status).toBe(200);
    expect(res.text).toBe('<p>hello|hello|/probe|/probe?q=hello|admin|2.0</p>');
  });
});
