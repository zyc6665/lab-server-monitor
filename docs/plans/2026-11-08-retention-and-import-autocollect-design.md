# v1.6 数据保留与导入后自动采集设计

## 1. 目标

- 导入或新增主机成功后，立即对新增/更新的主机执行一次“状态 + 磁盘健康”采集，并在页面显示采集进度与完成状态。
- 控制 SQLite 体积：主机状态曲线每台只保留最近 100 个采样点；磁盘健康每台保留最近 7 天且最多 100 个批次；最新快照每台只保留一份。
- 保留周报能力：新增每日汇总表，长期保存按天聚合结果（默认 90 天），原始采样点被裁剪后周报仍可生成。
- 清理频率跟随采集频率：每次状态采集后裁剪状态历史，每次磁盘采集后裁剪磁盘历史；其它历史（告警、SSH 审计、静默）按小时级清理任务处理。
- 所有保留参数可在网页“监控与存储”设置中修改，保存后即时生效。

## 2. 已确认需求

用户原话（m10243）：“导入主机时，自动采集一次数据，还有你要看一下采集的数据是否保存在了本地，我们不能持续保存采集的数据，不然会撑满存储，我们要设置数据保存的时效，例如磁盘健康保留七天的数据，其他的只保留一天的，也要根据采集频率来，更加完善这个工具”。

后续确认：

- 状态曲线不是按固定天数，而是每台只保留最近 **100 个点**（m10278）。
- 用户同意推荐方案（m10285）：
  - 主机状态：最近 100 个点/台；
  - 磁盘健康：7 天、最多 100 个批次/台；
  - 每日汇总：90 天；
  - 告警记录：30 天（仅清理已恢复记录）；
  - SSH 登录审计：30 天（仅元数据）；
  - 最新状态、最新磁盘健康：每台一份，不参与清理。

## 3. 当前实现与问题

- `servermanage/storage.py::persist_host_reports()` 每次状态轮询 INSERT 一行 `host_metrics_history`；10 分钟一次约 144 行/台/天。
- `servermanage/storage.py::save_disk_health()` 每次磁盘轮询写入 `disk_health_snapshot` 头表 + `disk_controller_snapshot` / `disk_vd_snapshot` / `disk_pd_snapshot` 全量批次。
- `servermanage/app.py::run_purge()` 只使用一个 `AppRuntimeConfig.retention_days`（默认 90），每天清理一次全部表；没有分表策略。
- `servermanage/storage.py::fetch_daily_points_for_week()` / `fetch_weekly_metrics()` 直接读 `host_metrics_history` 做日聚合。原始状态只保留 100 点后，上周数据可能已被裁掉，周报会失真。
- 现有 `host_latest_snapshot` 已是每台 upsert 一行，不需要额外处理。

## 4. 保留策略

| 数据 | 保留规则 | 清理时机 |
|---|---|---|
| `host_metrics_history`（状态曲线） | 每台最近 100 个采样点（`host_metrics_max_points=100`） | 每次状态采集并写入后 |
| `disk_health_snapshot` + 三个磁盘明细表 | 每台最近 7 天，且最多最近 100 个批次（取二者交集） | 每次磁盘采集并写入后 |
| `host_latest_snapshot` | 每台 1 行，保留最新 | 不清理 |
| `host_daily_summary` | 每台每天 1 行，保留 90 天 | 每小时的清理任务 |
| `alerts` | 仅删除 `status='resolved'` 且超过 30 天的记录；`active`/`acknowledged` 永不按时间误删 | 每小时的清理任务 |
| `alert_silences` | `ends_at` 超过 30 天的记录 | 每小时的清理任务 |
| `ssh_audit_sessions` | `started_at` 超过 30 天且已结束的记录 | 每小时的清理任务 |

## 5. 每日汇总表

新增表：

```sql
CREATE TABLE IF NOT EXISTS host_daily_summary (
    day TEXT NOT NULL,              -- 本地时区日期 YYYY-MM-DD
    host_name TEXT NOT NULL,
    host TEXT NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    cpu_sum REAL, cpu_max REAL, cpu_min REAL,
    memory_pct_sum REAL, memory_pct_max REAL,
    disk_pct_sum REAL, disk_pct_max REAL,
    gpu_util_sum REAL, gpu_util_max REAL,
    gpu_memory_pct_sum REAL, gpu_memory_pct_max REAL,
    load_sum REAL,
    users_sum REAL,
    processes_sum REAL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (day, host_name)
);
```

- `persist_host_reports(..., tz=...)` 在同一事务内更新当天的汇总：`sample_count += 1`，各指标累加到 `*_sum`，并更新 max/min。
- 启动时 `backfill_daily_summary(db_path, tz)` 从现有 `host_metrics_history` 回填缺失日期的汇总（幂等 upsert；不覆盖已有汇总，只补充缺失日）。
- `fetch_daily_points_for_week()` 与 `fetch_weekly_metrics()` 优先读 `host_daily_summary`；若某周没有汇总行，回退到旧的 `host_metrics_history` 逻辑，保证兼容旧库和测试。

## 6. 导入/新增主机后自动采集

