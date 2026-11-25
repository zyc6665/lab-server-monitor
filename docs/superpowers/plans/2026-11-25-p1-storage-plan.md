# P1 存储层迁移 · 实施计划（better-sqlite3 复刻 Python `servermanage/storage/*`）

**Goal（本阶段）:** 在 `backend/src/storage/*` 用 `better-sqlite3` 1:1 复刻现有 Python 存储层（20 张表 + 隐式 sqlite_sequence / 幂等 DDL / 老库迁移 / 仓库 API / 备份校验 / 时间与密钥格式），保证**同一个 SQLite 文件**在 Node 侧读写与 Python 侧逐字节兼容，并提供 Python↔Node 差分对照作为门禁。

**Architecture:** 单进程同步访问；每次操作独立打开的语义由「一个进程级 `Database` 句柄 + WAL + busy_timeout」等价实现（不再需要连接池）。写多行/多表处用 `db.transaction(fn).immediate()` 复刻 `BEGIN IMMEDIATE`。所有时间经 `nowIsoUtc()`。

**Tech Stack:** TypeScript · better-sqlite3（`@types/better-sqlite3`）· vitest · win-dpapi（P1 后段）

**Spec:** `docs/superpowers/specs/2026-11-25-single-stack-desktop-rewrite-design.md` §6.1 / §7 / §9.1

**参考实现（oracle，勿改）:** `servermanage/storage/base.py`（DDL 在 39–370 行、迁移 `_ensure_host_metrics_columns:440` / `_ensure_user_snapshot_columns:455` / `_migrate_host_daily_summary:568`）、`metrics.py`、`hosts.py`、`alerts.py`、`disk.py`、`runtime.py`、`users.py`、`__init__.py`。

## Global Constraints（逐条照做）

- **表/列/PK/索引名不得改动**；默认库路径 `data/servermonitor.db` 不变。
- 时间：`nowIsoUtc()` → `YYYY-MM-DDTHH:MM:SS.ffffff+00:00`（UTC，6 位微秒，`+00:00` 结尾）；`day` 键为本地日期 `YYYY-MM-DD`。**禁止** `Date.toISOString()`（毫秒位/`Z` 不符）。
- JSON 列 utf-8；布尔存 `0/1`。
- 连接：`busy_timeout=10000`、`synchronous=NORMAL`、新库 `journal_mode=WAL`、新库 `auto_vacuum=INCREMENTAL`；无 `foreign_keys`、无 FK。
- 写事务：`persist_host_reports`/`save_host_check_results`/`append_host_check_history`/`insert_alert`/`save_host_user_scan_result`/`save_host_user_snapshot`/`save_user_scan_state`/`upsert_user_baseline` 用 `BEGIN IMMEDIATE`。
- 魔法数：check-history `keep=60`、delete `chunk=500`、`host_metrics_max_points=100`、`disk_health_retention_days=7`/`max_batches=100`、`host_daily_summary_retention_days=90`、`alert_history_retention_days=30`、`ssh_audit_retention_days=30`、user usage `retain_days=180`/`min_interval_hours=12`。
- **迁移安全网**：任何改 schema 的启动迁移（含 `host_daily_summary` 重建）前，先把库原子复制到 `backups/pre-migrate-<version>-<ts>.db`；迁移包在事务里，任一步失败回滚并**中止启动**。
- **门禁**：新增 Node 测试通过 + 差分对照通过 + 迁移期 Python 基线仍绿（`pytest` 1892 passed / 1 skipped）+ 分支内提交。不得修改 Python `servermanage/storage/*` 或既有 Python 测试。

## 任务总览

