/**
 * storcli disk-health parsers — 1:1 TypeScript port of
 * `servermanage/disk_health.py` lines 128-529 (the data models + parsing
 * helpers; the health-evaluation rules and SSH collection that follow them are
 * out of scope for Task 3).
 *
 * Conventions (mirrors the rest of the backend port):
 * - Python `X | None` -> `X | null` (never `undefined`).
 * - Python dataclass field names (`snake_case`) are exposed as `camelCase`; the
 *   persisted / oracle-facing Python names are documented in the field-map
 *   tables below and exported as {@link CONTROLLER_FIELD_MAP} /
 *   {@link VIRTUAL_DRIVE_FIELD_MAP} / {@link PHYSICAL_DRIVE_FIELD_MAP}.
 * - Missing / N/A values become `null`, never `0` (see `_clean` / `_to_int`).
 * - The Python module-level helpers (`_clean`, `_to_int`, `_to_bool`,
 *   `_norm_key`, `_flatten_pairs`, `_lookup`, `_first_dict`, `_load_json`,
 *   `_controllers`, `_extract_bbu_state`, `_virtual_drive_id`) are private to
 *   this module and not exported; only the public `parse_*` API is surfaced.
 *
 * Field mapping (TypeScript camelCase -> Python snake_case)
 * --------------------------------------------------------
 * DiskControllerInfo  (`disk_health.py:50-57`)
 *   controller -> controller | model -> model | firmware -> firmware |
 *   bbuState -> bbu_state | health -> health | reasons -> reasons
 * VirtualDriveInfo    (`disk_health.py:60-68`)
 *   controller -> controller | vdId -> vd_id | raidLevel -> raid_level |
 *   state -> state | size -> size | health -> health | reasons -> reasons
 * PhysicalDriveInfo   (`disk_health.py:71-87`)
 *   controller -> controller | enclosure -> enclosure | slot -> slot |
 *   did -> did | model -> model | serial -> serial | state -> state |
 *   mediaErrors -> media_errors | otherErrors -> other_errors |
 *   predictiveFailures -> predictive_failures | smartAlert -> smart_alert |
 *   temperatureC -> temperature_c | shieldCounter -> shield_counter |
 *   health -> health | reasons -> reasons
 */

/** `disk_health.py:46-47` — raised when storcli output cannot be parsed. */
export class StorcliParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorcliParseError';
    Object.setPrototypeOf(this, StorcliParseError.prototype);
  }
}

/** `disk_health.py:50-57` — `DiskControllerInfo`. */
export interface DiskControllerInfo {
  controller: number;
  model: string | null;
  firmware: string | null;
  bbuState: string | null;
  health: string;
  reasons: string[];
}

/** `disk_health.py:60-68` — `VirtualDriveInfo`. */
export interface VirtualDriveInfo {
  controller: number;
  vdId: number;
  raidLevel: string | null;
  state: string | null;
  size: string | null;
  health: string;
  reasons: string[];
}

/** `disk_health.py:71-87` — `PhysicalDriveInfo`. */
export interface PhysicalDriveInfo {
  controller: number;
  enclosure: number | null;
  slot: number | null;
  did: number | null;
  model: string | null;
  serial: string | null;
  state: string | null;
  mediaErrors: number | null;
  otherErrors: number | null;
  predictiveFailures: number | null;
  smartAlert: boolean | null;
  temperatureC: number | null;
  shieldCounter: number | null;
  health: string;
  reasons: string[];
}

/** camelCase -> Python dataclass field name for `DiskControllerInfo`. */
export const CONTROLLER_FIELD_MAP: Readonly<Record<keyof DiskControllerInfo, string>> = {
  controller: 'controller',
  model: 'model',
  firmware: 'firmware',
  bbuState: 'bbu_state',
  health: 'health',
  reasons: 'reasons',
};

/** camelCase -> Python dataclass field name for `VirtualDriveInfo`. */
export const VIRTUAL_DRIVE_FIELD_MAP: Readonly<Record<keyof VirtualDriveInfo, string>> = {
  controller: 'controller',
  vdId: 'vd_id',
  raidLevel: 'raid_level',
  state: 'state',
  size: 'size',
  health: 'health',
  reasons: 'reasons',
};

