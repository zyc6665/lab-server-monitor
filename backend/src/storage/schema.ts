/**
 * Full SQLite schema (DDL) mirroring the Python oracle
 * `servermanage/storage/base.py`.
 *
 * Every statement below is transcribed verbatim (same table / column / index
 * names, types, `NOT NULL`, `DEFAULT`, `PRIMARY KEY`, `UNIQUE`) from the
 * `_CREATE_*_SQL` constants in `base.py:39-369`, in the same dependency order
 * used by `base.py::init_storage` (`base.py:839-857`).
 *
 * The three legacy migrations (`_ensure_host_metrics_columns`,
 * `_ensure_user_snapshot_columns`, `_migrate_host_daily_summary`) are *not*
 * part of the fresh-database DDL; they are handled by the migration module.
 * A freshly created schema already contains everything they would add.
 *
 * Deviation from `base.py`: the Python code never sets `PRAGMA user_version`
 * (the live database reports `0`). Node therefore defines its own baseline
 * schema version for future migration bookkeeping. Python ignores
 * `user_version`, so writing it keeps the shared file compatible.
 */
type SqliteDatabase = import('better-sqlite3').Database;

/**
 * Baseline schema version written to `PRAGMA user_version`.
 *
 * `base.py` does not define a schema/`user_version` value, so this is the
 * Node-side initial version (the full 20-table DDL below). Task 3's migration
 * runner bumps it when a legacy database is upgraded.
 */
export const SCHEMA_VERSION = 1;

/**
 * Every `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statement
 * from `base.py`, flattened one statement per array entry and kept in
 * dependency order. 20 tables + 16 indexes = 36 statements.
 */
