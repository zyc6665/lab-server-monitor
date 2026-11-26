import { describe, it, expect, afterEach } from 'vitest';

import { openDatabase } from '../src/storage/db';
import {
  CREATE_STATEMENTS,
  SCHEMA_VERSION,
  initSchema,
} from '../src/storage/schema';

type SqliteDb = ReturnType<typeof openDatabase>;

let open: SqliteDb[] = [];

function freshDb(): SqliteDb {
  const db = openDatabase(':memory:');
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open) {
    if (db.open) {
      db.close();
    }
  }
  open = [];
});

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** Build expected `PRAGMA table_info` rows from compact tuples. */
function columns(
  spec: Array<[string, string, 0 | 1, string | null, number]>,
): ColumnInfo[] {
  return spec.map(([name, type, notnull, dflt_value, pk], cid) => ({
    cid,
    name,
    type,
    notnull,
    dflt_value,
    pk,
  }));
}

function tableInfo(db: SqliteDb, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

/**
 * The exact set of user tables created by the DDL (sqlite_sequence excluded).
 *
 * The 20 base tables mirror `base.py`; `alert_delivery_failures`,
 * `task_runs` and `report_runs` are Node-only additions (not part of the
 * frozen Python oracle), so read-diff comparisons stay on the oracle subset.
 */
const EXPECTED_TABLES = [
  'alert_delivery_failures',
  'alert_silences',
  'alerts',
  'app_secrets',
  'app_settings',
  'audit_log',
  'config_history',
  'disk_controller_snapshot',
  'disk_health_snapshot',
  'disk_pd_snapshot',
  'disk_vd_snapshot',
  'host_check_history',
  'host_check_snapshot',
  'host_daily_summary',
  'host_latest_snapshot',
  'host_metrics_history',
  'host_user_baseline',
  'host_user_scan_state',
  'host_user_snapshot',
  'host_user_usage_history',
  'report_runs',
  'ssh_audit_sessions',
  'storage_samples',
  'task_runs',
  'task_state',
  'user_operations',
];

/** Every `CREATE INDEX IF NOT EXISTS` name (base.py + Node-only P1 tables). */
const EXPECTED_INDEXES = [
  'idx_alert_delivery_failures_alert',
  'idx_alert_delivery_failures_at',
  'idx_alert_silences_ends_at',
  'idx_alerts_created_at',
  'idx_alerts_fingerprint',
  'idx_alerts_host_status_category',
  'idx_audit_log_action',
  'idx_audit_log_at',
  'idx_config_history_at',
  'idx_disk_controller_snapshot_host_time',
  'idx_disk_pd_snapshot_host_time',
  'idx_disk_vd_snapshot_host_time',
  'idx_host_check_history_lookup',
  'idx_host_check_snapshot_host',
  'idx_host_daily_summary_day',
  'idx_host_metrics_history_collected_at',
  'idx_host_metrics_history_host',
  'idx_host_metrics_history_host_collected',
  'idx_host_user_snapshot_host',
  'idx_report_runs_created',
  'idx_ssh_audit_started_at',
  'idx_task_runs_started',
  'idx_task_runs_task_started',
  'idx_user_usage_history',
];

describe('schema DDL constants', () => {
  it('contains 26 CREATE TABLE and 24 CREATE INDEX statements (50 total)', () => {
    const tables = CREATE_STATEMENTS.filter((sql) =>
      /^CREATE TABLE IF NOT EXISTS/i.test(sql.trim()),
    );
    const indexes = CREATE_STATEMENTS.filter((sql) =>
      /^CREATE INDEX IF NOT EXISTS/i.test(sql.trim()),
    );
    expect(CREATE_STATEMENTS).toHaveLength(50);
    expect(tables).toHaveLength(26);
    expect(indexes).toHaveLength(24);
  });
});

describe('initSchema on a fresh database', () => {
  it('creates exactly the 26 expected tables', () => {
    const db = freshDb();
    initSchema(db);
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual(EXPECTED_TABLES);
  });

  it('creates every expected index', () => {
    const db = freshDb();
    initSchema(db);
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual(EXPECTED_INDEXES);
  });

  it('sets PRAGMA user_version to SCHEMA_VERSION', () => {
    const db = freshDb();
    initSchema(db);
    expect(SCHEMA_VERSION).toBe(1);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });
});

describe('initSchema column definitions match the Python DDL', () => {
  it('host_metrics_history has the exact columns/types/defaults', () => {
    const db = freshDb();
    initSchema(db);
    expect(tableInfo(db, 'host_metrics_history')).toEqual(
      columns([
        ['id', 'INTEGER', 0, null, 1],
        ['collected_at', 'TEXT', 1, null, 0],
        ['host_name', 'TEXT', 1, null, 0],
        ['host', 'TEXT', 1, null, 0],
        ['success', 'INTEGER', 1, '0', 0],
        ['cpu_usage_percent', 'REAL', 0, null, 0],
        ['memory_used_mb', 'INTEGER', 0, null, 0],
        ['memory_total_mb', 'INTEGER', 0, null, 0],
        ['disk_used_percent', 'REAL', 0, null, 0],
        ['gpu_utilization_percent', 'REAL', 0, null, 0],
        ['gpu_memory_used_mb', 'INTEGER', 0, null, 0],
        ['gpu_memory_total_mb', 'INTEGER', 0, null, 0],
        ['total_processes', 'INTEGER', 0, null, 0],
        ['logged_in_user_count', 'INTEGER', 0, null, 0],
        ['load_1', 'REAL', 0, null, 0],
        ['load_5', 'REAL', 0, null, 0],
        ['load_15', 'REAL', 0, null, 0],
        ['net_rx_bytes', 'INTEGER', 0, null, 0],
        ['net_tx_bytes', 'INTEGER', 0, null, 0],
        ['temperature_c', 'REAL', 0, null, 0],
      ]),
    );
  });

  it('alerts keeps nullable columns and the quoted default for status', () => {
    const db = freshDb();
    initSchema(db);
    expect(tableInfo(db, 'alerts')).toEqual(
      columns([
        ['id', 'INTEGER', 0, null, 1],
        ['created_at', 'TEXT', 1, null, 0],
        ['host_name', 'TEXT', 0, null, 0],
        ['category', 'TEXT', 0, null, 0],
        ['severity', 'TEXT', 0, null, 0],
        ['title', 'TEXT', 0, null, 0],
        ['message', 'TEXT', 0, null, 0],
        ['fingerprint', 'TEXT', 0, null, 0],
        ['status', 'TEXT', 0, "'active'", 0],
        ['notified_channels', 'TEXT', 0, null, 0],
        ['ack_at', 'TEXT', 0, null, 0],
      ]),
    );
  });

  it('host_daily_summary has the 3-column composite primary key with tz', () => {
    const db = freshDb();
    initSchema(db);
    expect(tableInfo(db, 'host_daily_summary')).toEqual(
      columns([
        ['day', 'TEXT', 1, null, 1],
        ['host_name', 'TEXT', 1, null, 2],
        ['tz', 'TEXT', 1, "'UTC'", 3],
        ['host', 'TEXT', 1, null, 0],
        ['sample_count', 'INTEGER', 1, '0', 0],
        ['success_count', 'INTEGER', 1, '0', 0],
        ['cpu_sum', 'REAL', 0, null, 0],
        ['cpu_max', 'REAL', 0, null, 0],
        ['cpu_min', 'REAL', 0, null, 0],
        ['memory_pct_sum', 'REAL', 0, null, 0],
        ['memory_pct_max', 'REAL', 0, null, 0],
        ['disk_pct_sum', 'REAL', 0, null, 0],
        ['disk_pct_max', 'REAL', 0, null, 0],
        ['gpu_util_sum', 'REAL', 0, null, 0],
        ['gpu_util_max', 'REAL', 0, null, 0],
        ['gpu_memory_pct_sum', 'REAL', 0, null, 0],
        ['gpu_memory_pct_max', 'REAL', 0, null, 0],
        ['load_sum', 'REAL', 0, null, 0],
        ['users_sum', 'REAL', 0, null, 0],
        ['processes_sum', 'REAL', 0, null, 0],
        ['updated_at', 'TEXT', 1, null, 0],
      ]),
    );
  });

  it('host_user_snapshot keeps every flag default and the composite PK', () => {
    const db = freshDb();
    initSchema(db);
    expect(tableInfo(db, 'host_user_snapshot')).toEqual(
      columns([
        ['host_name', 'TEXT', 1, null, 1],
        ['username', 'TEXT', 1, null, 2],
        ['uid', 'INTEGER', 1, null, 0],
        ['gid', 'INTEGER', 1, null, 0],
        ['primary_group', 'TEXT', 0, null, 0],
        ['gecos', 'TEXT', 0, null, 0],
        ['home', 'TEXT', 0, null, 0],
        ['shell', 'TEXT', 0, null, 0],
        ['groups_json', 'TEXT', 1, "'[]'", 0],
        ['in_docker', 'INTEGER', 1, '0', 0],
        ['in_sudo', 'INTEGER', 1, '0', 0],
        ['home_exists', 'INTEGER', 1, '0', 0],
        ['home_owner', 'TEXT', 0, null, 0],
        ['home_group', 'TEXT', 0, null, 0],
        ['home_mode', 'TEXT', 0, null, 0],
        ['home_size_bytes', 'INTEGER', 0, null, 0],
        ['data_exists', 'INTEGER', 1, '0', 0],
        ['data_owner', 'TEXT', 0, null, 0],
        ['data_group', 'TEXT', 0, null, 0],
        ['data_mode', 'TEXT', 0, null, 0],
        ['data_size_bytes', 'INTEGER', 0, null, 0],
        ['data_supported', 'INTEGER', 1, '1', 0],
        ['usage_stale', 'INTEGER', 1, '0', 0],
        ['usage_readable', 'INTEGER', 1, '1', 0],
        ['usage_collected_at', 'TEXT', 0, null, 0],
        ['collected_at', 'TEXT', 1, null, 0],
      ]),
    );
  });
});

describe('initSchema idempotency', () => {
  it('is safe to call twice and leaves the table set unchanged', () => {
    const db = freshDb();
    initSchema(db);
    const first = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all();
    expect(() => initSchema(db)).not.toThrow();
    const second = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all();
    expect(second).toEqual(first);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });
});

describe('initSchema readonly mode', () => {
  it('performs no writes when readonly is set', () => {
    const db = freshDb();
    initSchema(db, { readonly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all();
    expect(tables).toEqual([]);
    expect(db.pragma('user_version', { simple: true })).toBe(0);
  });
});
