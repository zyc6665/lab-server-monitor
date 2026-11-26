/**
 * Tests for the Jinja→Nunjucks template adapter:
 *  - `preprocessTemplate` rewrites (unit assertions),
 *  - every reused template compiles through the real `createTemplating` loader,
 *  - `host.html` renders its thermal-zone slice (`[:4]`) + `namespace()` stats,
 *  - `disk_health.html` renders the floordiv temperature bar (90% / clamped 100%).
 */
import { describe, expect, it } from 'vitest';

import { defaultTemplatesDir, createTemplating } from '../../src/web/templating';
import { preprocessTemplate } from '../../src/web/template-preprocess';

const templatesDir = defaultTemplatesDir();
const renderer = createTemplating({ templatesDir, appVersion: '1.2.3' });
const env = renderer.env;

// ---------------------------------------------------------------------------
// preprocessTemplate — unit assertions
// ---------------------------------------------------------------------------

describe('preprocessTemplate: namespace()', () => {
  it('rewrites namespace() to __ns({...}) with Python literals mapped', () => {
    const out = preprocessTemplate('{% set ns = namespace(root_disk=None, gpu=None) %}');
    expect(out).toBe('{% set ns = __ns({root_disk: null, gpu: null}) %}');
    expect(out).not.toContain('namespace(');
  });

  it('rewrites `set NAME.attr = EXPR` to __setattr(...)', () => {
    const out = preprocessTemplate("{% set ns.root_disk = row.percent %}");
    expect(out).toBe('{{ __setattr(ns, "root_disk", row.percent) }}');
    expect(out).not.toMatch(/set\s+ns\.root_disk/);
  });

  it('keeps nested arithmetic in the assigned expression intact', () => {
    const out = preprocessTemplate('{% set proc_ns.total = proc_ns.total + proc.memory_used_mb %}');
    expect(out).toBe('{{ __setattr(proc_ns, "total", proc_ns.total + proc.memory_used_mb) }}');
  });

  it('executes with the real env: a namespace value set in a loop is readable after', () => {
    const src = '{% set ns = namespace(a=None) %}{% for r in rows %}{% set ns.a = r.v %}{% endfor %}{{ ns.a }}';
    expect(env.renderString(preprocessTemplate(src), { rows: [{ v: 7 }] })).toBe('7');
  });
});

describe('preprocessTemplate: Python slice', () => {
  it('rewrites a trailing [:N] to |head(N)', () => {
    expect(preprocessTemplate('{% for z in metrics.thermal_zones[:4] %}{% endfor %}')).toContain(
      'metrics.thermal_zones|head(4)',
    );
  });

  it('does not touch ordinary index access [0]', () => {
    expect(preprocessTemplate('{{ xs[0] }}')).toBe('{{ xs[0] }}');
  });

  it('executes with the real env: [:2] keeps the first two items', () => {
    expect(env.renderString(preprocessTemplate('{{ xs[:2]|join(",") }}'), { xs: [1, 2, 3, 4] })).toBe('1,2');
  });
});

describe('select parity in the real templating env', () => {
  it("select('equalto','ok')|list|length matches Jinja", () => {
    const src = "{{ beats|select('equalto', 'ok')|list|length }}";
    expect(env.renderString(src, { beats: ['ok', 'fail', 'ok', 'ok'] })).toBe('3');
  });
});