export const CREATE_STATEMENTS: string[] = [
  // --- base.py:_CREATE_TABLE_SQL -------------------------------------------
  `CREATE TABLE IF NOT EXISTS host_metrics_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collected_at TEXT NOT NULL,
    host_name TEXT NOT NULL,
    host TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 0,
    cpu_usage_percent REAL,
    memory_used_mb INTEGER,
    memory_total_mb INTEGER,
    disk_used_percent REAL,
    gpu_utilization_percent REAL,
    gpu_memory_used_mb INTEGER,
    gpu_memory_total_mb INTEGER,
    total_processes INTEGER,
    logged_in_user_count INTEGER,
    load_1 REAL,
    load_5 REAL,
    load_15 REAL,
    net_rx_bytes INTEGER,
    net_tx_bytes INTEGER,
    temperature_c REAL
);`,

  // --- base.py:_CREATE_INDEX_SQL -------------------------------------------
  `CREATE INDEX IF NOT EXISTS idx_host_metrics_history_collected_at
    ON host_metrics_history(collected_at);`,
  `CREATE INDEX IF NOT EXISTS idx_host_metrics_history_host
    ON host_metrics_history(host_name, host);`,
  `CREATE INDEX IF NOT EXISTS idx_host_metrics_history_host_collected
    ON host_metrics_history(host_name, collected_at);`,

  // --- base.py:_CREATE_EXTENDED_TABLES_SQL ---------------------------------
  `CREATE TABLE IF NOT EXISTS host_latest_snapshot (
    host_name TEXT PRIMARY KEY,
    collected_at TEXT NOT NULL,
    success INTEGER NOT NULL,
    raw_json TEXT NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS disk_controller_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collected_at TEXT NOT NULL,
    host_name TEXT NOT NULL,
    controller INTEGER,
    model TEXT,
    firmware TEXT,
    bbu_state TEXT,
    health TEXT,
    reasons TEXT
);`,
  `CREATE TABLE IF NOT EXISTS disk_vd_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collected_at TEXT NOT NULL,
    host_name TEXT NOT NULL,
    controller INTEGER,
    vd_id INTEGER,
    raid_level TEXT,
    state TEXT,
    size TEXT,
    health TEXT,
    reasons TEXT
);`,
  `CREATE TABLE IF NOT EXISTS disk_pd_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collected_at TEXT NOT NULL,
    host_name TEXT NOT NULL,
    controller INTEGER,
    enclosure INTEGER,
    slot INTEGER,
    did INTEGER,
    model TEXT,
    serial TEXT,
    state TEXT,
    media_errors INTEGER,
    other_errors INTEGER,
    predictive_failures INTEGER,
    smart_alert INTEGER,
    temperature_c INTEGER,
    shield_counter INTEGER,
    health TEXT,
    reasons TEXT
);`,
  `CREATE TABLE IF NOT EXISTS disk_health_snapshot (
    host_name TEXT NOT NULL,
    collected_at TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    PRIMARY KEY (host_name, collected_at)
);`,
  `CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    host_name TEXT,
    category TEXT,
    severity TEXT,
    title TEXT,
    message TEXT,
    fingerprint TEXT,
    status TEXT DEFAULT 'active',
    notified_channels TEXT,
    ack_at TEXT
);`,
  `CREATE TABLE IF NOT EXISTS task_state (
    task_name TEXT PRIMARY KEY,
    last_run_at TEXT NOT NULL,
    last_result TEXT
);`,
  `CREATE TABLE IF NOT EXISTS host_daily_summary (
    day TEXT NOT NULL,
    host_name TEXT NOT NULL,
    tz TEXT NOT NULL DEFAULT 'UTC',
    host TEXT NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    cpu_sum REAL,
    cpu_max REAL,
    cpu_min REAL,
    memory_pct_sum REAL,
    memory_pct_max REAL,
    disk_pct_sum REAL,
    disk_pct_max REAL,
    gpu_util_sum REAL,
    gpu_util_max REAL,
    gpu_memory_pct_sum REAL,
    gpu_memory_pct_max REAL,
    load_sum REAL,
    users_sum REAL,
    processes_sum REAL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (day, host_name, tz)
);`,

  // --- base.py:_CREATE_EXTENDED_INDEX_SQL ----------------------------------
  `CREATE INDEX IF NOT EXISTS idx_disk_controller_snapshot_host_time
    ON disk_controller_snapshot(host_name, collected_at);`,
  `CREATE INDEX IF NOT EXISTS idx_disk_vd_snapshot_host_time
    ON disk_vd_snapshot(host_name, collected_at);`,
  `CREATE INDEX IF NOT EXISTS idx_disk_pd_snapshot_host_time
    ON disk_pd_snapshot(host_name, collected_at);`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_fingerprint
    ON alerts(fingerprint);`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_created_at
    ON alerts(created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_host_status_category
    ON alerts(host_name, status, category);`,
  `CREATE INDEX IF NOT EXISTS idx_host_daily_summary_day
    ON host_daily_summary(day);`,

  // --- base.py:_CREATE_SETTINGS_TABLES_SQL ---------------------------------
  `CREATE TABLE IF NOT EXISTS app_settings (
    section TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS app_secrets (
    name TEXT PRIMARY KEY,
    ciphertext BLOB NOT NULL,
    updated_at TEXT NOT NULL
);`,

  // --- base.py:_CREATE_SILENCE_TABLES_SQL / _CREATE_SILENCE_INDEX_SQL ------
  `CREATE TABLE IF NOT EXISTS alert_silences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_type TEXT NOT NULL,
    scope TEXT,
    reason TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT
);`,
  `CREATE INDEX IF NOT EXISTS idx_alert_silences_ends_at
    ON alert_silences(ends_at);`,

  // --- base.py:_CREATE_SSH_AUDIT_TABLES_SQL / _CREATE_SSH_AUDIT_INDEX_SQL --
  `CREATE TABLE IF NOT EXISTS ssh_audit_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_name TEXT NOT NULL,
    username TEXT NOT NULL,
    server_username TEXT,
    remote_addr TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    error TEXT
);`,
  `CREATE INDEX IF NOT EXISTS idx_ssh_audit_started_at
    ON ssh_audit_sessions(started_at);`,

  // --- base.py:_CREATE_HOST_CHECK_TABLES_SQL / index ----------------------
  `CREATE TABLE IF NOT EXISTS host_check_snapshot (
    host_name TEXT NOT NULL,
    check_name TEXT NOT NULL,
    check_type TEXT NOT NULL,
    target TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    latency_ms REAL,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (host_name, check_name)
);`,
  `CREATE INDEX IF NOT EXISTS idx_host_check_snapshot_host
    ON host_check_snapshot(host_name);`,

  // --- base.py:_CREATE_HOST_CHECK_HISTORY_SQL / index ---------------------
  `CREATE TABLE IF NOT EXISTS host_check_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_name TEXT NOT NULL,
    check_name TEXT NOT NULL,
    status TEXT NOT NULL,
    latency_ms REAL,
    checked_at TEXT NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_host_check_history_lookup
    ON host_check_history(host_name, check_name, id);`,

  // --- base.py:_CREATE_USER_TABLES_SQL (tables + interleaved index) -------
  `CREATE TABLE IF NOT EXISTS host_user_snapshot (
    host_name TEXT NOT NULL,
    username TEXT NOT NULL,
    uid INTEGER NOT NULL,
    gid INTEGER NOT NULL,
    primary_group TEXT,
    gecos TEXT,
    home TEXT,
    shell TEXT,
    groups_json TEXT NOT NULL DEFAULT '[]',
    in_docker INTEGER NOT NULL DEFAULT 0,
    in_sudo INTEGER NOT NULL DEFAULT 0,
    home_exists INTEGER NOT NULL DEFAULT 0,
    home_owner TEXT,
    home_group TEXT,
    home_mode TEXT,
    home_size_bytes INTEGER,
    data_exists INTEGER NOT NULL DEFAULT 0,
    data_owner TEXT,
    data_group TEXT,
    data_mode TEXT,
    data_size_bytes INTEGER,
    data_supported INTEGER NOT NULL DEFAULT 1,
    usage_stale INTEGER NOT NULL DEFAULT 0,
    usage_readable INTEGER NOT NULL DEFAULT 1,
    usage_collected_at TEXT,
    collected_at TEXT NOT NULL,
    PRIMARY KEY (host_name, username)
);`,
  `CREATE TABLE IF NOT EXISTS host_user_baseline (
    host_name TEXT NOT NULL,
    username TEXT NOT NULL,
    uid INTEGER,
    gid INTEGER,
    primary_group TEXT,
    shell TEXT,
    home TEXT,
    groups_json TEXT NOT NULL DEFAULT '[]',
    in_docker INTEGER NOT NULL DEFAULT 0,
    in_sudo INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (host_name, username)
);`,
  `CREATE TABLE IF NOT EXISTS host_user_scan_state (
    host_name TEXT PRIMARY KEY,
    last_scan_at TEXT,
    last_usage_at TEXT,
    last_error TEXT
);`,
  `CREATE TABLE IF NOT EXISTS host_user_usage_history (
    host_name TEXT NOT NULL,
    username TEXT NOT NULL,
    collected_at TEXT NOT NULL,
    home_size_bytes INTEGER,
    data_size_bytes INTEGER,
    PRIMARY KEY (host_name, username, collected_at)
);`,
  `CREATE INDEX IF NOT EXISTS idx_user_usage_history
    ON host_user_usage_history (host_name, collected_at);`,
  `CREATE TABLE IF NOT EXISTS user_operations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    host_name TEXT NOT NULL,
    account TEXT NOT NULL,
    operation TEXT NOT NULL,
    status TEXT NOT NULL,
    actor TEXT,
    plan_hash TEXT,
    steps_json TEXT NOT NULL DEFAULT '[]',
    error TEXT
);`,

  // --- base.py:_CREATE_USER_INDEX_SQL -------------------------------------
  `CREATE INDEX IF NOT EXISTS idx_host_user_snapshot_host
    ON host_user_snapshot(host_name);`,
];

export interface InitSchemaOptions {
  /** When true, do not execute any DDL or write `user_version`. */
  readonly?: boolean;
}

/**
 * Creates the full schema on `db`, idempotently.
 *
 * Mirrors `base.py::init_storage`'s DDL execution: all statements run inside a
 * single transaction so a failure leaves no partial schema, and every
 * statement uses `IF NOT EXISTS` so calling this twice is a no-op. After the
 * DDL commits, `PRAGMA user_version` is set to {@link SCHEMA_VERSION}.
 *
 * When `opts.readonly` is true the function performs no writes (including no
 * `PRAGMA user_version`), matching the read-only connection contract.
 */
export function initSchema(db: SqliteDatabase, opts: InitSchemaOptions = {}): void {
  if (opts.readonly === true) {
    return;
  }

  const apply = db.transaction(() => {
    for (const statement of CREATE_STATEMENTS) {
      db.exec(statement);
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });

  apply();
}
