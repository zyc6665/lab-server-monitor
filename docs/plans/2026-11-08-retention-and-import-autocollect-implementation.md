# v1.6 数据保留与导入后自动采集实施计划

## Goal

实现数据保留策略、每日汇总表和导入/新增主机后自动采集，并保持周报与现有界面兼容。

## Architecture

- 保留策略配置进入 `AppRuntimeConfig`，通过设置页“监控与存储”持久化到 SQLite `app_settings`。
- `storage.py` 负责每日汇总、窗口裁剪和统一清理入口。
- `MonitorService` 负责按主机采集、采集后裁剪、导入后自动采集任务与状态。
- `web/routes.py` 负责触发导入回调、暴露采集状态 API；前端轮询状态并刷新页面。

## Tech Stack

Python 3.11+, Flask + waitress, SQLite, 原生 JS；测试 pytest / node --test。

## Spec

`docs/plans/2026-11-08-retention-and-import-autocollect-design.md`

## Global Constraints

- 不修改 `host_metrics_history` 现有列，不破坏旧库。
- 周报在原始点被裁剪后仍必须可用。
- 所有新配置必须向后兼容；旧 `retention_days` 字段保留。
- 采集任务不得阻塞 HTTP 请求；同一主机重复导入应复用/跳过任务。
- 所有新 API 必须登录且遵守 CSRF；状态查询仅返回任务状态，不泄漏凭据。
- 所有中文文件/脚本保持 UTF-8；PowerShell 脚本保持 UTF-8 BOM。
- 每项功能先写失败测试再实现；全量测试必须通过。

## Review Focus

1. 裁剪 SQL 在每台主机上是否严格保留最新 N 点/批次，是否误删最新快照。
2. 每日汇总在跨本地日、重复写入、回填时是否准确；周报切换后数值是否与原逻辑等价。
3. 导入后自动采集只针对新增/更新主机，失败不会卡住后续；状态 API 不泄漏敏感信息。
4. 清理频率和启动时清理是否会造成阻塞或锁库。
5. 旧配置/旧数据库升级是否平滑。

## Task 1: 配置模型与设置页字段

**Files:** `servermanage/models.py`, `servermanage/config.py`, `servermanage/settings.py`, `servermanage/web/templates/settings.html`, `tests/test_config_extended.py`, `tests/test_settings.py`

1. 在 `AppRuntimeConfig` 增加：
   - `host_metrics_max_points: int = 100`
   - `disk_health_retention_days: int = 7`
   - `disk_health_max_batches: int = 100`
   - `host_daily_summary_retention_days: int = 90`
   - `alert_history_retention_days: int = 30`
   - `ssh_audit_retention_days: int = 30`
2. `config.py` 解析这些字段（缺省用默认值，旧 `retention_days` 保留）。
3. `SettingsService.public_settings()["monitoring"]` 输出新字段。
4. `SettingsService._apply_section("monitoring")` 后校验范围：points 10–10000、disk days 1–365、batches 1–1000、summary days 7–3650、alert/audit days 1–3650；非法值抛 `SettingsError`。
5. `settings.html` 的“监控与存储”把“历史保留天数”替换为新的六项输入。
6. 测试：默认值、YAML 解析、public_settings、保存合法值、越界/非数字返回错误、旧配置无新字段仍可加载。

## Task 2: 每日汇总表与写入累加

**Files:** `servermanage/storage.py`, `servermanage/app.py`, `tests/test_daily_summary.py`

1. 新增 `host_daily_summary` 建表 SQL 与索引（主键 `day,host_name`）。
2. `persist_host_reports(..., tz: tzinfo = timezone.utc)`：每成功主机行同时 upsert 当天汇总：
   - `sample_count += 1`、`success_count += 1`；
   - 各指标 `*_sum += value`、`*_max = max(...)`、`cpu_min = min(...)`（仅 CPU 需要 min，按设计）。
   - 日期按 `collected_at.astimezone(tz).date().isoformat()`。
