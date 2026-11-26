#!/usr/bin/env node
/**
 * Endpoint latency benchmark (P3-3).
 *
 * Boots the compiled backend on a throwaway data dir, authenticates against
 * `--setup`-less flow by importing a seeded DB is out of scope here, so the
 * script measures the unauthenticated health/endpoint surface plus optional
 * cookie-based endpoints when `--cookie` is provided.
 *
 * Usage:
 *   node dist/main.cjs --data-dir <dir> --port 0 --runtime <file>   # in another shell
 *   node scripts/bench.mjs --base http://127.0.0.1:<port> [--cookie 'k=v'] [--n 30]
 */
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const base = arg('base');
if (!base) {
  console.error('usage: node scripts/bench.mjs --base http://127.0.0.1:PORT [--cookie k=v] [--n 30]');
  process.exit(2);
}
const cookie = arg('cookie', '');
const n = Math.max(1, Number.parseInt(arg('n', '30'), 10) || 30);

const paths = [
  '/api/system/health',
  '/api/overview',
  '/api/overview/history?range=7d',
  '/api/alerts?status=active&range=7d',
  '/api/settings',
  '/api/system/tasks',
];

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

const results = [];
for (const path of paths) {
  const times = [];
  let status = 0;
  for (let i = 0; i < n; i += 1) {
    const started = performance.now();
    try {
      const res = await fetch(base + path, { headers: cookie ? { cookie } : {} });
      status = res.status;
      await res.arrayBuffer();
    } catch (err) {
      status = -1;
    }
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  results.push({
    path,
    status,
    p50: percentile(times, 50).toFixed(1),
    p95: percentile(times, 95).toFixed(1),
    max: times[times.length - 1].toFixed(1),
  });
}

console.table(results);
const slow = results.filter((r) => Number(r.p95) > 300);
if (slow.length > 0) {
  console.error(`\nbench: ${slow.length} endpoint(s) with p95 > 300ms`);
  process.exit(1);
}
console.log('\nbench: ok (all p95 <= 300ms)');
