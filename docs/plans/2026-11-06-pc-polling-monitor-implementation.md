# 实验室服务器轮询监测工具（PC 版）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 `servermanage` 改造成可在 Windows 11 绿色部署的轮询监测工具：保留 SSH 采集/日报/周报/邮件，新增本地 Web 仪表盘、多通道告警和 storcli 每盘健康检查。

**Architecture:** 复用现有 `collectors`/`parsers`/`report`/`weekly`/`mailer`，新增 `disk_health`（storcli 解析+健康判定）、`alerts`（规则+去重+多通道）、`scheduler`（轮询+报告 catch-up）、`web`（Flask+waitress）。SQLite 在保留 `host_metrics_history` 的基础上新增快照/磁盘/告警/任务状态表；守护进程 `app.py` 同时跑调度线程与 Web。

**Tech Stack:** Python 3.11+、Flask 3.x、waitress 3.x、Jinja2、PyYAML、paramiko、python-dotenv、tzdata、winotify（桌面通知，导入失败降级 PowerShell）、PyInstaller `--onedir`。

**Spec:** `servermonitor-main/servermonitor-main/docs/plans/2026-11-06-pc-polling-monitor-design.md`

## Global Constraints

- 运行平台 Windows 11 原生；不安装服务器端 agent；PC 通过 SSH 中心化采集。
- 交付 `PyInstaller --onedir` 绿色包，解压双击 `启动.bat` 即可；不引入前端构建链，前端用原生 JS。
- 技术栈固定：Flask + waitress + Jinja2；自研轻量调度线程；storcli JSON 优先、文本兜底。
- 所有密钥、口令、Webhook URL 只放 `.env`；不得写入 YAML、日志或模板。
- 时区统一 `Asia/Shanghai` 本地日界；日/周统计必须“先按天聚合，再周统计”。
- storcli/smartctl 一律 `sudo -n <cmd>`；权限不足必须标记 `permission_denied`，**绝不**因此产生 critical 坏盘告警。
- “看不到”的盘（非 storcli 控制器/外部存储）标 `未纳管`，**绝不伪造健康状态**。
- 保留现有 `host_metrics_history` 结构与既有 pytest 全绿；配置向后兼容，新增段都有默认值。
- 规模 ≤10 台、7×24 常开；连续 2 次采集失败判主机离线。
- 依赖版本下限：`Flask>=3.0.3,<4`、`waitress>=3.0.0,<4`、`winotify>=1.1.0,<2`、`tzdata>=2024.1`。

## Review Focus

以下 5 类是规格隐含、但最容易被实现者忽略的失败模式，每条都要在对应任务的测试里钉住：

1. **权限/工具缺失降级**：`sudo -n` 要密码、无 storcli、无控制器时，必须返回 `permission_denied` / `no_storcli` / `no_controller`，且不产生任何 `critical` 磁盘告警（误报坏盘会导致无谓换盘）。
2. **多控制器/多固件 JSON 差异**：9361/9362/9364/9460 与单机双控制器（4090 的 c0+c1）结构不同；解析不得假设只有 `c0`，JSON 失效必须回退文本。
3. **异常数值格式**：`Drive Temperature` 形如 `" 27C (80.60 F)"`、错误计数可能缺失或 `N/A`；必须解析或保留 `None`，不能默认 0 而误判 healthy，也不能抛异常。
4. **进程重启后的冷却/去重**：同 `fingerprint` 在 `cooldown_minutes` 内重启也不得重复通知；错误计数增加必须能突破冷却再发一次。
5. **局域网看板鉴权**：未登录访问页面要跳 `/login`、访问 `/api/*` 要 401；口令不得出现在日志/模板；session secret 来自 `.env`。

---

### Task 1: 扩展配置模型与加载器

**Files:**
- Modify: `servermonitor-main/servermonitor-main/pyproject.toml`
- Modify: `servermonitor-main/servermonitor-main/servermanage/models.py`
- Modify: `servermonitor-main/servermonitor-main/servermanage/config.py`
- Test: `servermonitor-main/servermonitor-main/tests/test_config_extended.py`

**Interfaces:**
- Consumes: 现有 `AuthConfig/HostConfig/SMTPConfig/SSHRuntimeConfig/ReportConfig/StorageConfig/AppConfig`。
- Produces（`servermanage/models.py`）:
  - `AppRuntimeConfig(poll_interval_seconds:int=600, disk_poll_interval_seconds:int=86400, concurrency:int=8, retention_days:int=90, timezone:str="Asia/Shanghai")`
  - `DashboardAuthConfig(enabled:bool=True, username:str="admin", password_env:str|None="DASHBOARD_PASSWORD", password:str|None=None)`
  - `DashboardConfig(host:str="0.0.0.0", port:int=8080, auth:DashboardAuthConfig=..., session_secret_env:str="DASHBOARD_SECRET", session_secret:str|None=None, session_lifetime_hours:int=12)`
  - `AlertThresholds(cpu_percent:float=90, memory_percent:float=90, disk_percent:float=90, gpu_memory_percent:float=90, disk_temperature_c:float=55)`
  - `WebhookConfig(enabled:bool=False, type:str="wecom", url_env:str|None="ALERT_WEBHOOK_URL", url:str|None=None)`
  - `AlertsConfig(enabled:bool=True, desktop_notification:bool=True, email:bool=True, webhook:WebhookConfig=..., thresholds:AlertThresholds=..., cooldown_minutes:int=60, repeat_while_active:bool=False, offline_failures:int=2)`
  - `DiskHealthRuleConfig(alert_on_media_errors:bool=True, alert_on_other_errors:bool=True, alert_on_predictive_failure:bool=True, alert_on_smart_flag:bool=True, alert_on_state_not_optimal:bool=True, alert_on_error_increase:bool=True)`
  - `DiskHealthConfig(enabled:bool=True, use_sudo:bool=True, storcli_candidates:tuple[str,...]=("storcli","storcli64","/opt/MegaRAID/storcli/storcli64","/opt/lsi/storcli/storcli64","/usr/local/bin/storcli","/usr/sbin/storcli"), rules:DiskHealthRuleConfig=...)`
  - `HostDiskHealthOverride(enabled:bool|None=None, storcli_path:str|None=None, use_sudo:bool|None=None)`
  - `HostConfig` 追加：`tags:list[str]=field(default_factory=list)`、`disk_health:HostDiskHealthOverride|None=None`
  - `ReportConfig` 追加：`daily_enabled:bool=True`、`daily_time:str="09:00"`；`WeeklyReportConfig` 追加：`time:str="16:00"`
  - `AppConfig` 追加（保持在 `storage` 之后、都有默认值）：`app:AppRuntimeConfig`、`dashboard:DashboardConfig`、`alerts:AlertsConfig`、`disk_health:DiskHealthConfig`；`smtp` 类型改为 `SMTPConfig | None`（仍无默认值）。