- `MonitorService.run_status_once(host_names: set[str] | None = None)` 与 `run_disk_once(host_names: set[str] | None = None)` 支持只采集指定主机。
- 新增 `MonitorService.schedule_host_collection(names, *, include_disk=True)`：
  - 在后台 daemon 线程中依次运行 `run_status_once(names)` 和（可选）`run_disk_once(names)`；
  - 内存维护 `collection_status`：`pending|running|done|error`、`started_at`、`finished_at`、`error`；
  - 同一批主机重复导入时合并/忽略重复任务。
- `create_app(..., on_hosts_imported: Callable[[list[str]], object] | None = None, collection_status_provider: Callable[[list[str]], dict] | None = None)`：
  - 所有主机新增/导入/向导保存成功后调用 `on_hosts_imported(names)`；
  - 新增 `GET /api/settings/hosts/collection-status?names=a,b` 返回每台状态。
- 前端：
  - 主机保存、连接向导保存、SSH 配置导入、批量导入成功后显示“正在采集 X 台主机…”；
  - 每 1 秒轮询 `/api/settings/hosts/collection-status`，全部 `done` 或超时 60 秒后自动刷新主机/概览页面；
  - 失败显示每台错误摘要；导入成功后立即关闭/刷新列表，不再出现“导入后没刷新”。

## 7. 清理实现

`servermanage/storage.py` 新增：

- `prune_host_metrics(db_path, max_points_per_host=100) -> int`：用窗口函数按 `host_name` 分区、`collected_at DESC, id DESC` 排序，删除排名 > max 的行。
- `prune_disk_health(db_path, retention_days=7, max_batches_per_host=100) -> dict`：先按每台最新 100 个批次和 7 天 cutoff 保留 `disk_health_snapshot` 头行，再删除三个明细表中没有对应头行的孤儿批次。
- `prune_alert_history(db_path, retention_days=30) -> int`：只删除 `resolved` 且超期。
- `prune_ssh_audit(db_path, retention_days=30) -> int`：只删除已结束且超期。
- `prune_retention(db_path, config: AppRuntimeConfig, *, now=None) -> dict`：统一入口，返回每张表删除数量。
- 旧 `purge_old_data(db_path, retention_days)` 保留为兼容包装，内部不再作为主流程。

触发：

- `run_status_once()` 成功持久化后调用 `prune_host_metrics`；
- `run_disk_once()` 成功持久化后调用 `prune_disk_health`；
- `_build_tasks()` 新增 `retention_cleanup`，间隔 `min(3600, max(60, poll_interval_seconds))` 或固定 3600 秒，负责告警/审计/静默/每日汇总清理；应用启动时先执行一次 `prune_retention`，确保升级后立即收缩旧库。

## 8. 配置与设置页

`AppRuntimeConfig` 新增字段（保留 `retention_days` 作为旧配置兼容默认值）：

```python
host_metrics_max_points: int = 100
disk_health_retention_days: int = 7
disk_health_max_batches: int = 100
host_daily_summary_retention_days: int = 90
alert_history_retention_days: int = 30
ssh_audit_retention_days: int = 30
```

设置页“监控与存储”分区把原来的“历史保留天数”替换为：

- 每台状态曲线保留点数（10–10000，默认 100）
- 磁盘健康保留天数（1–365，默认 7）
- 磁盘健康最多保留批次（1–1000，默认 100）
- 每日汇总保留天数（7–3650，默认 90）
- 告警历史保留天数（1–3650，默认 30）
- SSH 审计保留天数（1–3650，默认 30）

保存后 `SettingsService._apply_section("monitoring")` 解析并校验；非法值返回 400，不写入。

## 9. 非目标

- 不做数据库压缩/VACUUM 的自动调度（SQLite 删除行后文件不会立即缩小，但空间可复用；需要时可在未来加一次性维护按钮）。
- 不改变磁盘采集字段和 storcli 解析逻辑。
- 不改变告警判定阈值与通知通道。
- 不改动现有周报的展示模板，只改变数据来源。

## 10. 测试计划

- `tests/test_retention.py`：100 点裁剪、7 天/100 批次磁盘裁剪、告警/审计清理、边界值、空库。
- `tests/test_daily_summary.py`：写入状态后每日汇总累加、跨本地日边界、max/min、回填幂等、周报读汇总。
- `tests/test_app_service.py`：`run_status_once(host_names=...)` / `run_disk_once(host_names=...)` 只处理目标主机；导入后调度触发一次采集。
- `tests/test_settings_api.py`：导入/保存主机触发 `on_hosts_imported`；collection-status API 权限和状态。
- `tests/test_settings.py`：新保留字段解析、校验、public_settings、保存后生效。
- `tests/test_weekly.py` / `tests/test_storage.py`：周报从 summary 读取，旧原始数据回退路径不回归。
- 全量 Python + Node 测试通过；构建 backend + portable 包，实测导入主机后首条数据出现、100 点裁剪、磁盘 7 天、周报仍生成。

## 11. 默认决定（可调整）

- 清理任务固定每小时一次；状态/磁盘裁剪在各自采集后立即执行。
- `retention_days` 旧字段不再展示，作为 `host_daily_summary_retention_days` 的兼容后备值。
- 导入自动采集在当前进程后台执行，不阻塞 HTTP 请求；同一主机已有采集任务时复用，不重复排队。
