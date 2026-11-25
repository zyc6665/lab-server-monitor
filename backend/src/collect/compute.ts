/**
 * Fleet-level compute summary derived from the collected GPU snapshots.
 *
 * Ported 1:1 from the Python oracle `servermanage/compute.py` (P3 Task 9).
 * Everything here is read-only: it only reshapes data that the regular polling
 * round already stored, so no extra SSH command is issued.
 *
 * Output keys intentionally stay snake_case (the Python dicts are consumed
 * verbatim by the templates / `/api/compute`), unlike the camelCased collection
 * models in `./types`.
 */

import { roundHalfEven } from './types';

/** `servermanage/compute.py:12` — snapshots report MiB. */
export const GB = 1024.0;

/**
 * `servermanage/compute.py:15-24` — vendor-published dense FP16/BF16 figures
 * for one accelerator family.
 */
export interface GpuSpec {
  key: string;
  match: string[];
  label: string;
  tflops: number;
  bandwidthGbs: number;
  tier: string;
}

/**
 * `servermanage/compute.py:29-45` — dense (non-sparse) FP16/BF16 tensor
 * throughput and memory bandwidth as published by the vendor. Numbers are
 * theoretical peaks for reference only; order matters for `specFor`.
 */
export const GPU_SPECS: readonly GpuSpec[] = [
  { key: 'h200', match: ['h200'], label: 'NVIDIA H200', tflops: 989.0, bandwidthGbs: 4800.0, tier: 'training' },
  { key: 'h100', match: ['h100'], label: 'NVIDIA H100', tflops: 756.0, bandwidthGbs: 2039.0, tier: 'training' },
  { key: 'a100', match: ['a100'], label: 'NVIDIA A100', tflops: 312.0, bandwidthGbs: 1935.0, tier: 'training' },
  { key: 'a800', match: ['a800'], label: 'NVIDIA A800', tflops: 312.0, bandwidthGbs: 2000.0, tier: 'training' },
  { key: 'l40s', match: ['l40s'], label: 'NVIDIA L40S', tflops: 362.0, bandwidthGbs: 864.0, tier: 'universal' },
  { key: 'l40', match: ['l40 ', 'l40-'], label: 'NVIDIA L40', tflops: 181.0, bandwidthGbs: 864.0, tier: 'universal' },
  { key: 'rtx6000ada', match: ['rtx 6000 ada', 'rtx6000ada'], label: 'RTX 6000 Ada', tflops: 362.0, bandwidthGbs: 960.0, tier: 'universal' },
  { key: 'a6000', match: ['a6000', 'rtx a6000'], label: 'RTX A6000', tflops: 154.8, bandwidthGbs: 768.0, tier: 'universal' },
  { key: '4090', match: ['4090'], label: 'GeForce RTX 4090', tflops: 165.2, bandwidthGbs: 1008.0, tier: 'universal' },
  { key: '4080', match: ['4080'], label: 'GeForce RTX 4080', tflops: 97.5, bandwidthGbs: 717.0, tier: 'universal' },
  { key: '3090', match: ['3090'], label: 'GeForce RTX 3090', tflops: 71.0, bandwidthGbs: 936.0, tier: 'universal' },
  { key: 'v100', match: ['v100'], label: 'Tesla V100', tflops: 125.0, bandwidthGbs: 900.0, tier: 'universal' },
  { key: 't4', match: ['t4'], label: 'Tesla T4', tflops: 65.0, bandwidthGbs: 320.0, tier: 'legacy' },
  { key: 'p100', match: ['p100'], label: 'Tesla P100', tflops: 18.7, bandwidthGbs: 732.0, tier: 'legacy' },
  { key: 'k80', match: ['k80'], label: 'Tesla K80', tflops: 8.7, bandwidthGbs: 480.0, tier: 'legacy' },
];

/** `servermanage/compute.py:47` — sentinel for unrecognised accelerators. */
export const UNKNOWN_SPEC: GpuSpec = {
  key: 'unknown',
  match: [],
  label: '未知型号',
  tflops: 0.0,
  bandwidthGbs: 0.0,
  tier: 'unknown',
};