- Produces（`servermanage/config.py`）: `load_config(path)` 支持上述全部段与默认值；`smtp` 段整段缺失时 `config.smtp is None`；`DASHBOARD_PASSWORD`/`DASHBOARD_SECRET` 有值就读、缺失不报错（由 Web 启动时校验）。

- [ ] **Step 1: 更新依赖**

在 `pyproject.toml` 的 `dependencies` 追加 `"Flask>=3.0.3,<4"`、`"waitress>=3.0.0,<4"`、`"winotify>=1.1.0,<2"`、`"tzdata>=2024.1"`；在 `[project.optional-dependencies]` 增加 `build = ["pyinstaller>=6.6,<7"]`。然后运行 `pip install -e ".[dev,build]"`。

- [ ] **Step 2: 写失败测试**

新建 `tests/test_config_extended.py`：

```python
from pathlib import Path
import pytest
from servermanage.config import ConfigError, load_config

BASE = """
ssh: {connect_timeout: 10, command_timeout: 20}
report: {subject_prefix: "[Daily]"}
servers:
  - name: "gpu-01"
    host: "10.0.0.1"
    username: "zhouyc"
    auth: {type: "password", password_env: "GPU01_PASSWORD"}
"""

def _write(tmp_path, extra: str) -> Path:
    p = tmp_path / "config.yaml"
    p.write_text(BASE + extra, encoding="utf-8")
    return p

def test_defaults(tmp_path, monkeypatch):
    monkeypatch.setenv("GPU01_PASSWORD", "x")
    cfg = load_config(_write(tmp_path, ""))
    assert cfg.smtp is None
    assert cfg.app.poll_interval_seconds == 600
    assert cfg.app.disk_poll_interval_seconds == 86400
    assert cfg.app.concurrency == 8
    assert cfg.app.retention_days == 90
    assert cfg.app.timezone == "Asia/Shanghai"
    assert cfg.dashboard.port == 8080
    assert cfg.dashboard.auth.username == "admin"
    assert cfg.alerts.thresholds.cpu_percent == 90
    assert cfg.alerts.cooldown_minutes == 60
    assert cfg.disk_health.use_sudo is True
    assert "storcli" in cfg.disk_health.storcli_candidates

def test_overrides_and_host_disk_override(tmp_path, monkeypatch):
    monkeypatch.setenv("GPU01_PASSWORD", "x")
    monkeypatch.setenv("DASHBOARD_PASSWORD", "pw")
    monkeypatch.setenv("DASHBOARD_SECRET", "secret")
    extra = """
app: {poll_interval_seconds: 120, concurrency: 4, timezone: "UTC"}
dashboard: {port: 9090, auth: {username: "ops", password_env: "DASHBOARD_PASSWORD"}}
alerts: {cooldown_minutes: 30, thresholds: {cpu_percent: 80}}
disk_health: {use_sudo: false, alert_on_media_errors: false}
"""
    cfg = load_config(_write(tmp_path, extra))
    assert cfg.app.poll_interval_seconds == 120
    assert cfg.app.timezone == "UTC"
    assert cfg.dashboard.port == 9090
    assert cfg.dashboard.auth.username == "ops"
    assert cfg.dashboard.auth.password == "pw"
    assert cfg.dashboard.session_secret == "secret"
    assert cfg.alerts.thresholds.cpu_percent == 80
    assert cfg.alerts.cooldown_minutes == 30
    assert cfg.disk_health.use_sudo is False
    assert cfg.disk_health.rules.alert_on_media_errors is False

def test_host_tags_and_disk_override(tmp_path, monkeypatch):
    monkeypatch.setenv("GPU01_PASSWORD", "x")
    p = tmp_path / "config.yaml"
    p.write_text("""
ssh: {connect_timeout: 10, command_timeout: 20}
report: {subject_prefix: "[Daily]"}
servers:
  - name: "gpu-02"
    host: "10.0.0.2"
    username: "zhouyc"
    auth: {type: "password", password_env: "GPU01_PASSWORD"}
    tags: ["gpu", "prod"]
    disk_health: {storcli_path: "/usr/local/bin/storcli", use_sudo: true}
""".strip(), encoding="utf-8")
    cfg = load_config(p)
    assert cfg.servers[0].tags == ["gpu", "prod"]
    assert cfg.servers[0].disk_health.storcli_path == "/usr/local/bin/storcli"
    assert cfg.servers[0].disk_health.use_sudo is True
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pytest tests/test_config_extended.py -v`
Expected: FAIL（`AttributeError: 'AppConfig' object has no attribute 'app'` 或 ImportError）。

- [ ] **Step 4: 实现模型与加载器**

在 `models.py` 追加上述 dataclass（注意 `AppConfig` 字段顺序：无默认值的 `smtp/ssh/report/servers` 在前，带默认值的 `storage/app/dashboard/alerts/disk_health` 在后）。在 `config.py` 增加 `_load_app/dashboard/alerts/disk_health/smtp_optional` 等私有函数，`load_config` 中：

```python
smtp_raw = raw.get("smtp")
smtp = _load_smtp(smtp_raw) if smtp_raw else None
...
app_cfg = _load_app(raw.get("app"))
dashboard = _load_dashboard(raw.get("dashboard"))
alerts_cfg = _load_alerts(raw.get("alerts"))
disk_cfg = _load_disk_health(raw.get("disk_health"))
servers = [ ... HostConfig(..., tags=list(item.get("tags") or []), disk_health=_load_host_disk(item.get("disk_health"))) ... ]
return AppConfig(smtp=smtp, ssh=ssh, report=report, servers=servers,
                 storage=storage, app=app_cfg, dashboard=dashboard,
                 alerts=alerts_cfg, disk_health=disk_cfg)
```

`_load_smtp`：`None` → `None`；非空 mapping 仍校验 `host/port/username/password_env/from_addr/to_addrs`（保持现有错误文案 `smtp.host is required`）。

- [ ] **Step 5: 运行全部配置测试**

Run: `pytest tests/test_config.py tests/test_config_extended.py -v`
Expected: 全部 PASS（旧测试不改、仍通过）。

- [ ] **Step 6: 提交**

```bash
git add pyproject.toml servermanage/models.py servermanage/config.py tests/test_config_extended.py
git commit -m "feat(config): add app/dashboard/alerts/disk_health settings"
```

---

### Task 2: 序列化与存储扩展（快照/磁盘/告警/任务状态）