/** camelCase -> Python dataclass field name for `PhysicalDriveInfo`. */
export const PHYSICAL_DRIVE_FIELD_MAP: Readonly<Record<keyof PhysicalDriveInfo, string>> = {
  controller: 'controller',
  enclosure: 'enclosure',
  slot: 'slot',
  did: 'did',
  model: 'model',
  serial: 'serial',
  state: 'state',
  mediaErrors: 'media_errors',
  otherErrors: 'other_errors',
  predictiveFailures: 'predictive_failures',
  smartAlert: 'smart_alert',
  temperatureC: 'temperature_c',
  shieldCounter: 'shield_counter',
  health: 'health',
  reasons: 'reasons',
};

// ---------------------------------------------------------------------------
// Low-level conversion helpers (`disk_health.py:116-247`).
// Missing / N/A values must become None, never 0.
// ---------------------------------------------------------------------------

const TRUE_WORDS = new Set(['yes', 'y', 'true', '1']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0']);
const MISSING_WORDS = new Set(['', '-', 'n/a', 'na', 'none', 'null', 'unknown']);

const TEMP_RE = /(-?\d+(?:\.\d+)?)\s*C\b/i;
const INT_RE = /-?\d+/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Port of Python `str()` for the JSON-decoded scalar types we encounter.
 * Differences that matter for the oracle: `bool` -> "True"/"False" and a
 * float keeps a trailing `.0` (`3.0` -> "3.0") instead of JS's `"3"`.
 */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return String(value);
    }
    // Python repr of a float is close enough to String() for typical values;
    // ensure whole-valued floats keep a decimal point.
    return Number.isFinite(value) ? String(value) : String(value);
  }
  return String(value);
}

/** Port of Python truthiness for the values that flow through `or` / `if`. */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0; // (NaN -> true in Python; JS NaN is falsy, but N/A)
  }
  if (typeof value === 'string') {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

/** `disk_health.py:128-135` — trim a textual field; empty / N/A-ish -> null. */
function clean(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = pyStr(value).trim();
  if (MISSING_WORDS.has(text.toLowerCase())) {
    return null;
  }
  return text;
}

/** `disk_health.py:138-155` — best-effort integer conversion; missing -> null. */
function toInt(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  const text = String(value).trim();
  if (MISSING_WORDS.has(text.toLowerCase())) {
    return null;
  }
  const match = INT_RE.exec(text);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[0], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** `disk_health.py:158-171` — best-effort boolean conversion; missing -> null. */
function toBool(value: unknown): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value !== 0 : null;
  }
  const text = String(value).trim().toLowerCase();
  if (TRUE_WORDS.has(text)) {
    return true;
  }
  if (FALSE_WORDS.has(text)) {
    return false;
  }
  return null;
}

/** `disk_health.py:174-197` — parse a storcli temperature value. */
export function parseTemperature(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  const text = String(value).trim();
  if (!text || MISSING_WORDS.has(text.toLowerCase())) {
    return null;
  }
  const match = TEMP_RE.exec(text);
  if (match) {
    const parsed = Number.parseFloat(match[1]);
    return Number.isNaN(parsed) ? null : Math.trunc(parsed);
  }
  // Fall back to a bare numeric string.
  const fallback = Number.parseFloat(text);
  return Number.isNaN(fallback) ? null : Math.trunc(fallback);
}

/** `disk_health.py:200-202` — normalise a key for case/space/punct-insensitive match. */
function normKey(key: unknown): string {
  return pyStr(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** `disk_health.py:205-226` — recursively collect every leaf `key -> value`. */
function flattenPairs(obj: unknown): Array<[string, unknown]> {
  const pairs: Array<[string, unknown]> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item !== null && typeof item === 'object') {
          walk(item);
        }
      }
      return;
    }
    if (isPlainObject(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (value !== null && typeof value === 'object') {
          walk(value);
        } else {
          pairs.push([key, value]);
        }
      }
    }
  };
  walk(obj);
  return pairs;
}