/** `servermanage/compute.py:49-54` — human-readable tier names. */
export const TIER_LABELS: Record<string, string> = {
  training: '训练主力',
  universal: '通用加速',
  legacy: '老旧/仅推理',
  unknown: '未识别',
};

/**
 * `servermanage/compute.py:57-65` — return the spec whose pattern appears in
 * `name` (case-insensitive); fall back to {@link UNKNOWN_SPEC}.
 */
export function specFor(name: string | null | undefined): GpuSpec {
  const haystack = (name ?? '').trim().toLowerCase();
  if (!haystack) {
    return UNKNOWN_SPEC;
  }
  for (const spec of GPU_SPECS) {
    if (spec.match.some((pattern) => haystack.includes(pattern))) {
      return spec;
    }
  }
  return UNKNOWN_SPEC;
}

// ---------------------------------------------------------------------------
// Internal shape helpers (mirror the Python helpers)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `servermanage/compute.py:68-74` — `_number`: coerce to a float, returning
 * `null` for booleans / `None` / unparseable values (Python truthiness of a
 * boolean is intentionally excluded, since `bool` is an `int` subclass).
 */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return null;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Python `str(value or "")`: `None`, `False`, `0`, `""` and other falsy
 * scalars become `""`; everything else is stringified.
 */
function pyStrOrEmpty(value: unknown): string {
  if (value === null || value === undefined || value === false || value === 0 || value === '') {
    return '';
  }
  return String(value);
}

/** `servermanage/compute.py:77-79` — `_gpu_rows`: only dict rows survive. */
function gpuRows(metrics: unknown): Record<string, any>[] {
  if (!isPlainObject(metrics)) {
    return [];
  }
  const rows = metrics.gpu_summary;
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.filter(isPlainObject);
}

// ---------------------------------------------------------------------------
// Output shapes (snake_case, matching the Python dicts exactly)
// ---------------------------------------------------------------------------

/** One entry of `hosts[].models` (raw MiB, not converted). */
export interface ComputeHostModelSummary {
  label: string;
  tier: string;
  cards: number;
  vram_mb: number;
  used_mb: number;
}

/** One row of `summary.hosts` / `summary.idle_hosts`. */
export interface ComputeHostSummary {
  name: string;
  address: string;
  group: string;
  cards: number;
  vram_gb: number;
  used_gb: number;
  vram_pct: number;
  util_avg: number;
  tflops: number;
  collected_at: string;
  models: ComputeHostModelSummary[];
  idle: boolean;
}

/** One row of `summary.models` (fleet-wide per-model aggregate). */
export interface ComputeModelSummary {
  key: string;
  label: string;
  tier: string;
  tier_label: string;
  cards: number;
  vram_gb: number;
  used_gb: number;
  tflops: number;
  bandwidth_gbs: number;
  hosts: string[];
  share: number;
}

/** One row of `summary.users`. */
export interface ComputeUserSummary {
  user: string;
  memory_gb: number;
  processes: number;
  cards: number;
  hosts: string[];
  command: string;
  peak_gb: number;
  share: number;
}

/** `summary.totals`. */
export interface ComputeTotals {
  cards: number;
  vram_gb: number;
  used_gb: number;
  tflops: number;
  free_gb: number;
  vram_pct: number;
  pf16: number;
  bandwidth_gbs: number;
}

/** Return shape of {@link buildComputeSummary} (`compute.py:249-260`). */
export interface ComputeSummary {
  totals: ComputeTotals;
  models: ComputeModelSummary[];
  hosts: ComputeHostSummary[];
  users: ComputeUserSummary[];
  idle_hosts: ComputeHostSummary[];
  notes: string[];
}

/** Minimal server descriptor used only for address / group labels. */
export interface ComputeServerLabel {
  name?: string;
  address?: string;
  group?: string;
}

export interface BuildComputeSummaryOptions {
  servers?: ReadonlyArray<ComputeServerLabel>;
}

interface HostModelBucket {
  label: string;
  tier: string;
  cards: number;
  vram_mb: number;
  used_mb: number;
}

interface FleetModelBucket {
  key: string;
  label: string;
  tier: string;
  tier_label: string;
  cards: number;
  vram_mb: number;
  used_mb: number;
  tflops: number;
  bandwidth_gbs: number;
  hosts: string[];
}

