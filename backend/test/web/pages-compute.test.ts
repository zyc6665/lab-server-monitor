/**
 * P0 Task 2 — the compute *fallback* builder must agree with the real one.
 *
 * `defaultBuildComputeSummary` used to re-implement the aggregation inline and
 * left the GPU spec table un-ported (`tflops` / `pf16` / `bandwidth_gbs` always
 * 0, plus a "尚未迁移" note). It now delegates to `collect/compute.ts`, so the
 * same snapshot yields real A100 figures here.
 */
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/config';
import { openDatabase } from '../../src/storage/db';
import { saveHostSnapshot } from '../../src/storage/hosts';
import { initSchema } from '../../src/storage/schema';
import { defaultBuildComputeSummary } from '../../src/web/routes/pages';

/** Minimal GPU-bearing {@link AppConfig} — one host, key auth (no secrets needed). */
function makeConfig() {
  return loadConfig(
    {},
    {
      servers: [
        {
          name: 'gpu-01',
          host: '10.0.0.1',
          username: 'root',
          auth: { type: 'key', key_data: 'test-key' },
        },
      ],
    },
  );
}

/** Seeds one A100 snapshot exactly like the collector persists it. */
function seedA100(): ReturnType<typeof openDatabase> {
  const db = openDatabase(':memory:');
  initSchema(db);
  saveHostSnapshot(db, {
    host_name: 'gpu-01',
    host: '10.0.0.1',
    success: true,
    metrics: {
      collected_at: '2026-11-26T00:00:00.000000+00:00',
      gpu_summary: [
        {
          index: 0,
          name: 'NVIDIA A100-SXM4-80GB',
          memory_total_mb: 81920,
          memory_used_mb: 4096,
          utilization_percent: 10,
          temperature_c: 40,
        },
      ],
      gpu_processes: [],
    },
  });
  return db;
}

describe('defaultBuildComputeSummary', () => {
  it('reports real tflops for known GPUs', () => {
    const db = seedA100();
    const config = makeConfig();

    const summary = defaultBuildComputeSummary(db, config) as {
      totals: { tflops: number };
      models: Array<{ tier: string }>;
      hosts: Array<{ tflops: number; address: string }>;
      notes: unknown;
    };

    // A100 = 312 TFLOPS FP16 dense (collect/compute.ts spec table).
    expect(summary.totals.tflops).toBeCloseTo(312, 5);
    expect(summary.hosts[0].tflops).toBeCloseTo(312, 5);
    expect(summary.models[0].tier).toBe('training');
    // Server labels come from the config mapping used by the composition root.
    expect(summary.hosts[0].address).toBe('10.0.0.1');
    expect(JSON.stringify(summary.notes)).not.toContain('尚未迁移');
    db.close();
  });
});