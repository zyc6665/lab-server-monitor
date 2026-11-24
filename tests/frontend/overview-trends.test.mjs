import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const moduleUrl = pathToFileURL(resolve(
  import.meta.dirname,
  '../../servermanage/web/static/pages/overview-trends.js',
)).href;

test('overviewNumbers keeps numeric values and rejects missing samples', async () => {
  const { overviewNumbers } = await import(moduleUrl);
  assert.deepEqual(overviewNumbers([0, '1.5', null, undefined, 'bad', 3]), [0, 1.5, 3]);
});

test('overviewPathIndexed preserves source indices for sparse samples', async () => {
  const { overviewPathIndexed } = await import(moduleUrl);
  const points = overviewPathIndexed([10, null, 30], 0, 30, 108, 64, 4, 4);
  // 稀疏样本保留原始索引（第 0、2 位），y 按 value 在 [min,max] 的线性缩放。
  assert.deepEqual(points, [[4, 41.333333333333336, 0], [104, 4, 2]]);
});

test('overviewTrendText distinguishes load and percentages', async () => {
  const { overviewTrendText } = await import(moduleUrl);
  assert.equal(overviewTrendText(1.234, 'load_1'), '1.23');
  assert.equal(overviewTrendText(56.78, 'cpu'), '56.8%');
  assert.equal(overviewTrendText(null, 'cpu'), '');
});