| # | 任务 | 主要文件 |
|---|---|---|
| 1 | 存储脚手架：better-sqlite3 依赖、`nowIsoUtc()`、`openDatabase()` | `backend/src/storage/{time,db}.ts` |
| 2 | 全量 DDL `schema.ts` + `initSchema()` 幂等；新鲜库断言 | `backend/src/storage/schema.ts` |
| 3 | 老库迁移 + 迁移前备份 + 事务回滚 | `backend/src/storage/migrate.ts` |
| 4 | settings / secrets / task_state（+ DPAPI 封装） | `backend/src/storage/{settings,secrets,dpapi,tasks}.ts` |
| 5 | hosts：快照 / 检查结果 / 网络速率（含 `persist_host_reports`） | `backend/src/storage/hosts.ts` |
| 6 | metrics 读：history/sparkline/uptime/overview/weekly/daily | `backend/src/storage/metrics-read.ts` |
| 7 | metrics 写/汇总/裁剪：append_check_history/_merge_daily_summary/backfill/prune | `backend/src/storage/metrics-write.ts` |
| 8 | alerts 存储（含 BEGIN IMMEDIATE、silence） | `backend/src/storage/alerts.ts` |
| 9 | disk health 存储 | `backend/src/storage/disk.ts` |
| 10 | users 存储（snapshot/baseline/scan_state/usage/operations） | `backend/src/storage/users.ts` |
| 11 | runtime：backup/restore/integrity/validate/system_stats/prune/ssh audit | `backend/src/storage/runtime.ts` |
| 12 | Python↔Node 差分对照 harness（§9.1 规范化） | `backend/test/diff/*` |
| 13 | 老库 fixture + 真实库副本兼容测试 | `backend/test/legacy/*`、`backend/test/fixtures/*` |
| 14 | P1 验收文档 + 门禁（Node 全绿 + Python 基线绿 + 提交） | `docs/superpowers/plans/p1-acceptance.md` |

---

## Task 1: 存储脚手架（依赖 / 时间 / 连接）

**Files:** `backend/src/storage/time.ts`、`backend/src/storage/db.ts`、`backend/test/time.test.ts`、`backend/test/db.test.ts`；`backend/package.json` 增加依赖。

- [ ] Step 1（失败测试）：`nowIsoUtc()` 断言匹配 `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/`，且与 Python `datetime.now(timezone.utc).isoformat()` 同形；`nowIsoUtc(new Date('2026-01-02T03:04:05.123Z'))` == `2026-01-02T03:04:05.123000+00:00`。
- [ ] Step 2：`openDatabase(path,{readonly?})` 设置 `busy_timeout=10000`、`synchronous=NORMAL`，新库（文件不存在）设 `journal_mode=WAL`、`auto_vacuum=INCREMENTAL`；返回可关闭句柄；`db.test.ts` 断言 pragma 生效、可创建临时库、关闭后无 `-wal` 占用。
- [ ] Step 3：`pnpm add better-sqlite3 && pnpm add -D @types/better-sqlite3`；`tsc --noEmit` 0。
- [ ] Step 4：`pnpm test` 通过；提交 `feat(p1): storage scaffolding (better-sqlite3, nowIsoUtc, openDatabase)`。

**Acceptance:** 时间格式严格 6 位微秒 `+00:00`；pragma 断言通过；无回归。

## Task 2: 全量 DDL + 幂等初始化

**Files:** `backend/src/storage/schema.ts`、`backend/test/schema.test.ts`。

- [ ] Step 1：把 `base.py:39-370` 的 20 张表 DDL 逐字移植为 `SCHEMA_SQL`（字段名/类型/PK/`NOT NULL`/`DEFAULT`/索引名一致）。
- [ ] Step 2（失败测试）：全新库 `initSchema(db)` 后断言 `sqlite_master` 含全部 20 张用户表（+ sqlite_sequence）+ 期望索引；重复调用幂等（`IF NOT EXISTS`）。
- [ ] Step 3：对每表做 `PRAGMA table_info` 快照测试（列名+顺序+类型）。
- [ ] Step 4：提交 `feat(p1): full 20-table DDL + idempotent initSchema`。

**Acceptance:** 20 张用户表齐全、列定义与 Python 一致、重复 init 无副作用。

## Task 3: 老库迁移 + 安全网