3. 新增 `backfill_daily_summary(db_path, tz) -> int`：从 `host_metrics_history` 按本地日分组，仅填充 `host_daily_summary` 不存在的日期；幂等。
4. `MonitorService` 启动时调用 `backfill_daily_summary`（用当前 `self._tz`），并记录日志。
5. 测试：两次写入累加、最大值/最小值、跨本地日、重启回填不重复、空库。

## Task 3: 周报改读每日汇总

**Files:** `servermanage/storage.py`, `tests/test_storage.py`, `tests/test_weekly.py`

1. `fetch_daily_points_for_week()`：优先从 `host_daily_summary` 读取 `day BETWEEN week_start/end`，用 `sum/count` 计算日平均；没有汇总行时回退原 `host_metrics_history` 聚合。
2. `fetch_weekly_metrics()`：优先从 `host_daily_summary` 计算每周各指标平均、max/min、sample_count；无汇总行回退旧逻辑。
3. 确保时区行为与旧实现一致（本地日边界）。
4. 测试：同一数据在旧原始表和新汇总表下结果一致；无 summary 时回退；裁剪原始点后周报仍正常。

## Task 4: 保留裁剪函数

**Files:** `servermanage/storage.py`, `tests/test_retention.py`

1. `prune_host_metrics(db_path, max_points_per_host=100) -> int`：按 `host_name` 分区、`collected_at DESC, id DESC` 排序，删除第 N+1 之后的行。
2. `prune_disk_health(db_path, retention_days=7, max_batches_per_host=100) -> dict`：
   - 以 `disk_health_snapshot` 的 `(host_name,collected_at)` 为批次；
   - 保留每台最新 100 个批次且 `collected_at >= cutoff`；
   - 删除头表超限/超期行，再删除三张明细表中不存在头行的孤儿行。
3. `prune_alert_history(db_path, retention_days=30) -> int`：只删 `status='resolved'` 且 `created_at < cutoff`。
4. `prune_ssh_audit(db_path, retention_days=30) -> int`：只删 `ended_at IS NOT NULL` 且 `started_at < cutoff`。
5. `prune_retention(db_path, config: AppRuntimeConfig, *, now=None) -> dict`：调用上述四项，返回每项计数。
6. 测试：100/101 点、7 天/100 批次、孤儿清理、active/acknowledged 不删、审计 active 不删、空库。

## Task 5: MonitorService 按主机采集与自动裁剪

**Files:** `servermanage/app.py`, `tests/test_app_service.py`

1. `run_status_once(host_names: set[str] | None = None)`：当 `host_names` 非空时只采集这些主机（构造过滤 servers 的临时 AppConfig），其余逻辑不变。
2. `run_disk_once(host_names: set[str] | None = None)`：同样按主机过滤。
3. 成功持久化后：
   - status 调用 `prune_host_metrics(self.db_path, self.config.app.host_metrics_max_points)`；
   - disk 调用 `prune_disk_health(...)`。
4. `start()` 前调用一次 `prune_retention`（启动收缩旧库）。
5. `_build_tasks()` 新增 `ScheduledTask("retention_cleanup", 3600, self.run_retention_cleanup)`；`run_retention_cleanup()` 调用 `prune_alert_history` / `prune_ssh_audit` / `prune_alert_silences`（如存在）/`prune_daily_summary`。
6. 测试：筛选主机、自动裁剪调用、启动清理调用、清理任务注册。

## Task 6: 导入/新增后自动采集与状态 API

**Files:** `servermanage/app.py`, `servermanage/web/__init__.py`, `servermanage/web/routes.py`, `tests/test_settings_api.py`, `tests/test_app_service.py`

1. `MonitorService` 增加：
   - `_collection_states: dict[str, dict]`（线程安全 lock）；
   - `schedule_host_collection(names, *, include_disk=True)`：后台 daemon 线程执行 `run_status_once(names)` + `run_disk_once(names)`，更新状态 `pending/running/done/error`、时间戳、错误；
   - `collection_status(names)`：返回 dict，仅内存。
