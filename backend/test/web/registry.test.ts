/**
 * Unit tests for the `url_for` endpoint registry.
 *
 * Mirrors the oracle's Flask endpoint names (kept as `url_for` mapping keys in
 * the design §6.2) so the reused Jinja templates resolve their links unchanged.
 * Path parameters use `{name}` placeholders internally and are percent-encoded;
 * any leftover params become an ordered query string (None values dropped, as
 * Flask does).
 */
import { describe, expect, it } from 'vitest';

import { ENDPOINTS, assetUrl, hasEndpoint, urlFor } from '../../src/web/routes/registry';

describe('registry: static page endpoints', () => {
  it('maps parameterless page endpoints', () => {
    expect(urlFor('overview_page')).toBe('/');
    expect(urlFor('hosts_page')).toBe('/hosts');
    expect(urlFor('settings_page')).toBe('/settings');
    expect(urlFor('disk_health_page')).toBe('/disk-health');
    expect(urlFor('compute_page')).toBe('/compute');
    expect(urlFor('my_page')).toBe('/my');
    expect(urlFor('users_page')).toBe('/users');
    expect(urlFor('alerts_page')).toBe('/alerts');
    expect(urlFor('terminal_page')).toBe('/terminal');
    expect(urlFor('setup')).toBe('/setup');
    expect(urlFor('login')).toBe('/login');
    expect(urlFor('login_submit')).toBe('/login');
    expect(urlFor('logout')).toBe('/logout');
  });

  it('exposes the password-change endpoint under /api/settings/password', () => {
    expect(ENDPOINTS.api_change_password).toBe('/api/settings/password');
    expect(urlFor('api_change_password')).toBe('/api/settings/password');
  });
});

describe('registry: path parameters', () => {
  it('substitutes and percent-encodes single path params', () => {
    expect(urlFor('host_page', { name: 'web-01' })).toBe('/host/web-01');
    expect(urlFor('host_page', { name: 'web 01' })).toBe('/host/web%2001');
    expect(urlFor('api_host_report', { name: 'db/primary' })).toBe('/api/host/db%2Fprimary/report');
  });

  it('substitutes integer path params', () => {
    expect(urlFor('api_ack_alert', { alert_id: 42 })).toBe('/api/alerts/42/ack');
    expect(urlFor('api_delete_silence', { silence_id: 7 })).toBe('/api/settings/silences/7');
  });

  it('substitutes trailing settings sections', () => {
    expect(urlFor('api_put_settings_section', { section: 'monitoring' })).toBe('/api/settings/monitoring');
  });

  it('throws when a required path param is missing', () => {
    expect(() => urlFor('host_page')).toThrow(/missing value for "name"/);
    expect(() => urlFor('api_ack_alert', { alert_id: null })).toThrow(/missing value for "alert_id"/);
  });
});

describe('registry: query parameters', () => {
  it('appends leftover params in insertion order', () => {
    expect(urlFor('alerts_page', { host: 'db1', status: 'all' })).toBe('/alerts?host=db1&status=all');
    expect(urlFor('disk_health_page', { tab: 'x', q: 'a b' })).toBe('/disk-health?tab=x&q=a%20b');
  });

  it('drops undefined and null query params', () => {
    expect(urlFor('alerts_page', { host: 'a', status: null, page: undefined })).toBe('/alerts?host=a');
  });

  it('renders booleans the Python way', () => {
    expect(urlFor('alerts_page', { all: true, silenced: false })).toBe('/alerts?all=True&silenced=False');
  });
});

describe('registry: static assets', () => {
  it('builds /static paths, keeping directory separators', () => {
    expect(urlFor('static', { filename: 'style.css' })).toBe('/static/style.css');
    expect(urlFor('static', { filename: 'js/app.js' })).toBe('/static/js/app.js');
  });

  it('appends the ?v= cache-buster when provided', () => {
    expect(urlFor('static', { filename: 'style.css', v: '1.2.3' })).toBe('/static/style.css?v=1.2.3');
  });

  it('assetUrl() mirrors the asset_url template global', () => {
    expect(assetUrl('style.css', '9.9.9')).toBe('/static/style.css?v=9.9.9');
    expect(assetUrl('img/logo.svg')).toBe('/static/img/logo.svg');
  });
});

describe('registry: lookups', () => {
  it('reports known endpoints', () => {
    expect(hasEndpoint('overview_page')).toBe(true);
    expect(hasEndpoint('definitely_not_an_endpoint')).toBe(false);
  });

  it('throws for unknown endpoints', () => {
    expect(() => urlFor('definitely_not_an_endpoint')).toThrow(/unknown endpoint/);
  });

  it('covers every endpoint used by the reused templates', () => {
    const used = [
      'settings_page',
      'host_page',
      'overview_page',
      'hosts_page',
      'disk_health_page',
      'api_overview_report',
      'alerts_page',
      'users_page',
      'setup',
      'my_page',
      'logout',
      'login_submit',
      'compute_page',
      'api_host_report',
    ];
    for (const name of used) {
      expect(hasEndpoint(name), name).toBe(true);
    }
  });
});