**Files:** `backend/src/storage/migrate.ts`、`backend/test/migrate.test.ts`、`backend/test/fixtures/legacy/*.db`。

- [ ] Step 1：移植 `_ensure_host_metrics_columns`（+net_rx_bytes/net_tx_bytes/temperature_c）、`_ensure_user_snapshot_columns`（+usage_readable DEFAULT 1）、`_migrate_host_daily_summary`（缺 tz→建新表+INSERT SELECT+改 PK 为 day,host_name,tz）。
- [ ] Step 2：`runMigrations(db,{backupDir,appVersion})`：若检测到需改 schema，先原子复制 `<db>` → `backups/pre-migrate-<ver>-<ts>.db`，再在事务内迁移；异常回滚 + 抛出（调用方中止启动）。
- [ ] Step 3（失败测试）：用 legacy fixture（12 表、缺 3 列、`journal_mode=delete`）open→migrate→断言列已加、`journal_mode` 变 WAL、数据行数不变；构造迁移中途抛错用例断言回滚且原库不变、备份文件存在。
- [ ] Step 4：提交 `feat(p1): legacy DB migrations + pre-migrate backup + rollback`。

**Acceptance:** legacy 库打开即幂等迁移且不丢数据；失败回滚不产生半迁移库。

## Task 4: settings / secrets / task_state（+ DPAPI）

**Files:** `backend/src/storage/settings.ts`、`secrets.ts`、`dpapi.ts`、`tasks.ts`、对应测试。

- [ ] Step 1：`loadAppSettings(db): Record<section,Record<string,unknown>>`、`saveAppSettings(section,payload)`、`deleteAppSettings(section)`；`_settings_now` 用 `nowIsoUtc`。
- [ ] Step 2：`getSecret/setSecret(ciphertext:Buffer)/listSecretNames/deleteSecret`（`app_secrets` 存 BLOB）。
- [ ] Step 3：`getTaskState/setTaskState/listTaskStates`（`last_run_at`/`last_result` 语义照 `base.py:788/1147`）。
- [ ] Step 4：`dpapi.ts` 用 `win-dpapi`：`protect(plain):Buffer`、`unprotect(blob):Buffer`，默认 flags（当前用户，无 entropy）；用真实旧 blob fixture 断言能解出明文（若本机不可用则 skip 并记录）。
- [ ] Step 5：测试 + 提交 `feat(p1): settings, secrets (DPAPI), task_state storage`。

**Acceptance:** settings/secrets/task_state 读写与 Python 行格式一致；旧 DPAPI blob 可解。

## Task 5: hosts 快照与检查结果

**Files:** `backend/src/storage/hosts.ts`、`backend/test/hosts.test.ts`。

- [ ] Step 1：`saveHostSnapshot(report)`、`persistHostReports(reports)`（`BEGIN IMMEDIATE`，替换快照行 `_replace_snapshot_rows`）、`getHostSnapshot`、`getAllHostSnapshots`。
- [ ] Step 2：`saveHostCheckResults`/`getHostCheckResults`/`getAllHostCheckResults`/`deleteHostCheckResults`（`BEGIN IMMEDIATE`）。
- [ ] Step 3：`fetchHostNetworkRates`/`fetchAllHostNetworkRates`（`_network_rate_pair` 语义）。
- [ ] Step 4：测试（构造 HostReport → 写 → 读断言关键字段/JSON 列/0-1 布尔）+ 提交 `feat(p1): hosts snapshots & check results storage`。

**Acceptance:** 快照/检查结果读写与 Python 一致；写路径为 IMMEDIATE 事务。

## Task 6: metrics 读 API

**Files:** `backend/src/storage/metrics-read.ts`、`backend/test/metrics-read.test.ts`。

