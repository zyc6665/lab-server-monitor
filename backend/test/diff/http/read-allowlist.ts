/**
 * P7 Task 2 — full read-endpoint differential: allowlist + normalisation metadata.
 *
 * This module is the single, auditable home for everything the read-endpoint
 * differential is allowed to ignore.  The test (`full-read-diff.test.ts`) imports
 * these tables and applies them uniformly: any divergence that is *not*
 * explained here fails the test.
 *
 * Nothing here loosens a business field to hide a mismatch — every entry is
 * either a genuinely volatile value (a wall-clock "now" stamped at request
 * time), an OS/environment fingerprint (listen port, pid), one of the
 * structural differences already documented in P5, or a documented additive
 * Node-only schema key that the frozen Python oracle predates.
 *
 * Normalisation rules implemented by the test itself (per plan §9.1):
 *   - ISO-8601 timestamps are parsed back to an absolute UTC instant at µs
 *     precision (`instantMicros` in `../harness.ts`), so `+00:00` / `Z` /
 *     `+08:00` renderings of the same moment compare equal. Keeping the full
 *     6-digit fraction is the "unify to 6 digits" branch of the plan (no
 *     truncation to ms, so no lossy rounding is introduced).
 *   - Floats are unified with `toFixed(6)` (~1e-6 relative tolerance).
 *   - Object keys are compared as sets (insertion order irrelevant).
 *   - Arrays of objects are sorted by an explicit key (`ARRAY_SORT_KEY_PRECEDENCE`
 *     below): `alerts` by `id`, `hosts` by `name`, `series`/`points` by `t`,
 *     alert buckets by `key`, capacity metrics by `key`, etc. A canonical JSON
 *     fallback keeps any remaining object-array deterministic on both sides.
 */

/**
 * Long-lived, documented cross-stack divergences (P5 + P7).
 *
 * Keys are endpoint *templates*; `allowedDiffsFor()` resolves a concrete request
 * path (query string stripped) to the matching template. Only endpoints listed
 * here are permitted to differ; every other endpoint must be observationally
 * identical to the Python oracle.
 */
export const ALLOWED_DIFFS: Record<string, string[]> = {
  '/api/users': [
    // P5 documented diff. Node exposes the per-host sudo flag as `sudo_ok`
    // while the Flask oracle names it `sudo_<flag>`, and Node adds a live
    // `usage_scan` progress object (running / last_error / …) that the Flask
    // payload does not carry. Both are intentional Node-side enrichments of the
    // same underlying rows, not a data mismatch.
    'sudo flag naming (Node `sudo_ok` vs Python `sudo_<flag>`) + Node-only live `usage_scan` enrichment',
  ],
  '/api/host/:name': [
    // P5 documented diff. The Node read reducer returns the reduced summary
    // payload (name/host/collected_at/success/group/owner/location/tags/
    // metrics/errors/disk/alerts/checks); Flask returns the full page-context
    // detail, additionally carrying alert_days/check_history/collection_uptime/
    // diagnostics/diagnostics_summary/network/uptime_strip/users, which the Node
    // page composes separately on the client. Summary granularity, not data.
    'summary-granularity: Node returns the reduced host summary; Python returns the full page-context detail',
  ],
  '/api/settings': [
    // Additive-only schema extension. The Node settings schema gained the
    // `report.executive` sub-section (管理层摘要版日报: enabled / subject_prefix /
    // to_addrs) after the Python oracle was frozen, so the Node payload carries
    // one extra object under `report` that the golden response cannot contain.
    // P1-1 adds a second additive key: `monitoring.stage_retries` (collect-stage
    // retry count, 0..3, default 1), also absent from the frozen oracle.
    // No existing field changed shape or value; the extensions are covered by
    // test/config/report-executive.test.ts, test/config/defaults.test.ts,
    // test/config/schema.test.ts and test/web/settings.test.ts.
    'additive keys: Node-only `report.executive` settings block (executive daily report) + P1-1 `monitoring.stage_retries` absent from the frozen Python oracle',
  ],
};

/**
 * Resolves the allowlist entries that apply to a concrete request path.
 *
 * `/api/host/<name>/history` and `/api/host/<name>/report` must stay exact, so
 * the `/api/host/:name` template only matches the bare two-segment path.
 */
export function allowedDiffsFor(requestPath: string): string[] {
  const clean = requestPath.split('?')[0];
  if (ALLOWED_DIFFS[clean]) {
    return ALLOWED_DIFFS[clean];
  }
  if (/^\/api\/host\/[^/]+$/.test(clean) && ALLOWED_DIFFS['/api/host/:name']) {
    return ALLOWED_DIFFS['/api/host/:name'];
  }
  return [];
}

/**
 * Keys whose values are computed from the *request-time* clock and therefore
 * legitimately differ between two independent processes (Node and Python each
 * call `now()`). Masked to a fixed token before comparison.
 */
export const VOLATILE_KEYS: string[] = [
  'generated_at', // templates stamp "generated at <now>" into pages/reports
  'generatedAt', // camelCase variant used by a few builders
  'last_run_at', // scheduler heartbeat written with now()
  'now', // echoed reference instant
  'age_seconds', // now - collected_at, a relative scalar
  'uptime_seconds', // now - first_seen_at, a relative scalar
];

/**
 * Environment / OS fingerprints that are structurally identical but carry a
 * value unique to the running process or host, so their bytes are meaningless
 * for equivalence. Masked globally.
 */
export const GLOBAL_MASK_KEYS: string[] = [
  'port', // listen / SSH port echoed from config or the live socket
  'pid', // process id of the stack that answered
  'url', // runtime origin embeds the live port
  'runtime', // runtime fingerprint object {pid, port, url}
];

/**
 * Per-endpoint extra masks (on top of `VOLATILE_KEYS` + `GLOBAL_MASK_KEYS`).
 * Keyed by exact request path (query string ignored).
 */
export const ENDPOINT_MASKS: Record<string, string[]> = {
  '/api/settings': [
    // `key_path` is the configured SSH key location. Python renders it through
    // pathlib (Windows separators `\\home\\...`) while Node keeps the literal
    // configured string; the *path it designates* is identical, only the OS
    // separator spelling differs. (Already masked by P5.)
    'key_path',
  ],
  '/api/settings/hosts': [
    // Same rationale as `/api/settings`.
    'key_path',
  ],
  '/api/system/health': [
    // db_path points at each stack's own temp copy; db_size_bytes differs after
    // Node writes its DPAPI admin secret; usage is derived runtime state (free
    // disk space / per-file sizes) not seed content.
    'db_path',
    'db_size_bytes',
    'usage',
  ],
  '/api/system/storage': [
    // usage.total is free-disk-space of the host; db_path is the temp copy path.
    'db_path',
    'usage',
  ],
};

/**
 * Preferred sort keys for arrays of objects, tried left-to-right and applied
 * only when the key exists on every element. Makes `alerts` (id), `hosts`
 * (name), `points`/`series` (t), alert `buckets`/`alert_days` (key), capacity
 * `metrics` (key) and uptime buckets (index) order-independent on both stacks.
 */
export const ARRAY_SORT_KEY_PRECEDENCE: string[] = [
  'id',
  'index',
  'host_name',
  'name',
  'username',
  'key',
  't',
  'timestamp',
  'start',
  'day',
  'host',
  'label',
];
