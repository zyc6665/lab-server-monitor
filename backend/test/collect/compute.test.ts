import { describe, it, expect } from 'vitest';

import {
  GB,
  GPU_SPECS,
  UNKNOWN_SPEC,
  TIER_LABELS,
  specFor,
  buildComputeSummary,
  type GpuSpec,
} from '../../src/collect/compute';

// ---------------------------------------------------------------------------
// Fixtures — mirror the snapshot dicts returned by getAllHostSnapshots()
// (metrics are raw JSON, so GPU rows keep snake_case keys).
// ---------------------------------------------------------------------------

type GpuRow = [model: string, totalMb: number | string | boolean | null, usedMb: number | string | boolean | null, util: number | string | boolean | null];

function snapshot(
  name: string,
  gpus: GpuRow[],
  processes?: Array<Record<string, unknown> | null | string | number>,
  collectedAt = '2026-11-12T04:49:00+00:00',
): Record<string, any> {
  const metrics: Record<string, any> = {
    gpu_summary: gpus.map(([model, total, used, util], index) => ({
      index,
      name: model,
      memory_total_mb: total,
      memory_used_mb: used,
      utilization_percent: util,
    })),
  };
  if (processes !== undefined) {
    metrics.gpu_processes = processes;
  }
  return { host_name: name, collected_at: collectedAt, success: true, metrics };
}

// ---------------------------------------------------------------------------
// Constant tables
// ---------------------------------------------------------------------------

describe('compute constants', () => {
  it('GB is 1024 (snapshots report MiB)', () => {
    expect(GB).toBe(1024.0);
  });

  it('GPU_SPECS holds exactly the 15 vendor entries with verbatim numbers', () => {
    expect(GPU_SPECS).toHaveLength(15);
    const table: Record<string, [tflops: number, bandwidth: number, tier: string]> = {
      h200: [989.0, 4800.0, 'training'],
      h100: [756.0, 2039.0, 'training'],
      a100: [312.0, 1935.0, 'training'],
      a800: [312.0, 2000.0, 'training'],
      l40s: [362.0, 864.0, 'universal'],
      l40: [181.0, 864.0, 'universal'],
      rtx6000ada: [362.0, 960.0, 'universal'],
      a6000: [154.8, 768.0, 'universal'],
      '4090': [165.2, 1008.0, 'universal'],
      '4080': [97.5, 717.0, 'universal'],
      '3090': [71.0, 936.0, 'universal'],
      v100: [125.0, 900.0, 'universal'],
      t4: [65.0, 320.0, 'legacy'],
      p100: [18.7, 732.0, 'legacy'],
      k80: [8.7, 480.0, 'legacy'],
    };
    expect(Object.keys(table)).toHaveLength(15);
    for (const spec of GPU_SPECS) {
      expect(table[spec.key], `unexpected key ${spec.key}`).toBeDefined();
      expect([spec.tflops, spec.bandwidthGbs, spec.tier]).toEqual(table[spec.key]);
      expect(Array.isArray(spec.match)).toBe(true);
      expect(typeof spec.label).toBe('string');
    }
    // Ordered as in the Python oracle. (Not Object.keys(table): JS hoists
    // integer-like keys such as "4090" ahead of string keys.)
    expect(GPU_SPECS.map((s) => s.key)).toEqual([
      'h200',
      'h100',
      'a100',
      'a800',
      'l40s',
      'l40',
      'rtx6000ada',
      'a6000',
      '4090',
      '4080',
      '3090',
      'v100',
      't4',
      'p100',
      'k80',
    ]);
  });

  it('L40 patterns split on "l40 " and "l40-"', () => {
    const l40 = GPU_SPECS.find((s) => s.key === 'l40') as GpuSpec;
    expect(l40.match).toEqual(['l40 ', 'l40-']);
  });

  it('UNKNOWN_SPEC and TIER_LABELS match Python', () => {
    expect(UNKNOWN_SPEC).toEqual({
      key: 'unknown',
      match: [],
      label: '未知型号',
      tflops: 0.0,
      bandwidthGbs: 0.0,
      tier: 'unknown',
    });
    expect(TIER_LABELS).toEqual({
      training: '训练主力',
      universal: '通用加速',
      legacy: '老旧/仅推理',
      unknown: '未识别',
    });
  });
});

// ---------------------------------------------------------------------------
// specFor — case-insensitive substring matching
// ---------------------------------------------------------------------------