- [ ] Step 1：`fetchHostHistory`、`fetchHostSparklines`、`fetchHostUptimeStrip`、`fetchAllHostUptimeStrips`（`_empty_uptime_strip`/bucket 语义）。
- [ ] Step 2：`fetchOverviewHistory`、`fetchWeeklyMetrics`、`fetchDailyPointsForWeek`、`countRecentSamples(ByHost)`。
- [ ] Step 3：测试：造样本 → 断言点序列/聚合（`AVG/CASE/ROW_NUMBER` 结果）、按显式键排序。
- [ ] Step 4：提交 `feat(p1): metrics read queries`。

**Acceptance:** 查询结果与 Python 同输入同输出（§9.1 规范化）。

## Task 7: metrics 写/汇总/裁剪

**Files:** `backend/src/storage/metrics-write.ts`、`backend/test/metrics-write.test.ts`。

- [ ] Step 1：`appendHostCheckHistory`（keep=60，`BEGIN IMMEDIATE`）、`mergeDailySummary`（`ON CONFLICT DO UPDATE`）、`backfillDailySummary`。
- [ ] Step 2：`pruneHostMetrics(maxPoints=100)`（每 host `LIMIT 1 OFFSET n` 取阈值 + `_delete_rows_in_chunks(chunk=500)`）、`pruneDailySummary`、`getHostCheckHistory`/`getAllHostCheckHistory`。
- [ ] Step 3：测试：写入超 60 裁剪、daily_summary upsert 合并、prune 保留最新 100。
- [ ] Step 4：提交 `feat(p1): metrics write/summary/prune`。

**Acceptance:** 裁剪/汇总结果与 Python 一致；分块删除生效。

## Task 8: alerts 存储

**Files:** `backend/src/storage/alerts.ts`、`backend/test/alerts-storage.test.ts`。

- [ ] Step 1：`insertAlert`（`BEGIN IMMEDIATE`）、`updateAlert`、`findLatestAlert`、`closeAlertsForHost`。
- [ ] Step 2：`listAlerts`/`listAlertsForHost`/`listOpenAlertsForHost`/`listRecentAlertsGrouped`/`fetchAlertHistory`。
- [ ] Step 3：counts（active by host / active critical / by status）、silences（insert/list/delete/prune）、`pruneAlertHistory`。
- [ ] Step 4：测试 + 提交 `feat(p1): alerts & silences storage`。

**Acceptance:** 告警行/分组/计数/silence 与 Python 一致；insert 为 IMMEDIATE。

## Task 9: disk health 存储

**Files:** `backend/src/storage/disk.ts`、`backend/test/disk-storage.test.ts`。

- [ ] Step 1：`saveDiskHealth(report)`、`getDiskHealth(host)`、`getAllDiskHealth`、`pruneDiskHealth(retentionDays=7,maxBatches=100)`。
- [ ] Step 2：测试（构造 DiskHealthReport → 写读断言 + 裁剪）+ 提交 `feat(p1): disk health storage`。

**Acceptance:** 磁盘健康快照读写/裁剪与 Python 一致。

## Task 10: users 存储

**Files:** `backend/src/storage/users.ts`、`backend/test/users-storage.test.ts`。

- [ ] Step 1：`saveHostUserSnapshot`/`getHostUserSnapshot`/`getAllHostUserSnapshots`（IMMEDIATE）。
- [ ] Step 2：`upsertUserBaseline`/`getUserBaseline`/`getAllUserBaselines`/`deleteUserBaseline`（IMMEDIATE）；`saveUserScanState`/`getUserScanState`/`getAllUserScanStates`（IMMEDIATE）。
- [ ] Step 3：`appendUserUsageHistory`（retain 180d/min 12h）、`getUserUsageDeltas`/`getAllUserUsageDeltas`/`getUserUsageSeries`、`saveUserOperation`/`listUserOperations`、`topUserGrowth`、`deleteHostUserData`。
- [ ] Step 4：测试 + 提交 `feat(p1): users storage`。

**Acceptance:** 用户快照/baseline/用量/操作与 Python 一致；写为 IMMEDIATE。

## Task 11: runtime（备份/恢复/完整性/统计/裁剪/SSH 审计）

