/**
 * GPU parsers + the `parseHostMetrics` assembly — 1:1 TypeScript port of
 * `servermanage/parsers.py` lines 340-565.
 *
 * The plain-text parsers themselves live in `./parsers-text.ts`; this module
 * adds the nvidia-smi CSV parsers plus the routine that stitches every stage's
 * stdout back into a single `HostMetrics` (the Python `parse_host_metrics`).
 *
 * Conventions (see `./types.ts`):
 * - Python `X | None` -> `X | null`; dicts -> `Map` (insertion order preserved).
 * - Field names are camelCased exactly as the sibling interfaces.
 * - Parsing never throws: malformed input yields `null` / `[]` / empty `Map`.
 *
 * Faithfulness notes / deliberate divergences from the Python oracle:
 * - nvidia-smi output is split with a small RFC-4180 reader that mirrors
 *   Python's `csv.reader(..., skipinitialspace=True)` (so a quoted GPU or
 *   process name containing a comma survives). Non-CSV device errors such as
 *   "No devices were found" / "nvidia-smi: command not found" naturally yield
 *   fewer than the required columns and are skipped to `[]`.
 * - `HostMetrics.collectedAt` is stamped with `nowIsoUtc()` (Python sets
 *   `datetime.now(timezone.utc)` inside `parse_host_metrics`).
 * - The Python `host.name` fallback for `hostname` is not available because the
 *   ported signature only receives raw stage stdout; an absent `hostname`
 *   stage therefore yields `null` (the collector layer owns the host fallback).
 * - Python also merges a legacy `gpu_uuid_map` stage into the uuid lookup; that
 *   stage is not part of the TS `Stage` union, so the uuid map is sourced solely
 *   from the 7th `gpu_summary` column (which the probe already queries).
 */

import type { Stage } from './commands';
import type {
  GPUProcessRow,
  GPUSummaryRow,
  HostMetrics,
  ProcessRow,
  UserProcessCount,
} from './types';
import { emptyHostMetrics } from './types';
import { nowIsoUtc } from '../storage/time';
import {
  parseCpuUsagePercent,
  parseDiskUsage,
  parseDockerContainerNames,
  parseDockerContainers,
  parseMemorySummary,
  parseNetTotals,
  parseOsPrettyName,
  parsePidContainerMap,
  parseProcessCounts,
  parseProcessRows,
  parseThermalZones,
  parseTotalProcesses,
  parseUptime,
  parseUptimeText,
  parseWho,
} from './parsers-text';

// ---------------------------------------------------------------------------
// Internal helpers (mirror the Python module-level constants + `_to_int`,
// `_first_line`, and `str.split(None, n)` semantics)
// ---------------------------------------------------------------------------

const NUMBER_RE = /-?[0-9]+(?:\.[0-9]+)?/;

/** Port of Python `str.splitlines()` (keeps no trailing empty line). */
function splitLines(value: string): string[] {
  if (value === '') {
    return [];
  }
  const parts = value.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/);
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

/** Port of `parsers._first_line`. */
function firstLine(value: string): string | null {
  const text = value.trim();
  if (!text) {
    return null;
  }
  const lines = splitLines(text);
  if (lines.length === 0) {
    return null;
  }
  return lines[0].trim();
}

