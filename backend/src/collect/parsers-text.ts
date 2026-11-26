/**
 * Non-GPU text parsers — 1:1 TypeScript port of the corresponding functions in
 * the Python oracle `servermanage/parsers.py` (lines 55-565).
 *
 * Conventions (see `./types.ts`):
 * - Python `X | None` -> `X | null`; dicts -> `Map` (preserves insertion order
 *   and avoids JS numeric-key coercion for the pid -> container id map).
 * - Field names are camelCased exactly as the sibling `types.ts` interfaces.
 * - Parsing never throws: malformed input yields `null` / `[]` / empty `Map`.
 * - Rounding uses `roundHalfEven` so results match Python's `round()`.
 *
 * Faithfulness notes:
 * - `parseDiskUsage` mirrors `parsers.parse_disk_usage` and therefore keeps
 *   `tmpfs` / `overlay` rows. Those filesystems are filtered elsewhere
 *   (`servermanage/report.py`, `servermanage/disk_capacity.py`), not here.
 * - `parseMemorySummary` reads six numeric columns positionally, so both the
 *   modern (`buff/cache`) and legacy (`buffers`/`cached`) free(1) headers parse.
 */

import type {
  ContainerInfo,
  DiskUsageRow,
  LoadAverage,
  LoggedInUser,
  MemorySummary,
  ProcessRow,
  ThermalZone,
  UserProcessCount,
} from './types';
import { roundHalfEven } from './types';

// ---------------------------------------------------------------------------
// Internal regexes and helpers (mirror the Python module-level constants)
// ---------------------------------------------------------------------------

const LOAD_RE =
  /load average:\s*([0-9]*\.?[0-9]+),?\s*([0-9]*\.?[0-9]+),?\s*([0-9]*\.?[0-9]+)/;
const UPTIME_RE = /\bup\s+(.+?),\s+\d+\s+user/;
const NUMBER_RE = /-?[0-9]+(?:\.[0-9]+)?/;
const CPU_IDLE_RE = /([0-9]*\.?[0-9]+)\s*id/;
const CONTAINER_CGROUP_RE = /\/docker\/([0-9a-f]{12,64})|docker-([0-9a-f]{12,64})\.scope/;

/** `str.splitlines()` for the line terminators seen in remote command output. */
function splitLines(value: string): string[] {
  return value.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/);
}

