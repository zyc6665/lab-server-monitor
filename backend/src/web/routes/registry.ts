/**
 * `url_for` endpoint registry — the Express counterpart of Flask's endpoint
 * URL map (`app.add_url_rule(..., endpoint=...)`).
 *
 * The design (§6.2) keeps the oracle's endpoint names as the mapping keys so the
 * reused Jinja templates can call `url_for('host_page', name=host.name)` etc.
 * unchanged. Path parameters are stored as `{name}` placeholders; `urlFor()`
 * percent-encodes them, appends any leftover params as an ordered query string
 * (dropping `null`/`undefined`, as Flask does), and throws on unknown endpoints.
 *
 * The `static` endpoint is special-cased so `filename` keeps its directory
 * separators (matching Flask's `path` converter) while each segment is encoded.
 */

/** Endpoint name → path template (`{param}` placeholders). */
export const ENDPOINTS = {
  // --- pages ---------------------------------------------------------------
  overview_page: '/',
  hosts_page: '/hosts',
  host_page: '/host/{name}',
  alerts_page: '/alerts',
  disk_health_page: '/disk-health',
  compute_page: '/compute',
  my_page: '/my',
  users_page: '/users',
  settings_page: '/settings',
  terminal_page: '/terminal',
  tasks_page: '/tasks',
  reports_page: '/reports',

  // --- auth ----------------------------------------------------------------
  setup: '/setup',
  login: '/login',
  login_submit: '/login',
  logout: '/logout',
  api_change_password: '/api/settings/password',

  // --- overview ------------------------------------------------------------
  api_overview: '/api/overview',
  api_overview_capacity: '/api/overview/capacity',
  api_overview_history: '/api/overview/history',
  api_overview_alert_history: '/api/overview/alert-history',
  api_overview_report: '/api/overview/report',

  // --- pages / compute / my ------------------------------------------------
  api_compute: '/api/compute',
  api_my_summary: '/api/my/summary',

  // --- alerts --------------------------------------------------------------
  api_alerts: '/api/alerts',
  api_ack_alert: '/api/alerts/{alert_id}/ack',
  api_list_silences: '/api/settings/silences',
  api_add_silence: '/api/settings/silences',
  api_delete_silence: '/api/settings/silences/{silence_id}',

  // --- hosts ---------------------------------------------------------------
  probe_host_settings: '/api/settings/hosts/probe',
  api_host: '/api/host/{name}',
  api_host_report: '/api/host/{name}/report',
  api_host_history: '/api/host/{name}/history',
  api_host_collection_status: '/api/settings/hosts/collection-status',
  api_list_hosts: '/api/settings/hosts',
  api_upsert_host: '/api/settings/hosts/{name}',
  api_delete_host: '/api/settings/hosts/{name}',
  api_preview_host_import: '/api/settings/hosts/import/preview',
  api_ssh_config_preview: '/api/settings/hosts/ssh-config',
  api_ssh_config_import: '/api/settings/hosts/ssh-config/import',
  api_import_hosts: '/api/settings/hosts/import',
  api_test_hosts_batch: '/api/settings/hosts/test-batch',
  api_probe_saved_host: '/api/settings/hosts/{name}/probe',
  api_test_saved_host_check: '/api/settings/hosts/{name}/checks/test',
  api_host_container_stats: '/api/host/{name}/containers/stats',
  api_run_host_checks: '/api/host/{name}/checks/run',
  api_collect_saved_host: '/api/settings/hosts/{name}/collect',
  api_collect_saved_hosts: '/api/settings/hosts/collect',
  api_copy_host: '/api/settings/hosts/{name}/copy',

  // --- settings ------------------------------------------------------------
  api_get_settings: '/api/settings',
  api_put_settings_section: '/api/settings/{section}',
  api_test_ssh: '/api/settings/test-ssh',
  api_test_email: '/api/settings/test-email',
  api_test_desktop: '/api/settings/test-desktop',
  api_test_webhook: '/api/settings/test-webhook',

  // --- system --------------------------------------------------------------
  api_system_host_keys: '/api/system/host-keys',
  api_system_host_key_forget: '/api/system/host-keys/{hostname}',
  api_system_health: '/api/system/health',
  api_system_storage: '/api/system/storage',
  api_system_maintenance: '/api/system/maintenance',
  api_system_backup: '/api/system/backup',
  api_system_restore: '/api/system/restore',
  api_system_config_export: '/api/system/config-export',
  api_system_tasks: '/api/system/tasks',
  api_run_system_task: '/api/system/tasks/{name}/run',
  api_reports_preview: '/api/reports/preview',
  api_reports_history: '/api/reports/history',
  api_reports_send: '/api/reports/send',
  api_logs: '/api/logs',
  api_logs_download: '/api/logs/download',
  api_runtime: '/api/runtime',

  // --- users ---------------------------------------------------------------
  api_users: '/api/users',
  api_users_refresh: '/api/users/refresh',
  api_users_history: '/api/users/history',
  api_users_top: '/api/users/top',
  api_users_refresh_status: '/api/users/refresh-status',
  api_users_baseline_remove: '/api/users/baseline/remove',
  api_users_plan: '/api/users/plan',
  api_users_execute: '/api/users/execute',
  api_users_execute_status: '/api/users/execute/status',
  api_users_operations: '/api/users/operations',

  // --- ssh terminal --------------------------------------------------------
  create_ssh_session: '/api/ssh/sessions',
  ssh_terminal_input: '/api/ssh/sessions/{session_id}/input',
  ssh_terminal_resize: '/api/ssh/sessions/{session_id}/resize',
  ssh_terminal_close: '/api/ssh/sessions/{session_id}',
  ssh_terminal_stream: '/api/ssh/sessions/{session_id}/stream',

  // --- static --------------------------------------------------------------
  static: '/static/{filename}',
} as const;