describe('specFor', () => {
  it('matches known accelerators case-insensitively', () => {
    expect(specFor('NVIDIA A100 80GB PCIe').key).toBe('a100');
    expect(specFor('NVIDIA H100 PCIe').key).toBe('h100');
    expect(specFor('NVIDIA GeForce RTX 4090').key).toBe('4090');
    expect(specFor('Tesla V100-PCIE-32GB').key).toBe('v100');
    expect(specFor('Tesla K80').key).toBe('k80');
    expect(specFor('nvidia h100').key).toBe('h100');
  });

  it('covers the L40 / L40S / Ada / A6000 edge patterns', () => {
    expect(specFor('NVIDIA L40 PCIe').key).toBe('l40');
    expect(specFor('NVIDIA L40-PCIE').key).toBe('l40');
    expect(specFor('NVIDIA L40S').key).toBe('l40s');
    expect(specFor('RTX A6000').key).toBe('a6000');
    expect(specFor('RTX 6000 Ada Generation').key).toBe('rtx6000ada');
  });

  it('falls back to UNKNOWN_SPEC for unknown / empty / null names', () => {
    expect(specFor('Mystery Accelerator').key).toBe('unknown');
    expect(specFor('').key).toBe('unknown');
    expect(specFor(null).key).toBe('unknown');
    expect(specFor(undefined).key).toBe('unknown');
    expect(specFor(null).tflops).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// buildComputeSummary — aggregate behaviour
// ---------------------------------------------------------------------------

describe('buildComputeSummary', () => {
  it('returns the documented empty structure for no snapshots', () => {
    const summary = buildComputeSummary([]);
    expect(Object.keys(summary).sort()).toEqual(
      ['hosts', 'idle_hosts', 'models', 'notes', 'totals', 'users'].sort(),
    );
    expect(summary.totals).toEqual({
      cards: 0,
      vram_gb: 0,
      used_gb: 0,
      tflops: 0,
      free_gb: 0,
      vram_pct: 0.0,
      pf16: 0.0,
      bandwidth_gbs: 0,
    });
    expect(summary.models).toEqual([]);
    expect(summary.hosts).toEqual([]);
    expect(summary.users).toEqual([]);
    expect(summary.idle_hosts).toEqual([]);
    expect(summary.notes).toHaveLength(3);
    expect(summary.notes[0]).toContain('理论峰值');
  });

  it('skips hosts with no GPU rows', () => {
    const summary = buildComputeSummary([
      { host_name: 'bare', collected_at: 'x', metrics: {} },
      { host_name: 'empty', collected_at: 'x', metrics: { gpu_summary: [] } },
    ]);
    expect(summary.hosts).toEqual([]);
    expect(summary.totals.cards).toBe(0);
  });

  it('aggregates capacity, per-model buckets and idle hosts', () => {
    const summary = buildComputeSummary([
      snapshot('a100-zyc', [
        ['NVIDIA A100 80GB PCIe', 81920, 77981, 100.0],
        ['NVIDIA A100 80GB PCIe', 81920, 77959, 8.0],
      ]),
      snapshot('v100-zyc', [
        ['Tesla V100-PCIE-32GB', 32768, 0, 0.0],
        ['Tesla V100-PCIE-32GB', 32768, 0, 0.0],
      ]),
    ]);

    expect(summary.totals).toEqual({
      cards: 4,
      vram_gb: 224.0,
      used_gb: 152.3,
      tflops: 874.0,
      free_gb: 71.7,
      vram_pct: 68.0,
      pf16: 0.87,
      bandwidth_gbs: 5670.0,
    });
    expect(summary.models.map((m) => m.key)).toEqual(['a100', 'v100']);
    expect(summary.models[0]).toMatchObject({
      key: 'a100',
      label: 'NVIDIA A100',
      tier: 'training',
      tier_label: '训练主力',
      cards: 2,
      vram_gb: 160.0,
      used_gb: 152.3,
      tflops: 624.0,
      bandwidth_gbs: 3870.0,
      hosts: ['a100-zyc'],
      share: 71.4,
    });

    const byName = new Map(summary.hosts.map((h) => [h.name, h]));
    expect(byName.get('a100-zyc')).toMatchObject({
      address: '',
      group: '未分组',
      cards: 2,
      vram_gb: 160.0,
      used_gb: 152.3,
      vram_pct: 95.2,
      util_avg: 54.0,
      tflops: 624.0,
      idle: false,
      models: [
        { label: 'NVIDIA A100', tier: 'training', cards: 2, vram_mb: 163840.0, used_mb: 155940.0 },
      ],
    });
    expect(byName.get('v100-zyc')?.idle).toBe(true);
    expect(summary.idle_hosts.map((h) => h.name)).toEqual(['v100-zyc']);
  });

  it('mixes models of different tiers and applies server labels', () => {
    const summary = buildComputeSummary(
      [
        snapshot('h100-node', [
          ['NVIDIA H100 PCIe', 81559, 40000, 95.0],
          ['NVIDIA H100 PCIe', 81559, 0, 0.0],
        ]),
        snapshot('a100-node', [['NVIDIA A100 80GB PCIe', 81920, 50000, 40.0]]),
        snapshot('mystery-node', [['Mystery Accelerator X', 24576, 1024, 12.5]]),
      ],
      {
        servers: [
          { name: 'h100-node', address: '10.0.0.1', group: 'GPU 节点' },
          { name: 'a100-node', address: '10.0.0.2' },
          { name: 'mystery-node', address: '10.0.0.3', group: '' },
        ],
      },
    );

    // Sorted by descending tflops then name.
    expect(summary.hosts.map((h) => h.name)).toEqual(['h100-node', 'a100-node', 'mystery-node']);
    expect(summary.hosts[0]).toMatchObject({ address: '10.0.0.1', group: 'GPU 节点' });
    expect(summary.hosts[1]).toMatchObject({ address: '10.0.0.2', group: '未分组' });
    expect(summary.hosts[2]).toMatchObject({ address: '10.0.0.3', group: '未分组' });

    expect(summary.models.map((m) => [m.key, m.tier, m.tier_label])).toEqual([
      ['h100', 'training', '训练主力'],
      ['a100', 'training', '训练主力'],
      ['unknown', 'unknown', '未识别'],
    ]);
    // Unknown GPUs are counted but contribute no compute / bandwidth.
    expect(summary.models[2]).toMatchObject({
      key: 'unknown',
      label: '未知型号',
      cards: 1,
      vram_gb: 24.0,
      used_gb: 1.0,
      tflops: 0.0,
      bandwidth_gbs: 0.0,
      share: 9.1,
    });
    expect(summary.totals).toMatchObject({
      cards: 4,
      vram_gb: 263.3,
      used_gb: 88.9,
      tflops: 1824.0,
      free_gb: 174.4,
      vram_pct: 33.8,
      pf16: 1.82,
      bandwidth_gbs: 6013.0,
    });
  });

  it('aggregates per-user GPU memory across hosts', () => {
    const summary = buildComputeSummary([
      snapshot(
        'a100-zyc',
        [['NVIDIA A100', 81920, 40000, 50.0]],
        [
          { index: 0, pid: 1, username: 'alice', memory_used_mb: 30000, command: 'python train.py' },
          { index: 1, pid: 2, username: 'alice', memory_used_mb: 20000, command: 'python eval.py' },
          { index: 1, pid: 3, username: 'bob', memory_used_mb: 10000, command: 'python small.py' },
        ],
      ),
      snapshot(
        'h100-zyc',
        [['NVIDIA A100', 81920, 40000, 50.0]],
        [{ index: 0, pid: 9, username: 'alice', memory_used_mb: 40000, command: 'python big.py' }],
      ),
    ]);

    expect(summary.users.map((u) => u.user)).toEqual(['alice', 'bob']);
    expect(summary.users[0]).toEqual({
      user: 'alice',
      processes: 3,
      cards: 3, // (a100-zyc,0), (a100-zyc,1), (h100-zyc,0)
      hosts: ['a100-zyc', 'h100-zyc'],
      command: 'python big.py', // process holding the most memory
      memory_gb: 87.9,
      peak_gb: 39.1,
      share: 90.0,
    });
    expect(summary.users[1]).toMatchObject({ user: 'bob', memory_gb: 9.8, cards: 1, share: 10.0 });
  });

  it('tolerates non-dict / null rows and boolean or string numeric fields', () => {
    const summary = buildComputeSummary([
      {
        host_name: 'weird',
        collected_at: '2026-01-01T00:00:00+00:00',
        metrics: {
          gpu_summary: [
            null,
            'bad',
            42,
            { index: 0, name: 'NVIDIA A100', memory_total_mb: '81920', memory_used_mb: null, utilization_percent: '50' },
            { index: 2, name: 'NVIDIA A100', memory_total_mb: true, memory_used_mb: false, utilization_percent: true },
          ],
          gpu_processes: [
            null,
            'x',
            7,
            { index: 0, username: null, memory_used_mb: 1000, command: null },
            { index: 1, username: '   ', memory_used_mb: '2000', command: 'run' },
          ],
        },
      },
    ]);

    // Two valid GPU dicts; booleans are excluded as numbers (Python semantics).
    expect(summary.hosts).toHaveLength(1);
    expect(summary.hosts[0]).toMatchObject({
      cards: 2,
      vram_gb: 80.0,
      used_gb: 0.0,
      util_avg: 50.0,
    });
    expect(summary.hosts[0].models).toEqual([
      { label: 'NVIDIA A100', tier: 'training', cards: 2, vram_mb: 81920.0, used_mb: 0.0 },
    ]);
    // null / whitespace usernames collapse to "unknown"; peak command wins.
    expect(summary.users).toEqual([
      {
        user: 'unknown',
        processes: 2,
        cards: 2,
        hosts: ['weird'],
        command: 'run',
        memory_gb: 2.9,
        peak_gb: 2.0,
        share: 100.0,
      },
    ]);
  });
});