describe('preprocessTemplate: floordiv precedence', () => {
  it('rewrites `A * B // C` to floor((A*B)/C)', () => {
    const out = preprocessTemplate('{% set pct = [[(temp - 25) * 100 // 40, 0]|max, 100]|min %}');
    expect(out).toContain(')|floor');
    expect(out).not.toContain('// 40');
  });

  it('leaves a pure `//` untouched', () => {
    expect(preprocessTemplate('{{ (poll_seconds // 60) }}')).toBe('{{ (poll_seconds // 60) }}');
  });

  it('executes with the real env: (61-25)*100//40 == 90 and 70 C clamps to 100%', () => {
    const body = '{% set pct = [[(temp - 25) * 100 // 40, 0]|max, 100]|min %}{{ pct }}';
    const src = preprocessTemplate(body);
    expect(env.renderString(src, { temp: 61 })).toBe('90');
    expect(env.renderString(src, { temp: 70 })).toBe('100');
    expect(env.renderString(src, { temp: 25 })).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// Compile-only: every reused Jinja template must parse under Nunjucks
// ---------------------------------------------------------------------------

describe('template compile: all reused templates', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  const names = fs
    .readdirSync(templatesDir)
    .filter((file: string) => file.endsWith('.html'))
    .sort();

  it('finds all 17 templates', () => {
    expect(names).toHaveLength(17);
  });

  it.each(names)('%s compiles without a syntax error', (name: string) => {
    expect(() => env.getTemplate(name)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Render: host.html — slice + namespace
// ---------------------------------------------------------------------------

const sessionStub = {
  get: (key: string, fallback?: unknown): unknown => {
    if (key === 'logged_in') return true;
    if (key === 'username') return 'admin';
    return fallback === undefined ? '' : fallback;
  },
};

function baseCtx(activePage: string): Record<string, unknown> {
  return {
    active_page: activePage,
    view_mode: 'admin',
    app_version: '1.2.3',
    session: sessionStub,
  };
}

function hostFixture(): Record<string, unknown> {
  const metrics = {
    memory: { used_mb: 4000, total_mb: 8000 },
    disk_usage: [
      { filesystem: '/dev/sda1', mountpoint: '/', size: '100G', used: '37G', available: '63G', percent: 37 },
      { filesystem: '/dev/sdb1', mountpoint: '/data', size: '200G', used: '20G', available: '180G', percent: 20 },
    ],
    gpu_summary: [
      { index: 0, name: 'A100', utilization_percent: 77, memory_used_mb: 1000, memory_total_mb: 4000, temperature_c: 60 },
    ],
    gpu_processes: [
      { index: 0, username: 'alice', pid: 123, memory_used_mb: 500, command: 'python train.py' },
      { index: 0, username: 'bob', pid: 456, memory_used_mb: 300, command: 'python infer.py' },
    ],
    thermal_zones: [
      { label: 'zone0', celsius: 50 },
      { label: 'zone1', celsius: 55 },
      { label: 'zone2', celsius: 60 },
      { label: 'zone3', celsius: 65 },
      { label: 'zone4', celsius: 70 },
    ],
    logged_in_users: [
      { username: 'root', terminal: 'pts/0', remote_host: '1.2.3.4', login_at: '2024-03-05T07:00:00' },
    ],
    containers: [],
    cpu_core_count: 16,
    cpu_usage_percent: 12.5,
    kernel_version: '6.1.0',
    load_average: [0.1, 0.2, 0.3],
    os_pretty_name: 'Ubuntu 22.04',
    uptime: '3 days',
  };
  const detail = {
    name: 'web-01',
    host: '10.0.0.1',
    group: 'prod',
    owner: 'alice',
    collected_at: '2024-03-05T07:08:09',
    success: true,
    errors: [],
    metrics,
    checks: [],
    check_history: {},
    alerts: [],
    alert_days: [],
    network: {},
    uptime_strip: [],
    diagnostics: null,
    diagnostics_summary: null,
    disk: null,
  };
  return { ...baseCtx('hosts'), name: 'web-01', detail };
}

describe('render: host.html', () => {
  const html = renderer.render('host.html', hostFixture());

  it('renders exactly the first 4 thermal zones and a +N summary', () => {
    expect(html).toContain('zone0');
    expect(html).toContain('zone1');
    expect(html).toContain('zone2');
    expect(html).toContain('zone3');
    expect(html).not.toContain('zone4');
    expect(html).toContain('thermal-more">+1<');
  });

  it('resolves namespace() stats: root disk percent and GPU utilization', () => {
    expect(html).toMatch(/根目录磁盘[\s\S]*?37\.0%/);
    expect(html).toContain('GPU 利用率 77.0%');
  });

  it('accumulates the GPU process memory total via namespace mutation', () => {
    expect(html).toContain('合计 800 MB');
  });
});

// ---------------------------------------------------------------------------
// Render: disk_health.html — floordiv temperature bar
// ---------------------------------------------------------------------------

function diskFixture(): Record<string, unknown> {
  const drive = (slot: number, temperature: number, health: string) => ({
    controller: 'c0',
    enclosure: 'e0',
    slot,
    model: 'STX',
    serial: `SN-${slot}`,
    state: 'ok',
    media_errors: 0,
    other_errors: 0,
    predictive_failures: 0,
    smart_alert: false,
    shield_counter: 0,
    temperature_c: temperature,
    health,
  });
  const drives = [drive(1, 61, 'healthy'), drive(2, 70, 'warning')];
  const hosts = [
    {
      name: 'web-01',
      anchor: 'web-01',
      host: '10.0.0.1',
      group: 'prod',
      group_header: null,
      group_size: 0,
      needs_attention: true,
      search_text: 'web-01',
      status: 'warning',
      healthy: 1,
      warning: 1,
      critical: 0,
      controller_count: 1,
      vd_count: 1,
      pd_count: 2,
      temperature_max: 70,
      collected_at: '2024-03-05T07:08:09',
      drives,
    },
  ];
  return {
    ...baseCtx('disk_health'),
    totals: { drives: 2, healthy: 1, warning: 1, critical: 0 },
    drives,
    hosts,
    has_groups: false,
    group_stats: null,
    temperature_stats: null,
  };
}

describe('render: disk_health.html', () => {
  const html = renderer.render('disk_health.html', diskFixture());

  it('draws the temperature bar with floordiv-correct width (61C -> 90%)', () => {
    expect(html).toContain('width: 90%');
  });

  it('clamps an out-of-range temperature to 100% (70C -> 112% -> 100%)', () => {
    expect(html).toContain('width: 100%');
    expect(html).not.toContain('width: 112%');
  });
});