**Files:**
- Create: `servermonitor-main/servermonitor-main/servermanage/serialization.py`
- Modify: `servermonitor-main/servermonitor-main/servermanage/storage.py`
- Test: `servermonitor-main/servermonitor-main/tests/test_storage_extended.py`

**Interfaces:**
- Consumes: `HostReport`、`DiskHealthReport`（Task 4 定义）、`AlertEvent`（Task 4 定义）。
- Produces（`serialization.py`）: `to_jsonable(obj) -> object`（dataclass→dict、datetime→iso、tuple→list、Path→str）；`dump_json(obj) -> str`（`ensure_ascii=False`）。
- Produces（`storage.py`）:
  - `save_host_snapshot(host_report: HostReport, db_path: Path) -> None`
  - `get_host_snapshot(host_name: str, db_path: Path) -> dict | None`（`{"host_name","collected_at","success","metrics":dict,"errors":list}`）
  - `get_all_host_snapshots(db_path: Path) -> list[dict]`
  - `save_disk_health(report: DiskHealthReport, db_path: Path) -> None`
  - `get_disk_health(host_name: str, db_path: Path) -> dict | None`（最近一批 `collected_at` 的 controller/vd/pd 列表 + `status/message`）
  - `get_all_disk_health(db_path: Path) -> list[dict]`
  - `insert_alert(event: AlertEvent, db_path: Path) -> int`
  - `find_latest_alert(fingerprint: str, db_path: Path) -> dict | None`
  - `update_alert(alert_id: int, db_path: Path, *, status: str | None = None, notified_channels: str | None = None, ack_at: str | None = None) -> None`
  - `list_alerts(db_path: Path, *, status: str | None = None, limit: int = 200) -> list[dict]`
  - `get_task_state(task_name: str, db_path: Path) -> dict | None`
  - `set_task_state(task_name: str, db_path: Path, *, last_run_at: str, last_result: str | None = None) -> None`
  - `purge_old_data(db_path: Path, retention_days: int, *, now: datetime | None = None) -> dict[str, int]`
- 表结构（`init_storage` 一并创建）：

```sql
host_latest_snapshot(host_name TEXT PRIMARY KEY, collected_at TEXT NOT NULL, success INTEGER NOT NULL, raw_json TEXT NOT NULL);
disk_controller_snapshot(id INTEGER PRIMARY KEY AUTOINCREMENT, collected_at TEXT NOT NULL, host_name TEXT NOT NULL, controller INTEGER, model TEXT, firmware TEXT, bbu_state TEXT, health TEXT, reasons TEXT);
disk_vd_snapshot(id INTEGER PRIMARY KEY AUTOINCREMENT, collected_at TEXT NOT NULL, host_name TEXT NOT NULL, controller INTEGER, vd_id INTEGER, raid_level TEXT, state TEXT, size TEXT, health TEXT, reasons TEXT);
disk_pd_snapshot(id INTEGER PRIMARY KEY AUTOINCREMENT, collected_at TEXT NOT NULL, host_name TEXT NOT NULL, controller INTEGER, enclosure INTEGER, slot INTEGER, did INTEGER, model TEXT, serial TEXT, state TEXT, media_errors INTEGER, other_errors INTEGER, predictive_failures INTEGER, smart_alert INTEGER, temperature_c INTEGER, shield_counter INTEGER, health TEXT, reasons TEXT);
alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, host_name TEXT, category TEXT, severity TEXT, title TEXT, message TEXT, fingerprint TEXT, status TEXT DEFAULT 'active', notified_channels TEXT, ack_at TEXT);
task_state(task_name TEXT PRIMARY KEY, last_run_at TEXT NOT NULL, last_result TEXT);
```

索引：`(host_name, collected_at)` 于三张磁盘表；`alerts(fingerprint)`、`alerts(created_at)`。

- [ ] **Step 1: 写失败测试**

`tests/test_storage_extended.py` 覆盖：host 快照 roundtrip（`metrics.cpu_usage_percent` 保存/读出）；`save_disk_health` 后 `get_disk_health` 返回 6 块盘且字段齐全；alert insert/find_latest/update/list 过滤；`task_state` 覆盖写；`purge_old_data` 删除 100 天前记录、保留今天记录（用 `now=` 注入固定时间）。测试里构造 `DiskHealthReport`/`AlertEvent` 时先按 Task 4 的字段签名，若 Task 4 尚未实现可先本地 import；实现顺序上 Task 4 可与本任务并行，但本任务先落存储。

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/test_storage_extended.py -v`
Expected: FAIL（ImportError / 函数不存在）。

- [ ] **Step 3: 实现 serialization 与 storage**

`to_jsonable`：

```python
def to_jsonable(obj):
    if is_dataclass(obj): return {k: to_jsonable(v) for k, v in asdict(obj).items()}
    if isinstance(obj, datetime): return obj.isoformat()
    if isinstance(obj, (list, tuple)): return [to_jsonable(v) for v in obj]
    if isinstance(obj, Path): return str(obj)
    return obj
```

`save_disk_health` 用 `report.collected_at.isoformat()` 统一三张表；`get_disk_health` 取该 host `MAX(collected_at)` 后按时间戳取三类行。`purge_old_data` 删除 `collected_at < cutoff` 的 `host_metrics_history`、三张磁盘表、`status='resolved'` 的 alerts，返回各表删除数。

- [ ] **Step 4: 运行确认通过**

Run: `pytest tests/test_storage_extended.py -v`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add servermanage/serialization.py servermanage/storage.py tests/test_storage_extended.py
git commit -m "feat(storage): snapshots, disk health, alerts, task state"
```

---

### Task 3: storcli 解析（JSON 优先、文本兜底）

**Files:**
- Create: `servermonitor-main/servermonitor-main/servermanage/disk_health.py`（本任务先放模型+解析）
- Create: `servermonitor-main/servermonitor-main/tests/fixtures/storcli/*.json`（从工作区 `samples/storcli/` 复制）
- Test: `servermonitor-main/servermonitor-main/tests/test_disk_parse.py`

**Interfaces:**
- Produces（`disk_health.py`）:
  - `class StorcliParseError(ValueError)`
  - `parse_temperature(value: object) -> int | None`（`" 27C (80.60 F)"`→27，`"N/A"`/None→None，数字→int）
  - `parse_controllers(text: str) -> list[DiskControllerInfo]`（读 `/cALL show J`）
  - `parse_virtual_drives(text: str, controller: int) -> list[VirtualDriveInfo]`（读 `/cX/vall show J`）
  - `parse_physical_drives(text: str) -> list[PhysicalDriveInfo]`（读 `/cX/eall/sall show all J`；JSON 失败→`parse_physical_drives_text`）
  - `parse_physical_drives_text(text: str) -> list[PhysicalDriveInfo]`
  - `_flatten_pairs(obj) -> list[tuple[str, object]]`：递归收集所有 `key -> value` 对，键名大小写/空白不敏感匹配