/** Port of `parsers._first_line`. */
function firstLine(value: string): string | null {
  const text = value.trim();
  if (!text) {
    return null;
  }
  return splitLines(text)[0].trim();
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

/** Port of `parsers._to_float`. */
function toFloat(value: string): number | null {
  const match = NUMBER_RE.exec(value.trim());
  if (match === null) {
    return null;
  }
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Port of Python `str.split(None, maxParts - 1)` on already-trimmed text:
 * split on runs of whitespace into at most `maxParts` pieces, where the final
 * piece keeps any interior whitespace (used for command / mountpoint tails).
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

/** Split once on the first literal tab (`str.split("\t", 1)`). */
function splitOnFirstTab(line: string): [string, string] | null {
  const index = line.indexOf('\t');
  if (index < 0) {
    return null;
  }
  return [line.slice(0, index), line.slice(index + 1)];
}

/** Python `s.strip("()")`: drop any leading/trailing paren characters. */
function stripParens(value: string): string {
  return value.replace(/^[()]+/, '').replace(/[()]+$/, '');
}

/** Python `s.strip('"')`. */
function stripDoubleQuotes(value: string): string {
  return value.replace(/^"+/, '').replace(/"+$/, '');
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** Port of `parse_uptime`. */
export function parseUptime(output: string): LoadAverage | null {
  const match = LOAD_RE.exec(output);
  if (match === null) {
    return null;
  }
  return {
    load1: Number(match[1]),
    load5: Number(match[2]),
    load15: Number(match[3]),
  };
}

/** Port of `parse_uptime_text`. */
export function parseUptimeText(output: string): string | null {
  if (!output.trim()) {
    return null;
  }
  const match = UPTIME_RE.exec(output);
  if (match !== null) {
    return match[1].trim();
  }
  return output.trim();
}

/** Port of `parse_os_pretty_name`. */
export function parseOsPrettyName(output: string): string | null {
  const line = firstLine(output);
  if (line === null) {
    return null;
  }
  if (line.startsWith('PRETTY_NAME=')) {
    const value = line.slice(line.indexOf('=') + 1).trim();
    return stripDoubleQuotes(value);
  }
  return line;
}

/** Port of `parse_memory_summary`. */
export function parseMemorySummary(output: string): MemorySummary | null {
  let memValues: number[] | null = null;
  let swapValues: number[] | null = null;

  for (const raw of splitLines(output)) {
    const text = raw.trim();
    if (text.startsWith('Mem:')) {
      const parts = text.split(/\s+/);
      if (parts.length >= 7) {
        const ints = parts.slice(1, 7).map(toInt);
        if (ints.every((value): value is number => value !== null)) {
          memValues = ints;
        }
      }
    } else if (text.startsWith('Swap:')) {
      const parts = text.split(/\s+/);
      if (parts.length >= 4) {
        const ints = parts.slice(1, 4).map(toInt);
        if (ints.every((value): value is number => value !== null)) {
          swapValues = ints;
        }
      }
    }
  }

  if (memValues === null) {
    return null;
  }
  const swap = swapValues ?? [0, 0, 0];
  return {
    totalMb: memValues[0],
    usedMb: memValues[1],
    freeMb: memValues[2],
    sharedMb: memValues[3],
    buffCacheMb: memValues[4],
    availableMb: memValues[5],
    swapTotalMb: swap[0],
    swapUsedMb: swap[1],
    swapFreeMb: swap[2],
  };
}

/** Port of `parse_memory` (alias of `parseMemorySummary`). */
export function parseMemory(output: string): MemorySummary | null {
  return parseMemorySummary(output);
}

/** Port of `parse_disk_usage`. */
export function parseDiskUsage(output: string): DiskUsageRow[] {
  const rows: DiskUsageRow[] = [];
  for (const raw of splitLines(output)) {
    const line = raw.trim();
    if (!line || line.toLowerCase().startsWith('filesystem')) {
      continue;
    }
    const parts = splitWhitespaceMax(line, 6);
    if (parts.length < 6) {
      continue;
    }
    if (toInt(parts[4]) === null) {
      continue;
    }
    rows.push({
      filesystem: parts[0],
      size: parts[1],
      used: parts[2],
      available: parts[3],
      percent: parts[4],
      mountpoint: parts[5],
    });
  }
  return rows;
}

/** Port of `parse_who`. */
export function parseWho(output: string): LoggedInUser[] {
  const users: LoggedInUser[] = [];
  for (const raw of splitLines(output)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 4) {
      continue;
    }
    let remoteHost: string | null = null;
    let loginParts = parts.slice(2);
    const last = parts[parts.length - 1];
    if (last.startsWith('(') && last.endsWith(')')) {
      remoteHost = stripParens(last) || null;
      loginParts = parts.slice(2, -1);
    }
    users.push({
      username: parts[0],
      terminal: parts[1],
      loginAt: loginParts.join(' ').trim(),
      remoteHost,
    });
  }
  return users;
}

/** Port of `parse_process_counts`. */
export function parseProcessCounts(output: string): UserProcessCount[] {
  const counts: UserProcessCount[] = [];
  for (const raw of splitLines(output)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const parts = splitWhitespaceMax(line, 2);
    if (parts.length !== 2) {
      continue;
    }
    const count = toInt(parts[0]);
    if (count === null) {
      continue;
    }
    const username = parts[1].trim();
    if (!username) {
      continue;
    }
    counts.push({ username, count, containerId: null, containerName: null });
  }
  return counts;
}

/** Port of `parse_process_rows`. */
export function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const raw of splitLines(output)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const parts = splitWhitespaceMax(line, 6);
    if (parts.length < 6) {
      continue;
    }
    const pid = toInt(parts[1]);
    const cpuPercent = toFloat(parts[2]);
    const memPercent = toFloat(parts[3]);
    if (pid === null || cpuPercent === null || memPercent === null) {
      continue;
    }
    rows.push({
      username: parts[0],
      pid,
      cpuPercent,
      memPercent,
      elapsed: parts[4],
      command: parts[5],
      containerId: null,
      containerName: null,
    });
  }
  return rows;
}

