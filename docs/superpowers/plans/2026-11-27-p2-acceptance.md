# P2 模块优化验收记录（v0.3.1 / v0.3.2）

日期：2026-11-27
设计：`docs/superpowers/specs/2026-11-26-module-optimization-design.md` §7

## v0.3.1（M7 账号策略 + M5 报表中心）

- 账号策略：命名规范 `^[a-z][a-z0-9_-]{2,15}$`；模板 standard/developer/readonly；`expiry_days>0` 生成 `chage -E`；不合规 → `blocked` 中文原因。测试 `test/config/account-policy.test.ts`(6)、`test/users/account-policy.test.ts`(9)。
- 报表中心：`GET /api/reports/preview|history`、`POST /api/reports/send`、页面 `/reports`；`report_runs` 记录成功/失败；测试 `test/storage/report-runs.test.ts`(7)、`test/web/reports-routes.test.ts`(9)。
- 门禁：backend 120 files/2093 passed/1 skipped；desktop 132 passed；typecheck 0。发布 v0.3.1（run 45856075493 success）。

## v0.3.2（M8 设置中心 + M2 数据治理 + M11 桌面健壮性）

- 设置中心：搜索框（按卡片文本过滤）、字段级校验、保存 toast（既有+增强）、“最近变更”列表（`GET /api/settings/history`，只含键名）。新增 `config_history` 表 + 90 天清理；`saveSection` best-effort 记录差异键（`changedBy` 取会话用户名）。
- 数据治理：`monitoring.backup_schedule`（off/daily/weekly）、`backup_keep`（1–60，默认 7）；`backup` 任务写 `backups/auto-<date>.db` 并保留 N 份；`storage-sample` 每日采样写入 `storage_samples`（保留 180 天），`/api/system/storage` 返回 `db_size_history`（90 天）。保留天数沿用既有 `monitoring.*_retention*` 字段（不新增重复嵌套对象，理由见设计取舍）。
- 桌面健壮性（M11）：`crash-log.ts`（`crash-YYYYMMDD-HHmmss.log`，保留 20 个，`writeCrashLog` 永不抛出）；`startup-check.ts`（数据目录可写、端口探测、后端健康重试 3 次）；main.ts 捕获 `uncaughtException`/`unhandledRejection`/`render-process-gone`，托盘「打开最近崩溃日志」，启动自检失败 `dialog.showErrorBox` 附日志目录；updater 失败提示附日志路径（IPC 形状不变）。桌面测试 132 → 173。

### 测试与门禁

- backend：`pnpm --filter servermonitor-backend test` → **124 files / 2105 passed / 1 skipped**；typecheck 0。
- desktop：`pnpm run test:unit` → **173 passed**；typecheck 0；`build:main` 成功（dist/main.cjs 641,710B）。
- 差分：`/api/system/storage` 新增 Node-only `db_size_history`，已加入 `test/diff/http/read-allowlist.ts` 与 `http-diff` knownDifference（其余端点仍精确一致）。
- 新增测试：`test/storage/config-history.test.ts`(4)、`test/storage/storage-samples.test.ts`(3)、`test/web/settings-history.test.ts`(2)、`test/runtime/wiring-maintenance.test.ts`(3)。

### 已知取舍

- 启动自检不探测后端监听端口（后端以 `--port 0` 由系统分配，自行探测会误报占用）；端口探测逻辑由单元测试覆盖。
- `uncaughtException` 记录后不退出（常驻托盘）；`render-process-gone` 仅记录，不自动重建窗口。
- 磁盘健康趋势仅主机级 status（沿用保留期），未做 PD/VD 明细历史表（设计 §7 已定）。