/** `disk_health.py:229-235` — first value whose normalised key matches a name. */
function lookup(pairs: Array<[string, unknown]>, ...names: string[]): unknown {
  const targets = new Set(names.map(normKey));
  for (const [key, value] of pairs) {
    if (targets.has(normKey(key))) {
      return value;
    }
  }
  return null;
}

/** `disk_health.py:238-246` — first dict inside a value, or `{}`. */
function firstDict(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isPlainObject(item)) {
        return item;
      }
    }
    return {};
  }
  if (isPlainObject(value)) {
    return value;
  }
  return {};
}

// ---------------------------------------------------------------------------
// JSON loading (`disk_health.py:249-276`).
// Tolerant of stray leading/trailing console noise.
// ---------------------------------------------------------------------------

/**
 * Return the exclusive end index of the first complete JSON object/array that
 * begins at `start` (which must point at `{` or `[`), or -1 when unterminated.
 * Mirrors `json.JSONDecoder().raw_decode`'s willingness to ignore trailing text.
 */
function rawDecodeEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return -1;
}

/** `disk_health.py:253-267` — parse the first JSON value, skipping noise. */
function loadJson(text: unknown): unknown {
  if (typeof text !== 'string') {
    throw new StorcliParseError('storcli output must be a string');
  }
  const cleaned = text.replace(/^\uFEFF+/, '').trim();
  if (!cleaned) {
    throw new StorcliParseError('empty storcli output');
  }
  const candidates = [cleaned.indexOf('{'), cleaned.indexOf('[')].filter((idx) => idx >= 0);
  if (candidates.length === 0) {
    throw new StorcliParseError('no JSON object found in storcli output');
  }
  const start = Math.min(...candidates);
  const end = rawDecodeEnd(cleaned, start);
  const slice = end >= 0 ? cleaned.slice(start, end) : cleaned.slice(start);
  try {
    return JSON.parse(slice);
  } catch (exc) {
    throw new StorcliParseError(
      `invalid storcli JSON: ${exc instanceof Error ? exc.message : String(exc)}`,
    );
  }
}

/** `disk_health.py:270-276` — extract the `Controllers` list from parsed JSON. */
function controllers(obj: unknown): Array<Record<string, unknown>> {
  if (!isPlainObject(obj)) {
    throw new StorcliParseError('storcli JSON is not an object');
  }
  const list = obj.Controllers;
  if (!Array.isArray(list)) {
    throw new StorcliParseError("storcli JSON has no 'Controllers' list");
  }
  return list.filter(isPlainObject);
}

// ---------------------------------------------------------------------------
// `/cALL show J` -> controllers (`disk_health.py:279-321`).
// ---------------------------------------------------------------------------

/** `disk_health.py:283-292` — pull a BBU / cache-vault state out of a response. */
function extractBbuState(response: Record<string, unknown>): string | null {
  for (const key of ['Cachevault_Info', 'BBU_Info', 'BBU']) {
    const value = response[key];
    const block = firstDict(value);
    if (Object.keys(block).length > 0) {
      const state = pyTruthy(block.State) ? block.State : block.Type;
      const cleaned = clean(state);
      if (cleaned !== null) {
        return cleaned;
      }
    }
  }
  return null;
}

/** `disk_health.py:295-321` — parse `/cALL show J` output into controller records. */
export function parseControllers(text: string): DiskControllerInfo[] {
  const result: DiskControllerInfo[] = [];
  controllers(loadJson(text)).forEach((raw, index) => {
    const status = isPlainObject(raw['Command Status']) ? raw['Command Status'] : {};
    const response = isPlainObject(raw['Response Data']) ? raw['Response Data'] : {};

    let controller = toInt(status.Controller);
    if (controller === null) {
      controller = index;
    }

    const pairs = flattenPairs(response);
    const model = clean(lookup(pairs, 'Product Name'));
    const firmware = clean(lookup(pairs, 'FW Version'));

    result.push({
      controller,
      model,
      firmware,
      bbuState: extractBbuState(response),
      health: 'unknown',
      reasons: [],
    });
  });
  return result;
}