/** Port of `parse_thermal_zones` (`type<TAB>millidegrees`, capped at 20). */
export function parseThermalZones(output: string | null | undefined): ThermalZone[] {
  if (!output) {
    return [];
  }
  const zones: ThermalZone[] = [];
  const seen = new Set<string>();
  for (const raw of splitLines(output)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const parts = splitOnFirstTab(line);
    if (parts === null) {
      continue;
    }
    const label = parts[0].trim() || 'thermal';
    const value = toInt(parts[1].trim());
    if (value === null) {
      continue;
    }
    const celsius = roundHalfEven(value / 1000.0, 1);
    if (celsius <= 0 || celsius >= 150) {
      continue;
    }
    const key = label.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    zones.push({ label, celsius });
  }
  zones.sort((a, b) => {
    if (a.celsius !== b.celsius) {
      return b.celsius - a.celsius;
    }
    const la = a.label.toLowerCase();
    const lb = b.label.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  return zones.slice(0, 20);
}

/** Port of `parse_docker_container_names` (container id -> name). */
export function parseDockerContainerNames(output: string): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const raw of splitLines(output)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const parts = splitOnFirstTab(line);
    if (parts === null) {
      continue;
    }
    const containerId = parts[0].trim();
    const containerName = parts[1].trim();
    if (!containerId || !containerName) {
      continue;
    }
    mapping.set(containerId, containerName);
  }
  return mapping;
}

/** Port of `parse_docker_containers` (name, image, state, status; capped at 200). */
export function parseDockerContainers(output: string | null | undefined): ContainerInfo[] {
  if (!output) {
    return [];
  }
  const containers: ContainerInfo[] = [];
  for (const raw of splitLines(output)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const parts = line.split('\t');
    const name = parts[0].trim();
    if (!name) {
      continue;
    }
    const image = parts.length > 1 ? parts[1].trim() : '';
    const state = parts.length > 2 ? parts[2].trim() : '';
    const status = parts.length > 3 ? parts[3].trim() : '';
    containers.push({ name, image, state, status });
    if (containers.length >= 200) {
      break;
    }
  }
  return containers;
}

/** Port of `parse_pid_container_map` (pid -> container id). */
export function parsePidContainerMap(output: string): Map<number, string> {
  const mapping = new Map<number, string>();
  for (const raw of splitLines(output)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const parts = splitOnFirstTab(line);
    if (parts === null) {
      continue;
    }
    const pid = toInt(parts[0]);
    if (pid === null) {
      continue;
    }
    const ref = parts[1].trim();
    if (!ref) {
      continue;
    }
    if (/^[0-9a-f]{12,64}$/.test(ref)) {
      mapping.set(pid, ref);
      continue;
    }
    const match = CONTAINER_CGROUP_RE.exec(ref);
    if (match === null) {
      continue;
    }
    mapping.set(pid, match[1] ?? match[2]);
  }
  return mapping;
}

/** Port of `parse_total_processes`. */
export function parseTotalProcesses(output: string): number | null {
  return toInt(output);
}

/** Port of `parse_cpu_usage_percent`. */
export function parseCpuUsagePercent(output: string): number | null {
  if (!output.trim()) {
    return null;
  }
  const idleMatch = CPU_IDLE_RE.exec(output);
  if (idleMatch !== null) {
    const idle = Number(idleMatch[1]);
    if (!Number.isFinite(idle)) {
      return null;
    }
    return roundHalfEven(100.0 - idle, 1);
  }
  return toFloat(output);
}

/** Port of `parse_net_totals` — `[rx, tx]`, each validated or `null`. */
export function parseNetTotals(
  text: string | null | undefined,
): [number | null, number | null] {
  if (!text) {
    return [null, null];
  }
  const parts = text.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length < 2) {
    return [null, null];
  }
  const rxRaw = Number(parts[0]);
  const txRaw = Number(parts[1]);
  if (!Number.isFinite(rxRaw) || !Number.isFinite(txRaw)) {
    return [null, null];
  }
  const rx = Math.trunc(rxRaw);
  const tx = Math.trunc(txRaw);
  if (rx < 0 || tx < 0) {
    return [null, null];
  }
  return [rx, tx];
}