**Files:** `backend/src/storage/runtime.ts`、`backend/test/runtime.test.ts`。

- [ ] Step 1：`backupDatabase(db,dest)`（`await db.backup(dest)`）、`restoreDatabase(src,dest)`（src 只读打开）。
- [ ] Step 2：`validateBackupDatabase(path)`（16 字节 `SQLite format 3\0` 头 + `PRAGMA integrity_check` + 必含 app_settings/app_secrets）；`databaseIntegrity(db,ttl)`（`PRAGMA quick_check` + TTL 缓存）。
- [ ] Step 3：`systemStats`、`pruneRetention`、`pruneSshAudit`（retention）、ssh 会话 record/end/list。
- [ ] Step 4：测试 + 提交 `feat(p1): runtime backup/restore/integrity/prune/ssh-audit`。

**Acceptance:** 备份可被 verify-bundle 认作合法；恢复可用；完整性检查带缓存。

## Task 12: Python↔Node 差分 harness

**Files:** `backend/test/diff/harness.ts`、`backend/test/diff/*.test.ts`、脚本 `backend/test/diff/run_python_oracle.py`（仅测试用，不改业务）。

- [ ] Step 1：harness：给定种子 DB + 一组查询，分别用 Python（subprocess 跑只读脚本输出 JSON）与 Node 执行，按 §9.1 规范化（时间解析回 UTC、浮点 `toFixed(6)`、显式排序键、掩码 pid/port）后比较。
- [ ] Step 2：覆盖 settings/secrets(非密)/hosts 快照/alerts 列表/metrics history/daily summary 的读路径。
- [ ] Step 3：测试断言 diff==[]；提交 `test(p1): python↔node differential harness`。

**Acceptance:** 代表性读路径 diff 为空。

## Task 13: 老库 fixture + 真实库副本兼容

**Files:** `backend/test/legacy/legacy-compat.test.ts`、`backend/test/fixtures/legacy/servermonitor-legacy.db`。

- [ ] Step 1：生成并入库一个 legacy fixture（12 表、缺列、`journal_mode=delete`），大小受控（<200KB）。
- [ ] Step 2：测试 open→migrate→关键查询通过；对 `data/servermonitor.db` 的**只读副本**跑 open+queries（不写真实库）。
- [ ] Step 3：提交 `test(p1): legacy fixture + real-DB copy compatibility`。

**Acceptance:** 真实库副本可被 Node 打开并查询；legacy 迁移正确。

## Task 14: P1 验收 + 门禁

**Files:** `docs/superpowers/plans/p1-acceptance.md`。

- [ ] Step 1：跑 `backend` 全量 vitest + `tsc`；跑 Python `pytest`（须 1892 passed / 1 skipped）；跑差分 harness。
- [ ] Step 2：写验收文档（表：DDL 20/迁移/差分/备份/DPAPI/真实库副本 结果）。
- [ ] Step 3：提交 `test(p1): P1 acceptance`；P1 DoD：Node 存储层与 Python 同输入同输出、老库可迁移、备份校验通过、基线绿。

**Acceptance:** 上面全绿且工作树干净。

---

## P1 完成定义（DoD）

1. `backend/src/storage/*` 覆盖 20 表 DDL + 全部仓库 API（签名与 Python 对应函数一一映射）。
2. 老库（legacy fixture + 真实库副本）打开即幂等迁移、不丢数据；迁移失败回滚 + 中止启动。
3. `nowIsoUtc()` 严格 `...+00:00` 6 位微秒；JSON/布尔/密钥格式逐字节兼容；旧 DPAPI blob 可解。
4. 差分 harness 代表性读路径 diff=0；备份文件通过 `validateBackupDatabase`。
5. 新增 Node 测试全绿；Python 基线 1892 passed / 1 skipped 仍绿；分支内提交、工作树干净。

## 后续阶段入口

- **P2**：Express + Nunjucks 全部路由/页面/认证/设置（须复用 P1 仓库 API）。
- 之后 P3–P8 见路线图。