- 数据类（本任务定义，供后续使用）：
  - `DiskControllerInfo(controller:int, model:str|None=None, firmware:str|None=None, bbu_state:str|None=None, health:str="unknown", reasons:list[str]=field(default_factory=list))`
  - `VirtualDriveInfo(controller:int, vd_id:int, raid_level:str|None=None, state:str|None=None, size:str|None=None, health:str="unknown", reasons:list[str]=field(default_factory=list))`
  - `PhysicalDriveInfo(controller:int, enclosure:int|None=None, slot:int|None=None, did:int|None=None, model:str|None=None, serial:str|None=None, state:str|None=None, media_errors:int|None=None, other_errors:int|None=None, predictive_failures:int|None=None, smart_alert:bool|None=None, temperature_c:int|None=None, shield_counter:int|None=None, health:str="unknown", reasons:list[str]=field(default_factory=list))`
  - `DiskHealthReport(host_name:str, collected_at:datetime, status:str="ok", message:str|None=None, controllers:list[DiskControllerInfo]=..., virtual_drives:list[VirtualDriveInfo]=..., physical_drives:list[PhysicalDriveInfo]=...)`
  - `AlertEvent(host_name:str, category:str, severity:str, title:str, message:str, fingerprint:str)`

**真实 JSON 结构（已核实）**：`Controllers[].Response Data` 下同时含 `"Drive /cX/eY/sZ"`（`EID:Slt/DID/State/Model/Size/Intf`）与 `"Drive /cX/eY/sZ - Detailed Information"`（内含 `"Drive /cX/eY/sZ State"` 与 `"... Device attributes"`）；`State` 块键为 `Shield Counter`、`Media Error Count`、`Other Error Count`、`Drive Temperature`、`Predictive Failure Count`、`S.M.A.R.T alert flagged by drive`；attributes 块键为 `SN`、`Model Number`、`Firmware Revision`。

- [ ] **Step 1: 准备 fixtures**

```bash
mkdir -p tests/fixtures/storcli
cp samples/storcli/*.json tests/fixtures/storcli/
```

- [ ] **Step 2: 写失败测试**

```python
from pathlib import Path
from servermanage.disk_health import (
    parse_physical_drives, parse_temperature, parse_physical_drives_text,
)

FIX = Path(__file__).parent / "fixtures" / "storcli"

def test_parse_a100_six_drives():
    drives = parse_physical_drives((FIX / "a100__c0_eall_sall_show_all_J.json").read_text())
    assert len(drives) == 6
    assert all(d.state and "Onln" in d.state for d in drives)
    assert all(d.media_errors == 0 for d in drives)
    assert all(20 <= d.temperature_c <= 45 for d in drives)

def test_parse_4090_two_controllers():
    drives = parse_physical_drives((FIX / "4090__c0_eall_sall_show_all_J.json").read_text()) \
           + parse_physical_drives((FIX / "4090__c1_eall_sall_show_all_J.json").read_text())
    assert {d.controller for d in drives} == {0, 1}
    assert len(drives) == 8

def test_parse_v100_and_h100_counts():
    assert len(parse_physical_drives((FIX / "v100__c0_eall_sall_show_all_J.json").read_text())) == 2
    assert len(parse_physical_drives((FIX / "h100__c0_eall_sall_show_all_J.json").read_text())) == 5

def test_parse_temperature_variants():
    assert parse_temperature(" 27C (80.60 F)") == 27
    assert parse_temperature("N/A") is None
    assert parse_temperature(None) is None
    assert parse_temperature(31) == 31

def test_text_fallback():
    text = """
Drive /c0/e252/s3 - Detailed Information:
Drive /c0/e252/s3 State:
Media Error Count = 3
Other Error Count = 1
Predictive Failure Count = 0
S.M.A.R.T alert flagged by drive = Yes
Drive Temperature = 41C (105.80 F)
"""
    drives = parse_physical_drives_text(text)
    assert len(drives) == 1
    d = drives[0]
    assert (d.controller, d.enclosure, d.slot) == (0, 252, 3)
    assert d.media_errors == 3 and d.other_errors == 1
    assert d.smart_alert is True and d.temperature_c == 41
```

- [ ] **Step 3: 运行确认失败**

Run: `pytest tests/test_disk_parse.py -v`
Expected: FAIL（ImportError）。

- [ ] **Step 4: 实现解析器**

实现要点：`parse_physical_drives` 先 `json.loads`，失败 `raise` 前在内部 `except` 调文本解析；JSON 路径遍历 `Controllers`，每个取 `Response Data`，找匹配 `^Drive /c(\d+)/e(\d+)/s(\d+)$` 的键得到槽位，再用 `_flatten_pairs` 在 `... Detailed Information` 中按键名取值（`Media Error Count`、`Other Error Count`、`Predictive Failure Count`、`Drive Temperature`、`S.M.A.R.T alert flagged by drive`、`Shield Counter`、`SN`、`Model Number`）。文本解析用正则分段并按 `Key = Value`。所有数值用容错转换，缺失→`None`。

- [ ] **Step 5: 运行确认通过**

Run: `pytest tests/test_disk_parse.py -v`
Expected: PASS（四台真实样本全部解析成功）。

- [ ] **Step 6: 提交**

```bash
git add servermanage/disk_health.py tests/test_disk_parse.py tests/fixtures/storcli
git commit -m "feat(disk): storcli JSON/text parsing with real fixtures"
```

---

### Task 4: 磁盘健康判定与 SSH 采集

**Files:**
- Modify: `servermonitor-main/servermonitor-main/servermanage/disk_health.py`
- Test: `servermonitor-main/servermonitor-main/tests/test_disk_health.py`

**Interfaces:**
- Consumes: `HostConfig`、`SSHRunner.run(command, timeout)->CommandResult`、`DiskHealthConfig`、`HostDiskHealthOverride`。
- Produces:
  - `evaluate_drive_health(drive: PhysicalDriveInfo, *, rules: DiskHealthRuleConfig, temperature_threshold_c: float = 55.0, previous: PhysicalDriveInfo | None = None) -> PhysicalDriveInfo`（返回 `dataclasses.replace` 后的对象；`reasons` 为机器码集合：`state_failed`/`state_degraded`/`predictive_failure`/`smart_flag`/`media_errors`/`other_errors`/`error_increase`/`temperature`）
  - `evaluate_virtual_drive_health(vd: VirtualDriveInfo) -> VirtualDriveInfo`
  - `collect_disk_health(host: HostConfig, runner: SSHRunner, *, config: DiskHealthConfig, command_timeout: int, previous: DiskHealthReport | None = None, override: HostDiskHealthOverride | None = None, now: datetime | None = None) -> DiskHealthReport`