/** A known endpoint name. */
export type EndpointName = keyof typeof ENDPOINTS;

/** Free-form url_for parameters (path params + query params). */
export type UrlParams = Record<string, unknown>;

const PARAM_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** True when `name` is a registered endpoint. */
export function hasEndpoint(name: string): name is EndpointName {
  return Object.prototype.hasOwnProperty.call(ENDPOINTS, name);
}

/** Python-style query rendering: `True`/`False` for booleans. */
function queryValue(value: unknown): string {
  if (value === true) {
    return 'True';
  }
  if (value === false) {
    return 'False';
  }
  return String(value);
}

/** Encodes a slash-separated path (each segment) rather than the whole string. */
function encodePathSegmentPath(value: string): string {
  return value
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** Builds the ordered query string, skipping `null` / `undefined` values. */
function queryString(params: UrlParams): string {
  const parts: string[] = [];
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (value === undefined || value === null) {
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(queryValue(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/**
 * Builds a URL for a named endpoint.
 *
 * @throws Error when the endpoint is unknown or a required path param is
 * missing — mirroring Flask's `BuildError`.
 */
export function urlFor(name: string, params: UrlParams = {}): string {
  if (!hasEndpoint(name)) {
    throw new Error(`url_for: unknown endpoint "${name}"`);
  }
  const template = ENDPOINTS[name];

  if (name === 'static') {
    const filename = params.filename;
    if (filename === undefined || filename === null) {
      throw new Error('url_for("static"): missing value for "filename"');
    }
    const { filename: _filename, ...rest } = params;
    void _filename;
    return `/static/${encodePathSegmentPath(String(filename))}${queryString(rest)}`;
  }

  const used = new Set<string>();
  const path = template.replace(PARAM_RE, (_match, key: string) => {
    const value = params[key];
    if (value === undefined || value === null) {
      throw new Error(`url_for("${name}"): missing value for "${key}"`);
    }
    used.add(key);
    return encodeURIComponent(String(value));
  });

  const rest: UrlParams = {};
  for (const key of Object.keys(params)) {
    if (!used.has(key)) {
      rest[key] = params[key];
    }
  }
  return `${path}${queryString(rest)}`;
}

/**
 * Builds a `/static/...` URL with the `?v=<APP_VERSION>` cache-buster used by
 * the `asset_url` template global.
 */
export function assetUrl(filename: string, version?: string): string {
  const base = `/static/${encodePathSegmentPath(String(filename))}`;
  return version ? `${base}?v=${encodeURIComponent(version)}` : base;
}