interface UserBucket {
  user: string;
  memory_mb: number;
  processes: number;
  cards: Set<string>;
  hosts: string[];
  command: string;
  peak_mb: number;
}

const NOTES = [
  '算力为厂商公布的 FP16/BF16 密集（非稀疏）理论峰值，实际利用率通常 35%–55%。',
  '显存与利用率取自最近一次轮询快照，不是实时读数。',
  'K80/P100/T4 等无 Tensor Core 或老架构卡不建议计入训练算力。',
];

/**
 * `servermanage/compute.py:82-260` — aggregate GPU capacity and current load
 * across the whole fleet.
 *
 * `snapshots` are the dicts returned by `getAllHostSnapshots`; `opts.servers`
 * are used only for address/group labels.
 */
export function buildComputeSummary(
  snapshots: ReadonlyArray<Record<string, any>>,
  opts: BuildComputeSummaryOptions = {},
): ComputeSummary {
  const labels = new Map<string, { address: string; group: string }>();
  for (const server of opts.servers ?? []) {
    if (!server || server.name === undefined) {
      continue;
    }
    labels.set(server.name, {
      address: server.address ?? '',
      group: server.group ? server.group : '未分组',
    });
  }

  const hosts: ComputeHostSummary[] = [];
  const models = new Map<string, FleetModelBucket>();
  const users = new Map<string, UserBucket>();

  for (const snapshot of snapshots) {
    const name = pyStrOrEmpty(snapshot.host_name);
    const metrics = isPlainObject(snapshot.metrics) ? snapshot.metrics : {};
    const gpus = gpuRows(metrics);
    if (gpus.length === 0) {
      continue;
    }

    let cards = 0;
    let vramMb = 0.0;
    let usedMb = 0.0;
    const util: number[] = [];
    let tflops = 0.0;
    const perModel = new Map<string, HostModelBucket>();

    for (const gpu of gpus) {
      const spec = specFor(gpu.name as string | null | undefined);
      const total = toNumber(gpu.memory_total_mb) ?? 0.0;
      const used = toNumber(gpu.memory_used_mb) ?? 0.0;
      const percent = toNumber(gpu.utilization_percent);

      cards += 1;
      vramMb += total;
      usedMb += used;
      tflops += spec.tflops;
      if (percent !== null) {
        util.push(percent);
      }

      let bucket = perModel.get(spec.key);
      if (!bucket) {
        bucket = { label: spec.label, tier: spec.tier, cards: 0, vram_mb: 0.0, used_mb: 0.0 };
        perModel.set(spec.key, bucket);
      }
      bucket.cards += 1;
      bucket.vram_mb += total;
      bucket.used_mb += used;

      let fleetBucket = models.get(spec.key);
      if (!fleetBucket) {
        fleetBucket = {
          key: spec.key,
          label: spec.label,
          tier: spec.tier,
          tier_label: TIER_LABELS[spec.tier] ?? spec.tier,
          cards: 0,
          vram_mb: 0.0,
          used_mb: 0.0,
          tflops: 0.0,
          bandwidth_gbs: 0.0,
          hosts: [],
        };
        models.set(spec.key, fleetBucket);
      }
      fleetBucket.cards += 1;
      fleetBucket.vram_mb += total;
      fleetBucket.used_mb += used;
      fleetBucket.tflops += spec.tflops;
      fleetBucket.bandwidth_gbs += spec.bandwidthGbs;
      if (!fleetBucket.hosts.includes(name)) {
        fleetBucket.hosts.push(name);
      }
    }

    const processes = Array.isArray(metrics.gpu_processes) ? metrics.gpu_processes : [];
    for (const rawProc of processes) {
      if (!isPlainObject(rawProc)) {
        continue;
      }
      const who = pyStrOrEmpty(rawProc.username).trim() || 'unknown';
      const mem = toNumber(rawProc.memory_used_mb) ?? 0.0;
      let bucket = users.get(who);
      if (!bucket) {
        bucket = {
          user: who,
          memory_mb: 0.0,
          processes: 0,
          cards: new Set<string>(),
          hosts: [],
          command: '',
          peak_mb: 0.0,
        };
        users.set(who, bucket);
      }
      bucket.memory_mb += mem;
      bucket.processes += 1;
      bucket.cards.add(`${name}\u0000${String(rawProc.index)}`);
      if (!bucket.hosts.includes(name)) {
        bucket.hosts.push(name);
      }
      if (mem > bucket.peak_mb) {
        bucket.peak_mb = mem;
        bucket.command = pyStrOrEmpty(rawProc.command);
      }
    }

    const utilAvg = util.length > 0 ? roundHalfEven(util.reduce((a, b) => a + b, 0) / util.length, 1) : 0.0;
    const vramPct = vramMb ? roundHalfEven((usedMb / vramMb) * 100, 1) : 0.0;
    const info: { address?: string; group?: string } = labels.get(name) ?? {};

    hosts.push({
      name,
      address: info.address ?? '',
      group: info.group ?? '未分组',
      cards,
      vram_gb: roundHalfEven(vramMb / GB, 1),
      used_gb: roundHalfEven(usedMb / GB, 1),
      vram_pct: vramPct,
      util_avg: utilAvg,
      tflops: roundHalfEven(tflops, 1),
      collected_at: pyStrOrEmpty(snapshot.collected_at),
      models: [...perModel.values()].sort((a, b) => b.cards - a.cards),
      idle: utilAvg <= 5.0 && vramPct < 10.0,
    });
  }

  hosts.sort((a, b) => b.tflops - a.tflops || compareStrings(a.name, b.name));

  const totalsVramGb = roundHalfEven(hosts.reduce((sum, item) => sum + item.vram_gb, 0), 1);
  const totalsUsedGb = roundHalfEven(hosts.reduce((sum, item) => sum + item.used_gb, 0), 1);
  const totalsTflops = roundHalfEven(hosts.reduce((sum, item) => sum + item.tflops, 0), 1);

  const totals: ComputeTotals = {
    cards: hosts.reduce((sum, item) => sum + item.cards, 0),
    vram_gb: totalsVramGb,
    used_gb: totalsUsedGb,
    tflops: totalsTflops,
    free_gb: roundHalfEven(totalsVramGb - totalsUsedGb, 1),
    vram_pct: totalsVramGb ? roundHalfEven((totalsUsedGb / totalsVramGb) * 100, 1) : 0.0,
    pf16: roundHalfEven(totalsTflops / 1000, 2),
    bandwidth_gbs: [...models.values()].reduce((sum, item) => sum + item.bandwidth_gbs, 0),
  };

  const usedTotal = [...users.values()].reduce((sum, item) => sum + item.memory_mb, 0);
  const userRows: ComputeUserSummary[] = [...users.values()].map((item) => ({
    user: item.user,
    memory_gb: roundHalfEven(item.memory_mb / GB, 1),
    processes: item.processes,
    cards: item.cards.size,
    hosts: item.hosts,
    command: item.command,
    peak_gb: roundHalfEven(item.peak_mb / GB, 1),
    share: usedTotal ? roundHalfEven((item.memory_mb / usedTotal) * 100, 1) : 0.0,
  }));
  userRows.sort((a, b) => b.memory_gb - a.memory_gb || compareStrings(a.user, b.user));

  const modelRows: ComputeModelSummary[] = [...models.values()].map((item) => {
    const vramGb = roundHalfEven(item.vram_mb / GB, 1);
    return {
      key: item.key,
      label: item.label,
      tier: item.tier,
      tier_label: item.tier_label,
      cards: item.cards,
      vram_gb: vramGb,
      used_gb: roundHalfEven(item.used_mb / GB, 1),
      tflops: roundHalfEven(item.tflops, 1),
      bandwidth_gbs: item.bandwidth_gbs,
      hosts: item.hosts,
      share: totals.vram_gb ? roundHalfEven((vramGb / totals.vram_gb) * 100, 1) : 0.0,
    };
  });
  modelRows.sort((a, b) => b.tflops - a.tflops || b.cards - a.cards);

  return {
    totals,
    models: modelRows,
    hosts,
    users: userRows,
    idle_hosts: hosts.filter((item) => item.idle),
    notes: [...NOTES],
  };
}

/** Code-point-lexicographic compare, matching Python's `str` ordering for ASCII. */
function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}