**判定规则（严格按设计 7.2）**：State ∈ {Failed, Offline, Missing, Offln} → `critical` + `state_failed`；State ∈ {Rebuild, Rbld, Copyback, Degraded} → `warning` + `state_degraded`；Predictive>0 → `warning`+`predictive_failure`；SMART=Yes → `warning`+`smart_flag`；Media>0 或 Other>0 → `warning`+`media_errors`/`other_errors`；与 `previous` 比 Media/Other 增加 → `warning`+`error_increase`；温度 > 阈值 → `warning`+`temperature`；否则 `healthy`。

- [ ] **Step 1: 写失败测试**

`tests/test_disk_health.py` 用 `FakeRunner`（按命令子串返回 `CommandResult`）：
- `test_evaluate_states`：Failed→critical/state_failed；Rebuild→warning/state_degraded；healthy 普通 Onln。
- `test_evaluate_errors_and_smart`：media 2→warning/media_errors；smart True→smart_flag；predictive 1→predictive_failure。
- `test_error_increase`：previous media 0，当前 2 → reasons 含 `error_increase`。
- `test_temperature_threshold`：56>55 → warning/temperature；55 不告警。
- `test_collect_permission_denied`：`sudo -n ... -v` 返回 exit 1、stderr `sudo: a password is required` → `status == "permission_denied"`，`physical_drives == []`。
- `test_collect_no_storcli`：所有候选 exit 127 → `status == "no_storcli"`。
- `test_collect_ok_multi_controller`：FakeRunner 对 `-v` 返回 0；`/cALL show J` 返回 4090 控制器 JSON；`/c0/vall show J`、`/c1/vall show J`、`/c0/eall/sall show all J`、`/c1/eall/sall show all J` 返回对应 fixtures；断言 `status=="ok"`、8 块盘、且 `runner.commands` 里每条 storcli 命令都以 `sudo -n ` 开头。

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/test_disk_health.py -v`
Expected: FAIL（`evaluate_drive_health`/`collect_disk_health` 不存在）。

- [ ] **Step 3: 实现**

`collect_disk_health` 流程：候选 = `override.storcli_path` 或 `config.storcli_candidates`；`prefix = "sudo -n " if (override.use_sudo if override and override.use_sudo is not None else config.use_sudo) else ""`。逐个 `run(f"{prefix}{cand} -v")`，成功（exit 0）选中。全部失败时，若任一 stderr 含 `password is required` 或 `not in the sudoers` → `permission_denied`，否则 `no_storcli`。运行 `/cALL show J` 得控制器；若为空 → `no_controller`。对每个控制器 `id` 跑 `/c{id}/vall show J` 与 `/c{id}/eall/sall show all J`，解析后按 (controller,enclosure,slot) 匹配 `previous` 做 `evaluate_drive_health`。

- [ ] **Step 4: 运行确认通过**

Run: `pytest tests/test_disk_health.py -v`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add servermanage/disk_health.py tests/test_disk_health.py
git commit -m "feat(disk): health evaluation and SSH collector with sudo -n"
```

---

### Task 5: 告警事件生成（系统指标 + 磁盘规则）

**Files:**
- Create: `servermonitor-main/servermonitor-main/servermanage/alerts.py`（本任务先放规则函数）
- Test: `servermonitor-main/servermonitor-main/tests/test_alert_rules.py`

**Interfaces:**
- Consumes: `HostMetrics`、`AlertThresholds`、`DiskHealthReport`、`DiskHealthRuleConfig`、`AlertEvent`。
- Produces:
  - `fingerprint_for(*parts: str) -> str`（冒号连接、小写）
  - `evaluate_system_alerts(host_name: str, metrics: HostMetrics, thresholds: AlertThresholds, *, disk_percent: float | None = None) -> list[AlertEvent]`
  - `evaluate_disk_alerts(report: DiskHealthReport) -> list[AlertEvent]`
  - `offline_alert(host_name: str, failures: int) -> AlertEvent`
  - `recovery_event(host_name: str, category: str) -> AlertEvent`

规则：
- CPU `> threshold` → `warning`，`fingerprint_for("system", host, "cpu")`。
- 内存使用率 = `used/total*100 > memory_percent`。
- 磁盘使用率由调用方传入 `disk_percent`（取真实盘最大使用率），超阈值 → `warning`。
- GPU 显存 = `sum(used)/sum(total)*100 > gpu_memory_percent`。
- 磁盘：遍历 `report.physical_drives`，`health in {"warning","critical"}` 生成事件，`category="disk"`，`severity=drive.health`，`fingerprint_for("disk", host, f"c{c}", f"e{e}", f"s{s}", drive.reasons[0])`；无槽位用 `did`。
- `offline_alert` severity `critical`，`fingerprint_for("offline", host)`。

- [ ] **Step 1: 写失败测试**

`tests/test_alert_rules.py`：
- `test_cpu_memory_gpu_thresholds`：构造 HostMetrics cpu=95、memory 90/100、gpu used 95/100；thresholds 90；期望 3 条 warning，fingerprint 唯一。
- `test_disk_alert_from_warning_drive`：构造报告含 1 块 `warning` 盘 reasons `["media_errors"]`；期望 1 条 `category=="disk"`、`severity=="warning"`、fingerprint 含 `c0:e252:s3`。
- `test_no_alert_when_healthy`：healthy 盘不产生事件。
- `test_offline_alert`。

- [ ] **Step 2: 运行确认失败** → Run: `pytest tests/test_alert_rules.py -v`（FAIL）。

- [ ] **Step 3: 实现** — 按上面规则；中文标题示例 `CPU 使用率过高`、`内存使用率过高`、`磁盘使用率过高`、`GPU 显存占用过高`、`磁盘 {host} c{c}/e{e}/s{s} 异常`。

- [ ] **Step 4: 运行确认通过** → `pytest tests/test_alert_rules.py -v`（PASS）。

- [ ] **Step 5: 提交**

```bash
git add servermanage/alerts.py tests/test_alert_rules.py
git commit -m "feat(alerts): system and disk alert rules"
```

---

### Task 6: 告警引擎（去重/冷却/持久化）

**Files:**
- Modify: `servermonitor-main/servermonitor-main/servermanage/alerts.py`
- Test: `servermonitor-main/servermonitor-main/tests/test_alert_engine.py`