// ---------------------------------------------------------------------------
// `/cX/vall show J` -> virtual drives (`disk_health.py:324-364`).
// ---------------------------------------------------------------------------

/** `disk_health.py:328-338` — resolve a virtual drive id from a row. */
function virtualDriveId(raw: Record<string, unknown>): number {
  const dgVd = raw['DG/VD'];
  if (typeof dgVd === 'string' && dgVd.includes('/')) {
    const candidate = toInt(dgVd.slice(dgVd.lastIndexOf('/') + 1));
    if (candidate !== null) {
      return candidate;
    }
  }
  for (const key of ['VD', 'VD ID', 'VDID']) {
    const candidate = toInt(raw[key]);
    if (candidate !== null) {
      return candidate;
    }
  }
  return 0;
}

/** `disk_health.py:341-364` — parse `/cX/vall show J` into virtual drive records. */
export function parseVirtualDrives(text: string, controller: number): VirtualDriveInfo[] {
  const result: VirtualDriveInfo[] = [];
  for (const rawController of controllers(loadJson(text))) {
    const response = isPlainObject(rawController['Response Data'])
      ? rawController['Response Data']
      : {};
    let vds: unknown = response['Virtual Drives'];
    if (!Array.isArray(vds)) {
      vds = response['VD LIST'];
    }
    if (!Array.isArray(vds)) {
      continue;
    }
    for (const raw of vds) {
      if (!isPlainObject(raw)) {
        continue;
      }
      const typeValue = pyTruthy(raw.TYPE) ? raw.TYPE : raw.Type;
      result.push({
        controller,
        vdId: virtualDriveId(raw),
        raidLevel: clean(typeValue),
        state: clean(raw.State),
        size: clean(raw.Size),
        health: 'unknown',
        reasons: [],
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// `/cX/eall/sall show all J` -> physical drives
// (`disk_health.py:367-489`; JSON first, text fallback).
// ---------------------------------------------------------------------------

const BASE_DRIVE_KEY_RE = /^Drive \/c(\d+)\/e(\d+)\/s(\d+)$/;
const TEXT_DRIVE_HEADER_RE = /Drive \/c(\d+)\/e(\d+)\/s(\d+)(?: - Detailed Information|\s+State)?:?/;
const TEXT_KV_RE = /^\s*([^=]+?)\s*=\s*(.*?)\s*$/;

/** Port of Python `str.splitlines()` (no trailing empty line). */
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

/** `disk_health.py:378-422` — parse the JSON `show all J` physical-drive output. */
export function parsePhysicalDrivesJson(text: string): PhysicalDriveInfo[] {
  const drives: PhysicalDriveInfo[] = [];
  for (const rawController of controllers(loadJson(text))) {
    const status = isPlainObject(rawController['Command Status'])
      ? rawController['Command Status']
      : {};
    const response = isPlainObject(rawController['Response Data'])
      ? rawController['Response Data']
      : {};

    const fallbackController = toInt(status.Controller);

    for (const [baseKey, value] of Object.entries(response)) {
      const match = BASE_DRIVE_KEY_RE.exec(String(baseKey).trim());
      if (!match) {
        continue;
      }
      const ctrlNum = Number.parseInt(match[1], 10);
      const enclosure = Number.parseInt(match[2], 10);
      const slot = Number.parseInt(match[3], 10);

      const baseItem = firstDict(value);
      const detail = response[`${baseKey} - Detailed Information`];
      const pairs = detail !== undefined && detail !== null ? flattenPairs(detail) : [];

      const controller = Number.isNaN(ctrlNum)
        ? fallbackController === null
          ? 0
          : fallbackController
        : ctrlNum;
      const leftModel = clean(lookup(pairs, 'Model Number'));
      const model = pyTruthy(leftModel) ? leftModel : clean(baseItem.Model);

      drives.push({
        controller,
        enclosure: Number.isNaN(enclosure) ? null : enclosure,
        slot: Number.isNaN(slot) ? null : slot,
        did: toInt(baseItem.DID),
        model,
        serial: clean(lookup(pairs, 'SN')),
        state: clean(baseItem.State),
        mediaErrors: toInt(lookup(pairs, 'Media Error Count')),
        otherErrors: toInt(lookup(pairs, 'Other Error Count')),
        predictiveFailures: toInt(lookup(pairs, 'Predictive Failure Count')),
        smartAlert: toBool(lookup(pairs, 'S.M.A.R.T alert flagged by drive')),
        temperatureC: parseTemperature(lookup(pairs, 'Drive Temperature')),
        shieldCounter: toInt(lookup(pairs, 'Shield Counter')),
        health: 'unknown',
        reasons: [],
      });
    }
  }
  return drives;
}

/** `disk_health.py:425-471` — parse human-readable `show all` text output. */
export function parsePhysicalDrivesText(text: string): PhysicalDriveInfo[] {
  if (typeof text !== 'string') {
    throw new StorcliParseError('storcli output must be a string');
  }

  const drives = new Map<string, PhysicalDriveInfo>();
  const order: string[] = [];
  let current: PhysicalDriveInfo | null = null;

  const makeDrive = (controller: number, enclosure: number, slot: number): PhysicalDriveInfo => ({
    controller,
    enclosure,
    slot,
    did: null,
    model: null,
    serial: null,
    state: null,
    mediaErrors: null,
    otherErrors: null,
    predictiveFailures: null,
    smartAlert: null,
    temperatureC: null,
    shieldCounter: null,
    health: 'unknown',
    reasons: [],
  });

  for (const line of splitLines(text)) {
    const header = TEXT_DRIVE_HEADER_RE.exec(line);
    if (header) {
      const controller = Number.parseInt(header[1], 10);
      const enclosure = Number.parseInt(header[2], 10);
      const slot = Number.parseInt(header[3], 10);
      const key = `${controller}/${enclosure}/${slot}`;
      if (!drives.has(key)) {
        drives.set(key, makeDrive(controller, enclosure, slot));
        order.push(key);
      }
      current = drives.get(key) ?? null;
      continue;
    }

    if (current === null) {
      continue;
    }
    const match = TEXT_KV_RE.exec(line);
    if (!match) {
      continue;
    }

    const name = normKey(match[1]);
    const value = match[2].trim();
    if (name === 'mediaerrorcount') {
      current.mediaErrors = toInt(value);
    } else if (name === 'othererrorcount') {
      current.otherErrors = toInt(value);
    } else if (name === 'predictivefailurecount') {
      current.predictiveFailures = toInt(value);
    } else if (name === 'drivetemperature') {
      current.temperatureC = parseTemperature(value);
    } else if (name === 'smartalertflaggedbydrive') {
      current.smartAlert = toBool(value);
    } else if (name === 'shieldcounter') {
      current.shieldCounter = toInt(value);
    } else if (name === 'sn') {
      current.serial = clean(value);
    } else if (name === 'modelnumber') {
      current.model = clean(value);
    }
  }

  return order.map((key) => drives.get(key) as PhysicalDriveInfo);
}

/**
 * `disk_health.py:474-489` — parse `/cX/eall/sall show all J`.
 *
 * JSON is tried first; on any JSON parse failure the text parser is used as a
 * fallback. {@link StorcliParseError} is raised only when both approaches fail
 * to yield a usable result.
 */
export function parsePhysicalDrives(text: string): PhysicalDriveInfo[] {
  let jsonError: StorcliParseError;
  try {
    return parsePhysicalDrivesJson(text);
  } catch (error) {
    if (!(error instanceof StorcliParseError)) {
      throw error;
    }
    jsonError = error;
  }
  const drives = parsePhysicalDrivesText(text);
  if (drives.length > 0) {
    return drives;
  }
  const combined = new StorcliParseError(
    'unable to parse storcli physical drive output as JSON or text',
  );
  // Mirror Python's `raise ... from json_error` for debugging.
  (combined as Error & { cause?: unknown }).cause = jsonError;
  throw combined;
}