/** Port of `parsers._to_int` (`int(float(<first number>))`, truncating toward 0). */
function toInt(value: string): number | null {
  const match = NUMBER_RE.exec(value.trim());
  if (match === null) {
    return null;
  }
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/**
 * Port of Python `str.split(None, maxParts - 1)` on already-trimmed text:
 * split on whitespace runs into at most `maxParts` pieces, keeping interior
 * whitespace in the final piece (used for pid/user/command triples).
 */
function splitWhitespaceMax(text: string, maxParts: number): string[] {
  const parts: string[] = [];
  const len = text.length;
  let index = 0;
  const isSpace = (ch: string): boolean => /\s/.test(ch);

  while (parts.length < maxParts - 1) {
    while (index < len && isSpace(text[index])) {
      index += 1;
    }
    if (index >= len) {
      return parts;
    }
    const start = index;
    while (index < len && !isSpace(text[index])) {
      index += 1;
    }
    parts.push(text.slice(start, index));
  }

  while (index < len && isSpace(text[index])) {
    index += 1;
  }
  if (index < len) {
    parts.push(text.slice(index));
  }
  return parts;
}

/**
 * Split one CSV record like Python's `csv.reader(..., skipinitialspace=True)`:
 * comma delimited, double-quoted fields may contain commas / escaped (`""`)
 * quotes, and spaces immediately after a delimiter are dropped.
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  const len = line.length;
  let index = 0;
  let field = '';
  let inQuotes = false;

  while (index < len) {
    const ch = line[index];
    if (inQuotes) {
      if (ch === '"') {
        if (index + 1 < len && line[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += ch;
      index += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (ch === ',') {
      fields.push(field);
      field = '';
      index += 1;
      // `skipinitialspace`: drop spaces immediately following the delimiter.
      while (index < len && line[index] === ' ') {
        index += 1;
      }
      continue;
    }
    field += ch;
    index += 1;
  }
  fields.push(field);
  return fields;
}

/**
 * Port of `_stdout_if_ok_any`: return the first non-empty stdout among the
 * supplied stages (the TS caller has no exit status, so absence == "").
 */
function pick(raw: Partial<Record<Stage, string>>, stages: readonly Stage[]): string {
  for (const stage of stages) {
    const value = raw[stage];
    if (value) {
      return value;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// GPU parsers
// ---------------------------------------------------------------------------

/**
 * Port of `parse_nvidia_smi_summary_with_uuid`: parse the
 * `index,name,utilization.gpu,temperature.gpu,memory.used,memory.total,uuid`
 * CSV into rows plus a `uuid -> index` lookup used to resolve compute-app rows.
 */
export function parseNvidiaSmiSummaryWithUuid(output: string): {
  rows: GPUSummaryRow[];
  uuidToIndex: Map<string, number>;
} {
  const rows: GPUSummaryRow[] = [];
  const uuidToIndex = new Map<string, number>();

  if (!output.trim()) {
    return { rows, uuidToIndex };
  }

  for (const line of splitLines(output)) {
    if (!line.trim()) {
      continue;
    }
    const fields = splitCsvLine(line);
    if (fields.length < 6) {
      continue;
    }
    const index = toInt(fields[0]);
    const utilization = toInt(fields[2]);
    const temperature = toInt(fields[3]);
    const memoryUsed = toInt(fields[4]);
    const memoryTotal = toInt(fields[5]);
    if (index === null || utilization === null || memoryUsed === null || memoryTotal === null) {
      continue;
    }
    rows.push({
      index,
      name: fields[1].trim(),
      utilizationPercent: utilization,
      temperatureC: temperature,
      memoryUsedMb: memoryUsed,
      memoryTotalMb: memoryTotal,
    });
    if (fields.length >= 7 && fields[6].trim()) {
      uuidToIndex.set(fields[6].trim(), index);
    }
  }

  return { rows, uuidToIndex };
}

/**
 * Port of `parse_gpu_summary`: GPU occupancy rows. Empty output, a "not found"
 * message, or any non-CSV device error yields `[]`.
 */
export function parseGpuSummary(stdout: string): GPUSummaryRow[] {
  return parseNvidiaSmiSummaryWithUuid(stdout).rows;
}

/** Optional lookup tables threaded into {@link parseGpuProcesses}. */
export interface GpuProcessLookups {
  uuidToIndex?: Map<string, number>;
  pidToUser?: Map<number, string>;
  pidToCommand?: Map<number, string>;
}

/**
 * Port of `parse_nvidia_smi_processes`: parse the
 * `gpu_ref,pid,used_memory,process_name` CSV into process rows. `gpu_ref` is
 * either a numeric index or a GPU uuid resolved through `uuidToIndex` (unknown
 * uuid -> -1). `command` prefers the `process_name` column, falling back to the
 * `ps`-derived `pidToCommand` map. Rows are sorted by `(index, -memory, pid)`.
 */
export function parseGpuProcesses(
  stdout: string,
  lookups: GpuProcessLookups = {},
): GPUProcessRow[] {
  const uuidToIndex = lookups.uuidToIndex ?? new Map<string, number>();
  const pidToUser = lookups.pidToUser ?? new Map<number, string>();
  const pidToCommand = lookups.pidToCommand ?? new Map<number, string>();

  const rows: GPUProcessRow[] = [];
  for (const line of splitLines(stdout)) {
    if (!line.trim()) {
      continue;
    }
    const fields = splitCsvLine(line);
    if (fields.length < 3) {
      continue;
    }
    const gpuRef = fields[0].trim();
    const pid = toInt(fields[1]);
    const memoryUsed = toInt(fields[2]);
    if (pid === null || memoryUsed === null) {
      continue;
    }
    let index: number;
    if (/^\d+$/.test(gpuRef)) {
      index = Number(gpuRef);
    } else {
      index = uuidToIndex.get(gpuRef) ?? -1;
    }
    const command =
      fields.length >= 4 && fields[3].trim() ? fields[3].trim() : pidToCommand.get(pid) ?? '';
    rows.push({
      index,
      pid,
      username: pidToUser.get(pid) ?? null,
      memoryUsedMb: memoryUsed,
      command,
    });
  }

  rows.sort((a, b) => {
    if (a.index !== b.index) {
      return a.index - b.index;
    }
    if (a.memoryUsedMb !== b.memoryUsedMb) {
      return b.memoryUsedMb - a.memoryUsedMb;
    }
    return a.pid - b.pid;
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Host-metrics assembly helpers (ports of the private helpers in parsers.py)
// ---------------------------------------------------------------------------

/**
 * Port of `parse_pid_user_command_map` (`ps -eo pid=,user=,args=`): return
 * `[pid -> user, pid -> command]`.
 */
export function parsePidUserCommandMap(
  output: string,
): [Map<number, string>, Map<number, string>] {
  const pidToUser = new Map<number, string>();
  const pidToCommand = new Map<number, string>();
  for (const raw of splitLines(output)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const parts = splitWhitespaceMax(line, 3);
    if (parts.length < 2) {
      continue;
    }
    const pid = toInt(parts[0]);
    if (pid === null) {
      continue;
    }
    pidToUser.set(pid, parts[1]);
    if (parts.length >= 3) {
      pidToCommand.set(pid, parts[2]);
    }
  }
  return [pidToUser, pidToCommand];
}

/** Port of `_attach_container_context`. */
function attachContainerContext(
  rows: ProcessRow[],
  pidToContainer: Map<number, string>,
  containerNames: Map<string, string>,
): ProcessRow[] {
  return rows.map((row) => {
    const containerId = pidToContainer.get(row.pid) ?? null;
    return {
      ...row,
      containerId,
      containerName: containerId ? containerNames.get(containerId) ?? null : null,
    };
  });
}

/**
 * Port of `_build_process_counts_by_user`: bucket every pid's user by its
 * container context, then sort by count desc, container-present first, container
 * key asc, username asc.
 */
function buildProcessCountsByUser(
  pidToUser: Map<number, string>,
  pidToContainer: Map<number, string>,
  containerNames: Map<string, string>,
): UserProcessCount[] {
  const buckets = new Map<
    string,
    { username: string; count: number; containerId: string | null; containerName: string | null }
  >();

  for (const [pid, username] of pidToUser) {
    const containerId = pidToContainer.get(pid) ?? null;
    const containerName = containerId ? containerNames.get(containerId) ?? null : null;
    const key = JSON.stringify([containerId, containerName, username]);
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      buckets.set(key, { username, count: 1, containerId, containerName });
    }
  }

  // `Map` preserves first-seen order, matching Python's `Counter` iteration;
  // `Array.prototype.sort` is stable, so ties keep that insertion order.
  const rows: UserProcessCount[] = [];
  for (const bucket of buckets.values()) {
    rows.push({
      username: bucket.username,
      count: bucket.count,
      containerId: bucket.containerId,
      containerName: bucket.containerName,
    });
  }

  rows.sort((a, b) => {
    if (a.count !== b.count) {
      return b.count - a.count;
    }
    const aHasContainer = a.containerName || a.containerId ? 0 : 1;
    const bHasContainer = b.containerName || b.containerId ? 0 : 1;
    if (aHasContainer !== bHasContainer) {
      return aHasContainer - bHasContainer;
    }
    const aKey = a.containerName || a.containerId || '';
    const bKey = b.containerName || b.containerId || '';
    if (aKey !== bKey) {
      return aKey < bKey ? -1 : 1;
    }
    return a.username < b.username ? -1 : a.username > b.username ? 1 : 0;
  });

  return rows;
}

// ---------------------------------------------------------------------------
// parseHostMetrics — the Python `parse_host_metrics` assembly
// ---------------------------------------------------------------------------

/**
 * Port of `parse_host_metrics`: rebuild a `HostMetrics` from per-stage stdout.
 *
 * Every field is populated from the matching stage (see `servermanage/parsers.py`
 * 565-635); stages that are absent or unparseable fall back to the
 * `emptyHostMetrics()` defaults. `collectedAt` is stamped with `nowIsoUtc()`.
 */
export function parseHostMetrics(raw: Partial<Record<Stage, string>>): HostMetrics {
  const uptimeOutput = pick(raw, ['uptime']);

  const { rows: gpuSummary, uuidToIndex } = parseNvidiaSmiSummaryWithUuid(
    pick(raw, ['gpu_summary']),
  );
  const [pidToUser, pidToCommand] = parsePidUserCommandMap(pick(raw, ['pid_user_map']));
  const containerNames = parseDockerContainerNames(pick(raw, ['docker_containers']));
  const pidToContainer = parsePidContainerMap(pick(raw, ['pid_container_map']));

  const topCpuProcesses = attachContainerContext(
    parseProcessRows(pick(raw, ['top_cpu'])),
    pidToContainer,
    containerNames,
  );
  const topMemoryProcesses = attachContainerContext(
    parseProcessRows(pick(raw, ['top_memory'])),
    pidToContainer,
    containerNames,
  );

  const processCountsByUser =
    pidToUser.size > 0
      ? buildProcessCountsByUser(pidToUser, pidToContainer, containerNames)
      : parseProcessCounts(pick(raw, ['process_counts']));

  const gpuProcesses = parseGpuProcesses(pick(raw, ['gpu_processes']), {
    uuidToIndex,
    pidToUser,
    pidToCommand,
  });

  const [netRxBytes, netTxBytes] = parseNetTotals(pick(raw, ['net']));

  return {
    ...emptyHostMetrics(),
    hostname: firstLine(pick(raw, ['hostname'])),
    osPrettyName: parseOsPrettyName(pick(raw, ['os_release'])),
    kernelVersion: firstLine(pick(raw, ['kernel'])),
    uptime: parseUptimeText(uptimeOutput),
    collectedAt: nowIsoUtc(),
    loadAverage: parseUptime(uptimeOutput),
    cpuCoreCount: toInt(pick(raw, ['cpu_cores'])),
    cpuUsagePercent: parseCpuUsagePercent(pick(raw, ['cpu_usage'])),
    memory: parseMemorySummary(pick(raw, ['memory'])),
    diskUsage: parseDiskUsage(pick(raw, ['disk'])),
    loggedInUsers: parseWho(pick(raw, ['who'])),
    totalProcesses: parseTotalProcesses(pick(raw, ['total_processes'])),
    processCountsByUser,
    topCpuProcesses,
    topMemoryProcesses,
    gpuSummary,
    gpuProcesses,
    netRxBytes,
    netTxBytes,
    containers: parseDockerContainers(pick(raw, ['docker_status'])),
    thermalZones: parseThermalZones(pick(raw, ['thermal'])),
  };
}