**Interfaces:**
- Consumes: `storage`（Task 2）、`AlertsConfig`、`AlertEvent`。
- Produces:
  - `class NotifierProtocol(Protocol): def dispatch(self, event: AlertEvent, config: AlertsConfig) -> list[str]: ...`
  - `class AlertEngine: __init__(self, db_path: Path, config: AlertsConfig, notifier: NotifierProtocol, *, clock: Callable[[], datetime] = ...)`
  - `AlertEngine.process(self, events: list[AlertEvent]) -> list[AlertEvent]`（返回实际已通知的事件）
  - `AlertEngine.resolve(self, host_name: str, category: str) -> None`（把该 host/category 活动告警置 `resolved`）

逻辑：对每个事件 `latest = find_latest_alert(fp)`；若 `latest.status=="active"` 且 `clock()-created_at < cooldown_minutes` 且事件 `reasons`/fingerprint 不含 `error_increase` → 跳过；否则 `insert_alert`，`channels = notifier.dispatch(event, config)`，`update_alert(id, notified_channels=",".join(channels))`，收集返回。

- [ ] **Step 1: 写失败测试**

`tests/test_alert_engine.py`（使用固定 `clock` 与 `FakeNotifier` 记录调用）：
- `test_first_event_notified`：返回 1 条，DB 有记录，`notified_channels=="desktop,email"`。
- `test_duplicate_within_cooldown_skipped`：同 fingerprint 10 分钟内第二次 → 返回空、DB 仅 1 行。
- `test_notify_after_cooldown`：把 clock 推后 61 分钟 → 再发。
- `test_error_increase_breaks_cooldown`：指纹含 `error_increase` 且 5 分钟内 → 仍通知。
- `test_cooldown_survives_restart`：新建第二个 `AlertEngine`（同 db）5 分钟内 → 跳过（验证持久化）。

- [ ] **Step 2–5:** 确认失败 → 实现 → `pytest tests/test_alert_engine.py -v` PASS → 提交 `feat(alerts): dedupe/cooldown engine`。

---

### Task 7: 通知通道（桌面 / Webhook / 邮件）

**Files:**
- Create: `servermonitor-main/servermonitor-main/servermanage/notify_desktop.py`
- Create: `servermonitor-main/servermonitor-main/servermanage/notify_webhook.py`
- Modify: `servermonitor-main/servermonitor-main/servermanage/alerts.py`（新增 `Notifier`）
- Test: `servermonitor-main/servermonitor-main/tests/test_notify.py`

**Interfaces:**
- Produces（`notify_desktop.py`）: `send_desktop_notification(title: str, message: str) -> bool`（先尝试 `winotify`，`ImportError`/异常则用 `subprocess.run(["powershell","-NoProfile","-Command", script], ...)`，返回是否成功）。
- Produces（`notify_webhook.py`）:
  - `build_webhook_payload(kind: str, event: AlertEvent) -> dict`：`wecom`/`dingtalk` → `{"msgtype":"text","text":{"content": "[severity] title\nmessage"}}`；`generic` → `{"host","severity","title","message","timestamp"}`。
  - `send_webhook(config: WebhookConfig, event: AlertEvent, *, opener=None) -> bool`：URL 取 `config.url` 或 `os.getenv(config.url_env)`；`urllib.request` POST `json`，2xx 为成功。
- Produces（`alerts.py`）: `class Notifier: __init__(self, *, smtp: SMTPConfig | None = None); dispatch(self, event: AlertEvent, config: AlertsConfig) -> list[str]`（按 `config.desktop_notification`/`email`/`webhook.enabled` 逐通道发送，返回成功的通道名 `desktop`/`email`/`webhook`；任一失败只记日志）。

- [ ] **Step 1: 写失败测试**

`tests/test_notify.py`：
- `test_webhook_payload_wecom/dingtalk/generic`：断言结构键。
- `test_send_webhook_posts_json`：注入 fake `opener`（记录 `Request` 的 url/data），断言 data 为 JSON 且 URL 正确。
- `test_desktop_falls_back_to_powershell`：`monkeypatch` 使 `winotify` 导入失败、`subprocess.run` 返回 `returncode=0` → True；断言调用参数含 `powershell`。
- `test_notifier_dispatches_enabled_channels`：`AlertsConfig` 桌面+邮件开、webhook 关，monkeypatch `send_desktop_notification`/`send_report` → 返回 `["desktop","email"]`；`smtp=None` 时邮件跳过。

- [ ] **Step 2–5:** 确认失败 → 实现 → `pytest tests/test_notify.py -v` PASS → 提交 `feat(notify): desktop/webhook/email channels`。

---

### Task 8: 调度器与 catch-up

**Files:**
- Create: `servermonitor-main/servermonitor-main/servermanage/scheduler.py`
- Create: `servermonitor-main/servermonitor-main/servermanage/timeutil.py`
- Test: `servermonitor-main/servermonitor-main/tests/test_scheduler.py`

**Interfaces:**
- Produces（`timeutil.py`）: `resolve_timezone(name: str) -> tzinfo`（`ZoneInfo`，异常回退 `timezone.utc` 并 warning）。
- Produces（`scheduler.py`）:
  - `should_run(*, last_run_at: datetime | None, interval_seconds: int, now: datetime) -> bool`
  - `compute_daily_fire(now_local: datetime, hhmm: str) -> datetime`（今天该时刻若已过则明天）
  - `compute_weekly_fire(now_local: datetime, weekday: int, hhmm: str) -> datetime`（0=周一）
  - `is_report_due(*, last_run_at: datetime | None, target_local: datetime, now_local: datetime) -> bool`
  - `@dataclass class ScheduledTask(name:str, interval_seconds:int, func:Callable[[],None])`
  - `class Scheduler: __init__(self, tasks: list[ScheduledTask], *, db_path: Path, tz: tzinfo, clock: Callable[[], datetime] = ...); run_pending(self) -> list[str]; start(self) -> None; stop(self) -> None`

- [ ] **Step 1: 写失败测试**

`tests/test_scheduler.py`：
- `test_should_run_first_time`（last None → True）。
- `test_should_run_respects_interval`（9 分钟后 False，11 分钟后 True）。
- `test_catch_up_after_three_days`（last 3 天前 → True 且只执行一次）。
- `test_daily_fire_before_and_after`（08:00→当天 09:00；10:00→次日 09:00）。
- `test_weekly_fire`（周三→本周五 16:00；周六→下周五）。
- `test_scheduler_records_task_state`：假 func 计数，`run_pending` 首次执行、写入 `task_state`，第二次间隔内不执行。

- [ ] **Step 2–5:** 确认失败 → 实现 → `pytest tests/test_scheduler.py -v` PASS → 提交 `feat(scheduler): interval tasks and report catch-up`。

---

