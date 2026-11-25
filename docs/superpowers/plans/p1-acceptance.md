# P1 验收报告 — 存储层（Python → Node/TypeScript）

分支：`refactor/single-stack-b1`　·　Python oracle：`servermanage/storage/*`（未改动）　·　Node 实现：`backend/src/storage/*`

## 门禁结果

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| Node 类型检查 | `pnpm --filter servermonitor-backend typecheck` | ✅ 0 errors |
| Node 全量单测 | `pnpm --filter servermonitor-backend test` | ✅ 22 files / **233 passed, 1 skipped** |
| Python 基线（未改动） | `python -m pytest -q` | ✅ **1892 passed, 1 skipped**（124.47s） |
| Python 文件是否被改 | `git diff --name-only main..HEAD \| grep '^servermanage/'` | ✅ 空（零改动） |

> 1 个 skip 为 `dpapi.test.ts` 中的“DPAPI 不可用”分支（本机可用，故该 skip 是防御性用例）。

## 逐项验收

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 全量 DDL | ✅ | `backend/src/storage/schema.ts`：**20 张用户表 + 16 个索引**（另有 AUTOINCREMENT 隐式 `sqlite_sequence`）。`PRAGMA table_info` 与 `base.py` 的 `_CREATE_*_SQL` 逐列（cid/name/type/notnull/dflt/pk）比对一致；索引 SQL 字符串一致；`initSchema` 幂等。 |
| 老库迁移 + 安全网 | ✅ | `backend/src/storage/migrate.ts`：移植 `_ensure_host_metrics_columns`(+net_rx_bytes/net_tx_bytes/temperature_c)、`_ensure_user_snapshot_columns`(+usage_readable)、`_migrate_host_daily_summary`(缺 tz→重建 3 列 PK)；单事务，异常回滚且原库不变；`backupBeforeMigration` 生成 `<db>.<ts>.bak` 可校验副本。 |
| 迁移 fixture | ✅ | `backend/test/fixtures/legacy/servermonitor-legacy.db`（**92 KB**、12 表、`journal_mode=delete`、user_version 0、缺新列）；迁移后 → 20 表、WAL、user_version=SCHEMA_VERSION、数据行数/值保留、二次迁移 no-op。 |
| 真实库只读副本 | ✅ | `data/servermonitor.db` 复制到临时路径后打开+迁移：11 表 → 20 表、补齐 3 列、WAL、全部行数保留，快照/告警/设置/metrics 读取正常；**原库 SHA-256 与大小迁移前后不变**。 |
| Python↔Node 差分 | ✅ | `backend/test/diff/`：settings / secrets 名单（非密）/ hosts 快照 / alerts 列表 / metrics history（24h + 7d 两分支）/ daily summary **全部 diff == []**；harness 自检能捕捉人为注入的不一致。 |
| 备份/恢复/完整性 | ✅ | `backend/src/storage/runtime.ts`：`backupDatabase`/`restoreDatabase`/`validateBackupDatabase`（16 字节头 + integrity_check + 必含 app_settings/app_secrets）/`databaseIntegrity`（quick_check + TTL 缓存）。round-trip 测试通过。 |
| DPAPI 密钥兼容 | ✅ | `backend/src/storage/dpapi.ts` 用预编译 N-API 绑定 `@primno/dpapi`（CurrentUser、无 entropy），**免 MSVC 构建**。跨进程双向互解：Node 解 Python 写的密文（含空 blob）、Python 解 Node 写的密文。 |
| settings / task_state / JSON | ✅ | `settings.ts`/`secrets.ts`/`tasks.ts`/`json.ts`：`json.dumps(ensure_ascii=False)` 逐字节兼容（分隔符 `, `/`: `、非 ASCII 原样、NaN/Infinity、指数形式）；Python 读 Node 写回载荷字节一致。 |

## 交付模块（`backend/src/storage/`）

`time.ts` `db.ts` `schema.ts` `migrate.ts` `json.ts` `settings.ts` `secrets.ts` `dpapi.ts` `tasks.ts` `hosts.ts` `metrics-read.ts` `metrics-write.ts` `alerts.ts` `disk.ts` `users.ts` `runtime.ts`

## 与 Python 的有意差异（不影响同文件兼容）

1. 函数签名以**已打开的 `better-sqlite3` 句柄**为第一参数，而非 Python 的 `db_path`（仓库统一约定；启动方负责 `openDatabase` + `initSchema`/`migrateLegacy`）。
2. **20 张用户表**（不是 21）：`servermanage/storage/base.py` 实际定义 20 张 `CREATE TABLE`（第 21 个是 SQLite 内部 `sqlite_sequence`）。
3. `openDatabase` 对新库先设 `auto_vacuum=INCREMENTAL` 再设 `journal_mode=WAL`（SQLite 进 WAL 后 auto_vacuum 变更无效；Python 顺序相反、新库实际读到 0，后续 `maintain_database()` 才生效）——以“新库即为 INCREMENTAL”为目标，留 P7 兼容复核。
4. 时区以 IANA 字符串 + `Intl.DateTimeFormat` 实现（替代 Python `tzinfo`），含 DST 安全。
5. `migrateLegacy` 也先跑幂等基础 DDL（等价 `init_storage`），可一并补齐缺失整表。

## 结论

**P1 存储层 DoD 达成**：Node 存储层与 Python 同输入同输出（差分 diff 为空）、老库可幂等迁移不丢数据、备份可校验、基线全绿、Python 零改动。