2. `create_app(..., on_hosts_imported=None, collection_status_provider=None)`；存到 `app.config`。
3. 主机新增/导入/向导保存成功后，收集 `created+updated` 主机名并调用 `on_hosts_imported`；若回调不存在则不报错。
4. 新增 `GET /api/settings/hosts/collection-status?names=a,b`：
   - 需登录；names 可选，缺省返回全部记录；未知主机返回 `{"state":"unknown"}`。
5. `app.main()` 传 `on_hosts_imported=service.schedule_host_collection`、`collection_status_provider=service.collection_status`。
6. 测试：导入后回调被调用一次且 names 正确；后台任务成功/失败状态；API 未登录 401、返回结构正确；不泄漏秘密。

## Task 7: 前端采集进度与设置字段

**Files:** `servermanage/web/templates/settings.html`, `servermanage/web/static/settings.js`, `servermanage/web/static/settings-ssh-config.js`, `servermanage/web/static/settings-wizard.js`, `tests/test_settings_page.py`

1. 设置页“监控与存储”新增六项保留参数输入（Task 1）。
2. 增加 `#host-collection-status` 状态栏。
3. 导入/保存/向导成功后：不立即 reload，调用 `watchHostCollection(names)`：
   - 每 1 秒 `GET /api/settings/hosts/collection-status?names=...`；
   - 显示“采集中 x/y / 已完成 / 失败”；
   - 全部 done 或 60 秒超时后 `window.location.reload()`（回到主机页或原分区）。
4. 保证 `settings.js` 和 `settings-ssh-config.js` 都使用同一 helper；CSRF/401 逻辑沿用。
5. 测试：页面含状态容器与新字段、导入成功调用状态查询、完成后 reload、失败提示。

## Task 8: 文档、版本与打包

**Files:** `pyproject.toml`, `desktop/package.json`, `servermanage/__init__.py`, `README.md`, `使用说明.txt`, `tools/bump_version.py`, `packaging/build-backend.ps1`, `desktop/scripts/build-portable.ps1`, tests

1. 版本升到 1.6.0（所有位置 + 测试断言）。
2. README/使用说明增加“数据保留与导入自动采集”说明，明确旧 `retention_days` 兼容、每日汇总、磁盘 7 天/100 批次、告警/审计 30 天。
3. 构建 backend 与 portable zip `服务器轮询监测工具-Windows-x64-v1.6.0.zip`。
4. 验证 zip、/settings 新字段、导入后采集状态、/api/overview 数据出现；准备自动更新测试（v1.5.2→v1.6.0）。

## Task 9: 端到端集成与发布前验证

**Files:** `tests/test_integration_smoke.py`, new `tests/test_v16_retention_integration.py`

1. 用临时 SQLite + FakeRunner：导入 1 台主机 → 触发采集 → 状态/磁盘各一条；再模拟 105 次状态写入，确认 `host_metrics_history` 每台 100 行、`host_daily_summary` 汇总为 105 样本；磁盘 8 批确认 7 天保留。
2. 周报：写入 7 天 summary，确认 `generate_weekly_report` 正常。
3. 全量 pytest、node --test 通过。
4. 发布 v1.6.0 GitHub Release，并做 v1.5.2→v1.6.0 `apply-update.ps1` + SHA 校验实测（保留 config/data/logs）。

## Final Verification

- `python -m pytest -q` 0 failed。
- `node --test desktop/test/*.test.js` 全通过。
- `python -m compileall servermanage`。
- 打包后 `/settings` 显示新字段；导入主机后后台采集并刷新；超过 100 点后旧点消失；磁盘超过 7 天/100 批次旧批消失；周报仍可生成。
- 按发布流程推送 `zyc6665/lab-server-monitor`，生成 Release zip + sha，并验证自动更新。