### Task 9: 报告统计改为本地时区 + 按天聚合

**Files:**
- Modify: `servermonitor-main/servermonitor-main/servermanage/storage.py`
- Modify: `servermonitor-main/servermonitor-main/servermanage/weekly.py`
- Test: `servermonitor-main/servermonitor-main/tests/test_storage_local_time.py`

**Interfaces:**
- Produces: `fetch_daily_points_for_week(db_path, week_start, week_end, tz: tzinfo = timezone.utc)` 与 `fetch_weekly_metrics(db_path, week_start, week_end, tz: tzinfo = timezone.utc)` 新增可选 `tz`。
- Produces: `generate_weekly_report(db_path, reference_date=None, config=..., tz: tzinfo = timezone.utc)` 新增可选 `tz`。
- 逻辑：查询仍取范围内的原始行，`day = dt.astimezone(tz).date()` 在 Python 分组；`fetch_weekly_metrics` 先算每个 host 每个本地日的均值，再对日均值求周均值（`sample_count` 仍为原始样本数）。

- [ ] **Step 1: 写失败测试**

- `test_local_day_boundary`：样本 `2026-07-06 23:30Z` 与 `2026-07-07 00:30Z`，`tz=ZoneInfo("Asia/Shanghai")`，daily_points 落到两个不同本地日（07-07、07-07? 注意 23:30Z=07-07 07:30，00:30Z=07-08 08:30）→ 断言两天。
- `test_weekly_average_of_daily_means`：day1 两条 cpu 100/100，day2 一条 cpu 0 → 周均值 50（不是 66.7），`sample_count==3`。
- `test_default_tz_keeps_existing_behavior`：不传 tz 时与旧测试一致。

- [ ] **Step 2–5:** 确认失败 → 实现 → `pytest tests/test_storage.py tests/test_storage_local_time.py tests/test_weekly_report.py tests/test_report_weekly.py -v` PASS（旧报告测试不能回归）→ 提交 `feat(report): local-timezone daily aggregation`。

---

### Task 10: Web 应用工厂、鉴权与 JSON API

**Files:**
- Create: `servermonitor-main/servermonitor-main/servermanage/web/__init__.py`
- Create: `servermonitor-main/servermonitor-main/servermanage/web/routes.py`
- Test: `servermonitor-main/servermonitor-main/tests/test_web_api.py`

**Interfaces:**
- Produces: `create_app(*, config: AppConfig, db_path: Path) -> Flask`（设置 `app.secret_key`，注册路由，`config`/`db_path` 挂到 `app.config`）。
- 路由（返回 JSON）：
  - `GET /api/overview` → `{"summary":{"online":int,"offline":int,"active_alerts":int},"hosts":[{"name","host","online":bool,"collected_at","cpu_percent","memory_percent","disk_percent","gpu_memory_percent","disk_health":{"status":str,"healthy":int,"warning":int,"critical":int}}]}`
  - `GET /api/host/<name>` → `{"name","host","collected_at","success","metrics":dict,"disk":{...}}`（无快照 404）
  - `GET /api/alerts?status=active` → `{"alerts":[...]}`
  - `POST /api/alerts/<int:alert_id>/ack` → `{"ok": true}`
  - `POST /login`（表单 `username`/`password`）→ 成功 302 到 `/`，失败重渲染 401；`GET /login` 页面；`POST /logout`。
- 鉴权：`@app.before_request` 放行 `/login`、`/static/*`；未登录时 `/api/*` 返回 401 JSON，其它路径 302 到 `/login`。

- [ ] **Step 1: 写失败测试**

`tests/test_web_api.py` 用临时 db 写入一条 host 快照、一条磁盘报告、一条 alert；`config` 用构造好的 `AppConfig`（`dashboard.auth.password="pw"`, `session_secret="s"`）：
- `test_api_requires_login`：未登录 `GET /api/overview` 401。
- `test_login_and_overview`：错误密码 401；正确密码后 `GET /api/overview` 200 且有该 host。
- `test_host_detail_and_alerts`：`/api/host/<name>` 200 含 `metrics`；`/api/alerts` 含 1 条。
- `test_ack_alert`：POST ack 后 `list_alerts(status="active")` 不含该条。

- [ ] **Step 2–5:** 确认失败 → 实现 → `pytest tests/test_web_api.py -v` PASS → 提交 `feat(web): app factory, auth, JSON API`。

---

### Task 11: Web 页面模板与静态轮询

**Files:**
- Create: `servermonitor-main/servermonitor-main/servermanage/web/templates/base.html`
- Create: `.../templates/login.html`、`overview.html`、`host.html`、`alerts.html`、`settings.html`
- Create: `.../web/static/style.css`、`.../web/static/app.js`
- Modify: `.../web/routes.py`（页面路由）
- Test: `servermonitor-main/servermonitor-main/tests/test_web_pages.py`

**Interfaces:**
- 页面路由：`GET /`（overview）、`GET /host/<name>`、`GET /alerts`、`GET /settings`；均要求登录。
- `settings` 页只读展示 `app.timezone`、`poll_interval_seconds`、`disk_poll_interval_seconds`、报告归属（`report.daily_enabled`/`weekly.enabled` → “PC/关闭”）。
- `app.js`：每 30s `fetch('/api/overview')` 与 `/api/alerts?status=active` 刷新 DOM；无构建链。

- [ ] **Step 1: 写失败测试**

- `test_overview_page_contains_host`：登录后 `GET /` 200，HTML 含 host 名与“概览”。
- `test_host_page_has_disk_section`：`GET /host/<name>` 含“磁盘阵列”与盘型号。
- `test_settings_shows_poll_interval`：含 `600` 与 `Asia/Shanghai`。
- `test_static_css_served`：`GET /static/style.css` 200。

- [ ] **Step 2–5:** 确认失败 → 实现最小模板/样式 → `pytest tests/test_web_pages.py -v` PASS → 提交 `feat(web): dashboard pages and live polling`。

---

### Task 12: 服务入口与整体编排

**Files:**
- Create: `servermonitor-main/servermonitor-main/servermanage/app.py`
- Create: `servermonitor-main/servermonitor-main/servermanage/__main__.py`
- Test: `servermonitor-main/servermonitor-main/tests/test_app_service.py`

**Interfaces:**
- Produces（`app.py`）:
  - `configure_logging(log_dir: Path) -> None`（滚动文件 + 控制台）
  - `load_runtime(config_path: Path, dotenv_path: Path | None) -> tuple[AppConfig, Path]`（加载 dotenv→config→`disk_path=config.storage.db_path`，`init_storage`）
  - `class MonitorService: __init__(self, config: AppConfig, *, db_path: Path, collect_status=collect_all_hosts, collect_disk=collect_disk_health, notifier=None, clock=...)`；`run_once(self) -> dict`；`start(self)`；`stop(self)`
  - `main(argv: Sequence[str] | None = None) -> int`（CLI `--config` `--dotenv`；启动 Scheduler 线程 + `waitress.serve(create_app(...))`）
