import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const load = (name) => import(pathToFileURL(resolve(root, 'servermanage/web/static/lib', name)).href);

test('bus notifies subscribers and stops after unsubscribe', async () => {
  const { createBus } = await load('bus.js');
  const bus = createBus();
  const received = [];
  const off = bus.on('hosts:changed', (value) => received.push(value));
  bus.emit('hosts:changed', { ids: [1] });
  off();
  bus.emit('hosts:changed', { ids: [2] });
  assert.deepEqual(received, [{ ids: [1] }]);
});

test('formatters preserve empty, unit and CSV behavior', async () => {
  const { formatBytesShared, formatPercent, csvEscape } = await load('format.js');
  assert.equal(formatBytesShared(null), '—');
  assert.equal(formatBytesShared(1024), '1.0 KB');
  assert.equal(formatBytesShared(1099511627776), '1.00 TB');
  assert.equal(formatPercent(12.34), '12.3%');
  assert.equal(formatPercent('bad'), '—');
  assert.equal(csvEscape('a,"b"'), '"a,""b"""');
});

test('api writes send CSRF and JSON headers', async () => {
  globalThis.document = {
    querySelector: () => ({ getAttribute: () => 'token-123' }),
  };
  globalThis.window = { location: { pathname: '/', assign: () => {} } };
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true }),
    };
  };
  const { fetchJson } = await load('api.js');
  const result = await fetchJson('/api/example', { method: 'POST', body: '{"x":1}' });
  assert.deepEqual(result, { ok: true });
  assert.equal(request.options.headers['X-CSRF-Token'], 'token-123');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.equal(request.options.credentials, 'same-origin');
});

test('api redirects on 401 and returns null', async () => {
  globalThis.document = { querySelector: () => null };
  let redirected = '';
  globalThis.window = { location: { pathname: '/', assign: (path) => { redirected = path; } } };
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  const { fetchJson } = await load('api.js');
  assert.equal(await fetchJson('/api/private'), null);
  assert.equal(redirected, '/login');
});
