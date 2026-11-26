/**
 * Frozen Python-oracle outputs (P8 Task1).
 *
 * Cross-stack diff tests used to spawn the Python implementation as an oracle.
 * Its outputs were frozen into the `golden/*.json` files next to each test
 * while Python was still available; the Python implementation has since been
 * removed, so these files are the single source of truth and cannot be
 * regenerated.
 *
 * File shape: `{ "_source": string, "_commit": string, "entries": { [key]: value } }`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface GoldenFile {
  _source: string;
  _commit: string;
  entries: Record<string, unknown>;
}

const cache = new Map<string, GoldenFile>();

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function loadGolden(file: string): GoldenFile {
  let data = cache.get(file);
  if (!data) {
    if (!existsSync(file)) {
      throw new Error(`golden file missing: ${file}`);
    }
    data = JSON.parse(readFileSync(file, 'utf-8')) as GoldenFile;
    cache.set(file, data);
  }
  return data;
}

/** Return the frozen oracle value recorded under `key` in `file`. */
export function golden<T = unknown>(file: string, key: string): T {
  const data = loadGolden(file);
  if (!Object.prototype.hasOwnProperty.call(data.entries, key)) {
    throw new Error(`golden entry "${key}" missing from ${file}`);
  }
  // Deep clone so tests can never mutate the shared cached copy.
  return JSON.parse(JSON.stringify(data.entries[key])) as T;
}

/**
 * Freeze-time helper: when `FREEZE_GOLDEN=1`, run `produce` (the live Python
 * oracle) and record its value under `key`; otherwise replay the frozen value.
 */
const pending = new Map<string, Record<string, unknown>>();
export function oracleValue<T = unknown>(file: string, key: string, produce: () => T): T {
  if (process.env.FREEZE_GOLDEN === '1') {
    const value = produce();
    let entries = pending.get(file);
    if (!entries) {
      entries = {};
      pending.set(file, entries);
    }
    entries[key] = JSON.parse(JSON.stringify(value ?? null));
    writeGolden(file, process.env.FREEZE_SOURCE ?? path.basename(file), process.env.FREEZE_COMMIT ?? 'unknown', entries);
    cache.delete(file);
    return value;
  }
  return golden<T>(file, key);
}

/** Serialise a golden file deterministically (sorted keys, 2-space, trailing LF). */
export function writeGolden(file: string, source: string, commit: string, entries: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const body = { _commit: commit, _source: source, entries: sortKeys(entries) };
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf-8');
}