- `run_once` 顺序：`collect_status(config)` → 每台 `save_host_snapshot` + `persist_host_reports` → `evaluate_system_alerts` → 每台 `collect_disk_health` → `save_disk_health` → `evaluate_disk_alerts` → `AlertEngine.process` → 返回 `{"hosts": n, "disk_reports": n, "alerts": n}`。

- [ ] **Step 1: 写失败测试**

`tests/test_app_service.py`：用假 `collect_status` 返回一个成功 `HostReport`、假 `collect_disk` 返回一个 warning 盘报告、`FakeNotifier`；调用 `service.run_once()`，断言返回 `alerts==1`、DB 有 host 快照与磁盘行、`FakeNotifier` 收到 1 次；再调用 `main(["--help"])` 退出码 0。

- [ ] **Step 2–5:** 确认失败 → 实现 → `pytest tests/test_app_service.py -v` PASS → 提交 `feat(app): service orchestration and entrypoint`。

---

### Task 13: 打包脚本、启动器与示例配置

**Files:**
- Create: `servermonitor-main/servermonitor-main/packaging/servermonitor.spec`
- Create: `.../packaging/build.ps1`
- Create: `.../启动.bat`、`.../停止.bat`、`.../注册开机自启.ps1`
- Create: `.../config/config.yaml.example`、`.../config/.env.example`
- Modify: `servermonitor-main/servermonitor-main/README.md`
- Test: `servermonitor-main/servermonitor-main/tests/test_config_example.py`

**Interfaces:**
- `servermonitor.spec`：`Analysis(['servermanage/__main__.py'], datas=[('servermanage/web/templates','servermanage/web/templates'),('servermanage/web/static','servermanage/web/static'),('servermanage/templates','servermanage/templates')])`，`EXE(... name='servermonitor')`，`COLLECT(... name='servermonitor')`。
- `config.yaml.example` 含 `app/dashboard/alerts/disk_health/smtp/ssh/report/storage/servers` 全段（贴近设计第六节）；`.env.example` 列出 `SMTP_PASSWORD`、`DASHBOARD_PASSWORD`、`DASHBOARD_SECRET`、`ALERT_WEBHOOK_URL`、各主机密码变量。
- `build.ps1`：`pip install -e ".[build]"` 后 `pyinstaller packaging/servermonitor.spec --noconfirm`，产物 `dist/servermonitor/servermonitor.exe`。

- [ ] **Step 1: 写测试**

`tests/test_config_example.py`：读取 `config/config.yaml.example`，`monkeypatch` 设置所需环境变量（示例里的 `*_env` 变量给占位值；key 认证改为示例 password 或跳过 key 存在性），断言 `load_config` 成功且 `cfg.dashboard.port==8080`、`cfg.alerts.thresholds.disk_temperature_c==55`、`len(cfg.servers)>=1`。

- [ ] **Step 2–4:** 确认失败 → 写示例/脚本 → `pytest tests/test_config_example.py -v` PASS。

- [ ] **Step 5: 打包验证（手动/CI）**

Run: `pwsh packaging/build.ps1`
Expected: 生成 `dist/servermonitor/servermonitor.exe`；把 `config/`、`data/`、`logs/`、`启动.bat` 拷入产物目录后双击可启动看板（记录到 README）。

- [ ] **Step 6: 提交**

```bash
git add packaging config README.md 启动.bat 停止.bat 注册开机自启.ps1 tests/test_config_example.py
git commit -m "build: PyInstaller onedir package and launchers"
```

---

### Task 14: 端到端集成冒烟

**Files:**
- Test: `servermonitor-main/servermonitor-main/tests/test_integration_smoke.py`

**Interfaces:**
- Consumes: 全部模块；使用 `FakeRunner`（返回 Task 3 fixtures 对应的命令输出）与真实的 `collect_disk_health`/`AlertEngine`/`create_app`。

- [ ] **Step 1: 写测试**

`test_full_cycle_with_mock_ssh`：临时 db；`MonitorService` 注入：`collect_status` 返回 4 台成功报告、`collect_disk` 用 `FakeRunner` 走真实的 `collect_disk_health`（a100 fixture），`notifier` 记录；`run_once()` 后断言：4 条 host 快照、21 块 pd 行、`GET /api/overview`（登录后）4 台、至少 1 条磁盘健康摘要；`purge_old_data` 不删今天数据。

- [ ] **Step 2–4:** 确认失败（若已通过说明缺少断言，补断言）→ `pytest tests/test_integration_smoke.py -v` PASS。

- [ ] **Step 5: 全量回归**

Run: `pytest -v`
Expected: 全部 PASS（含原有 12 个测试文件新增测试）。

- [ ] **Step 6: 提交**

```bash
git add tests/test_integration_smoke.py
git commit -m "test: end-to-end polling/disk/alert smoke"
```

---

## Self-Review（写完计划后的核对）

- **Spec 覆盖**：设计 1–19 节 → 配置(T1)、存储(T2)、storcli(T3)、健康判定+采集(T4)、告警规则(T5)、去重冷却(T6)、通知(T7)、调度 catch-up(T8)、时区聚合(T9)、Web+鉴权(T10/T11)、入口编排(T12)、打包(T13)、真实样本回归(T14)。无遗漏章节；非目标（agent/多租户/GUI/自动修复）不建任务。
- **Review Focus 落点**：第 1 条→T4 `test_collect_permission_denied`/`no_storcli`；第 2 条→T3 `test_parse_4090_two_controllers`+T4 `test_collect_ok_multi_controller`；第 3 条→T3 `test_parse_temperature_variants`+T4 `test_temperature_threshold`；第 4 条→T6 `test_cooldown_survives_restart`/`test_error_increase_breaks_cooldown`；第 5 条→T10 `test_api_requires_login`/`test_login_and_overview`。
- **类型一致性**：`DiskHealthReport/PhysicalDriveInfo/AlertEvent` 在 T3 定义，T4/T5/T6/T12 引用同名同字段；`save_disk_health/get_disk_health/insert_alert/find_latest_alert/update_alert/list_alerts/get_task_state/set_task_state/purge_old_data` 在 T2 定义并被 T6/T9/T10/T12 调用；`collect_disk_health` 签名 T4 定义并被 T12 注入。
- **比例**：只给签名/测试与判定表；算法体仅在解析与判定处给出必要规则，未逐行抄代码。
