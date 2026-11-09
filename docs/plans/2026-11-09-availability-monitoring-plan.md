# Availability Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为服务器轮询监测工具增加服务可用性检查、按主机告警阈值/连续周期，以及按主机 sudo 密码通道，发布 v0.2.0。

**Architecture:** 在现有 `HostConfig`/`HostReport` 数据模型上增加 `checks`、`alert_rules`、`sudo_password`，新增 `host_check_snapshot` 表、`availability.py` 检查执行模块和 `run_sudo` SSH 通道；告警引擎按主机有效阈值和连续周期过滤，前端在设置页编辑检查项、在概览/主机详情/报告中展示结果。

**Tech Stack:** Python 3.11+、SQLite、paramiko、Flask/Jinja、原生 JS、Electron、pytest、Node test runner。

**Spec:** `docs/plans/2026-11-09-availability-monitoring-design.md`

## Global Constraints

- 版本号最终统一为 `0.2.0`；三个版本文件必须同步：`pyproject.toml`、`desktop/package.json`、`servermanage/__init__.py`。
- 不新增第三方依赖；沿用 paramiko、SQLite、Flask 和原生 JS。
- sudo 密码绝不能出现在 command、日志、异常文本、API 响应、CSV/JSON 导出或 dataclass repr 中。
- 检查命令必须在目标主机执行，复用现有 SSH 连接；不得增加新的 SSH 连接。
- 连续异常周期默认 2；允许 1..10，主机级可覆盖。
- 每台主机最多 20 个检查项；单个检查失败不能导致整台主机采集失败。
- 所有测试从 `servermonitor-main/servermonitor-main` 目录运行；全量 `python -m pytest -q` 和 `node --test desktop/test/*.test.js` 必须通过。
- 旧 YAML/旧 SQLite 数据必须可直接启动，无需手工迁移。

## Review Focus

1. **HTTP/TCP 检查 target 注入**：URL 中的 `$(...)`、反引号、分号、管道、userinfo，以及 TCP host 中的引号，必须被拒绝或安全 quote；对应测试在 Task 4。
2. **主机离线时的假恢复**：离线主机不得产生 availability 事件，也不得把既有可用性告警 resolve；对应测试在 Task 6。
3. **storcli 大输出导致 run_sudo 死锁**：必须先读 stdout/stderr 再取 exit status；对应测试在 Task 3。
4. **sudo 密码泄露**：serialization/log/API/异常均不得出现密码；对应测试在 Task 1、Task 3、Task 7。
5. **编辑主机/删除主机导致数据丢失**：编辑其它字段不能清空 checks/alert_rules；删除主机必须级联删除 host_check_snapshot；对应测试在 Task 1、Task 2。

---

### Task 1: 模型、配置与设置持久化

**Files:**
- Modify: `servermanage/models.py:20-41,129-160`
- Modify: `servermanage/config.py:328-341`
- Modify: `servermanage/settings.py:489-573,575-590,834-997`
- Modify: `servermanage/serialization.py:20-43`
- Test: `tests/test_settings_hosts.py`
- Test: `tests/test_host_checks_config.py` (create)

**Interfaces:**
- Produces: `HostCheckConfig(name: str, type: str, target: str, timeout_seconds: int = 5, expected: str | None = None, enabled: bool = True)`
- Produces: `HostAlertRules(cpu_percent: float | None = None, memory_percent: float | None = None, disk_percent: float | None = None, gpu_memory_percent: float | None = None, disk_temperature_c: float | None = None, consecutive_periods: int | None = None)`
- Produces: `HostCheckResult(name: str, type: str, target: str, status: str, message: str, latency_ms: float | None = None, checked_at: datetime | None = None)`
- Produces: `HostConfig.checks: list[HostCheckConfig]`、`HostConfig.alert_rules: HostAlertRules | None`、`HostConfig.sudo_password: str | None`（metadata sensitive）
- Produces: `AlertsConfig.consecutive_periods: int = 2`
- Produces: `settings._validate_alert_rules(rules: dict | None) -> dict | None`
- Produces: `settings._sanitize_host_checks(raw: object) -> list[dict]`：名称唯一（casefold）≤64、每主机 ≤20、`timeout_seconds=int()` 1..30、`type` 合法、`expected` 匹配 `^\d{3}(-\d{3})?$`
- Produces: `ServerSettings.upsert_host` 接受 `checks`/`alert_rules`/`sudo_password`，`_public_host_entry` 返回 `sudo_configured`、`checks`、`alert_rules`
- Produces: `copy_host`、`delete_host`、`_reset_secrets_for_machine` 都处理 `sudo_password`；`upsert_host` 的 `checks`/`alert_rules` 缺省键保留 existing，键存在才覆盖
- Consumes: existing `_store_secret`/`get_secret`/`delete_secret`

- [ ] **Step 1: Write failing model/config tests**

```python
def test_host_config_defaults_for_checks_and_sudo():
    host = make_host()
    assert host.checks == []
    assert host.alert_rules is None
    assert host.sudo_password is None


def test_yaml_load_parses_checks_alert_rules_and_sudo_env(tmp_path, monkeypatch):
    monkeypatch.setenv("LAB_GPU01_SUDO_PASSWORD", "s3cret")
    config = load_config_from_yaml(path_with_checks)
    host = config.servers[0]
    assert host.checks[0].name == "训练 API"
    assert host.checks[0].type == "http"
    assert host.alert_rules.cpu_percent == 95
    assert host.alert_rules.consecutive_periods == 3
    assert host.sudo_password == "s3cret"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest -q tests/test_host_checks_config.py tests/test_settings_hosts.py -k "checks or sudo"`
Expected: FAIL with missing `HostCheckConfig` / unexpected keyword `checks`.

- [ ] **Step 3: Implement models and YAML loader**

Add the three dataclasses in `servermanage/models.py`; add fields to `HostConfig`, `HostReport`, `AlertsConfig`. In `config.py:_load_host`, parse `checks`、`alert_rules`、`sudo_password_env` (env var read) and direct `sudo_password` (local compatibility; env 优先), keep old configs defaulting to `[]`/`None`; validate each YAML check at load time (`int(timeout_seconds)` 1..30、name 唯一≤64、expected 格式)，非法配置抛 `ConfigError`；in `_load_alerts` parse global `alerts.consecutive_periods` (default 2, 1..10).

- [ ] **Step 4: Write failing settings persistence tests**

`host_payload(**kwargs)` must include only the keys explicitly passed (plus required baseline `name/host/port/username`), so `host_payload(notes="second")` omits `checks`/`alert_rules` and truly exercises “key absent → preserve existing”.

```python
def test_upsert_host_persists_checks_and_preserves_them_when_editing_notes(tmp_path):
    service = make_settings(tmp_path)
    service.upsert_host("gpu-01", host_payload(
        notes="first",
        checks=[{"name": "API", "type": "http", "target": "http://127.0.0.1:8000/health"}],
        alert_rules={"cpu_percent": 95, "consecutive_periods": 3},
    ))
    service.upsert_host("gpu-01", host_payload(notes="second"))
    host = service.get_host("gpu-01")
    assert host["notes"] == "second"
    assert host["checks"][0]["name"] == "API"
    assert host["alert_rules"]["cpu_percent"] == 95


def test_sudo_password_is_write_only_and_clearable(tmp_path):
    service = make_settings(tmp_path)
    service.upsert_host("gpu-01", host_payload(sudo_password="pw"))
    assert service.get_host("gpu-01")["sudo_configured"] is True
    assert "pw" not in json.dumps(service.public_settings())
    service.upsert_host("gpu-01", host_payload(clear_secrets=["sudo_password"]))
    assert service.get_host("gpu-01")["sudo_configured"] is False


def test_host_config_sudo_password_not_serialized():
    payload = dump_json(make_host(sudo_password="pw"))
    assert "pw" not in payload
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `python -m pytest -q tests/test_settings_hosts.py -k "checks or sudo or serialized"`
Expected: FAIL on unknown fields / `sudo_configured` missing.

- [ ] **Step 6: Implement settings persistence and serialization**

Add `_HOST_SECRET_SUDO_PASSWORD`; `_apply_host_sudo_password`（校验无换行、≤256，写入/清除）；include checks/alert_rules in entry rebuild with 缺省保留/显式覆盖 semantics; ensure `_settings_snapshot`/`_host_entry_from_config`/`_build_servers`/`_public_host_entry` round-trip them. Implement `_validate_alert_rules`（CPU/内存/磁盘/GPU 1..100、温度 1..120、`consecutive_periods` 1..10）and `_sanitize_host_checks`（timeout int 1..30、名称唯一≤64、≤20 项）called from `upsert_host`. Update `delete_host`/`copy_host`/`_reset_secrets_for_machine` for sudo secret; copy checks/alert_rules. Change `to_jsonable` to iterate dataclass fields and skip `field.metadata.get("sensitive")`; replace `asdict`-based host serialization in `report.py` and audit routes asdict sites if needed.

- [ ] **Step 7: Run tests and commit**

Run: `python -m pytest -q tests/test_host_checks_config.py tests/test_settings_hosts.py`
Expected: PASS.
```bash
git add servermanage/models.py servermanage/config.py servermanage/settings.py servermanage/serialization.py servermanage/report.py tests/test_host_checks_config.py tests/test_settings_hosts.py
git commit -m "feat: add availability models and per-host settings"
```

---

### Task 2: host_check_snapshot 存储

**Files:**
- Modify: `servermanage/storage.py` (schema init + new functions near existing alert storage)
- Test: `tests/test_host_checks_storage.py` (create)

**Interfaces:**
- Consumes: `HostCheckResult` from Task 1
- Produces: `save_host_check_results(host_name: str, results: Sequence[HostCheckResult], db_path: Path) -> None`
- Produces: `get_host_check_results(host_name: str, db_path: Path) -> list[dict]`
- Produces: `delete_host_check_results(host_name: str, db_path: Path) -> None`

- [ ] **Step 1: Write failing storage tests**

```python
def test_save_read_and_overwrite_check_results(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    save_host_check_results("gpu-01", [result("API", "ok", 12.5)], db)
    assert get_host_check_results("gpu-01", db)[0]["status"] == "ok"
    save_host_check_results("gpu-01", [result("API", "failed", 20.0)], db)
    rows = get_host_check_results("gpu-01", db)
    assert len(rows) == 1
    assert rows[0]["status"] == "failed"


def test_delete_host_check_results_is_cascade_ready(tmp_path):
    ...
    delete_host_check_results("gpu-01", db)
    assert get_host_check_results("gpu-01", db) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest -q tests/test_host_checks_storage.py`
Expected: FAIL with missing `save_host_check_results`.

- [ ] **Step 3: Implement table and functions**

Add the `host_check_snapshot` table and index from design §3.2. Use one `BEGIN IMMEDIATE` transaction to delete + insert. Return rows ordered by `check_name`.

- [ ] **Step 4: Wire delete_host cascade**

In `ServerSettings.delete_host`, after deleting secrets and host entry, call `storage.delete_host_check_results(name, self.db_path)`; add test to `tests/test_settings_hosts.py` asserting rows are gone.

- [ ] **Step 5: Run tests and commit**

Run: `python -m pytest -q tests/test_host_checks_storage.py tests/test_settings_hosts.py`
Expected: PASS.
```bash
git add servermanage/storage.py servermanage/settings.py tests/test_host_checks_storage.py tests/test_settings_hosts.py
git commit -m "feat: persist per-host check snapshots"
```

---

### Task 3: SSH run_sudo 与磁盘健康/探测接入

**Files:**
- Modify: `servermanage/ssh_client.py:111-119`
- Modify: `servermanage/disk_health.py:803-807,826,842-863,904-921`
- Modify: `servermanage/host_probe.py:242-251`
- Modify: `servermanage/models.py` if `CommandResult` needs no change
- Test: `tests/test_sudo.py` (create)

**Interfaces:**
- Produces: `SudoAuthError(Exception)`、`SudoUnavailable(Exception)`
- Produces: SSH 客户端包装类的 `run_sudo(command: str, timeout: int) -> CommandResult`
- Consumes: `HostConfig.sudo_password` from Task 1
- Produces: `disk_health._run_privileged(runner, command, timeout, use_sudo) -> CommandResult`

- [ ] **Step 1: Write failing SSH sudo tests**

```python
def test_run_sudo_writes_password_to_stdin_not_command(fake_client):
    wrapper = make_ssh_wrapper(host=make_host(sudo_password="pw"), fake_client=fake_client)
    result = wrapper.run_sudo("storcli /c0 show all", 30)
    assert "pw" not in fake_client.exec_command_calls[0][0]
    assert fake_client.stdin_written == "pw\n"
    assert result.exit_status == 0


def test_run_sudo_reads_output_before_exit_status(fake_channel):
    # fake records call order; assert stdout.read/stderr.read happen before recv_exit_status
    ...
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest -q tests/test_sudo.py`
Expected: FAIL with missing `run_sudo` / `SudoAuthError`.

- [ ] **Step 3: Implement run_sudo**

Use `exec_command("sudo -S -p '' " + command)`, write password + "\n", shutdown write, read stdout/stderr first, then `recv_exit_status`. **Also refactor existing `run()` to read stdout/stderr first before `recv_exit_status`** (shared helper). Detect `incorrect password`/`Sorry, try again`. Raise with `from None`. No password in messages.

- [ ] **Step 4: Write failing disk health/probe tests**

```python
def test_collect_disk_health_maps_bad_sudo_password_to_permission_denied(monkeypatch):
    runner = FakeRunner(run_sudo=SudoAuthError("sudo 密码错误"))
    # drive collect_disk_health's probe path with use_sudo=True
    ...
    assert result.status == "permission_denied"
    assert "sudo 密码错误" in result.message


def test_probe_uses_run_sudo_when_available():
    ...
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `python -m pytest -q tests/test_sudo.py -k "disk or probe"`
Expected: FAIL.

- [ ] **Step 6: Implement privileged runner and probe support**

Add `_run_privileged` in `disk_health.py` as the single call path (cover the four current privilege sites ~826/851/904/921). Catch `SudoAuthError`/`SudoUnavailable` explicitly before generic exceptions in `collect_disk_health`'s probe block (~822-926; there is no `_probe_storcli` function). Update messages at 842/863. Add `run_sudo` to `ProbeRunner` protocol and pass candidate `sudo_password` through `host_probe._build_host_config`/`routes._host_config_from_payload`; legacy fakes without `run_sudo` fall back to `sudo -n` via read-first `run()`.

- [ ] **Step 7: Run tests and commit**

Run: `python -m pytest -q tests/test_sudo.py tests/test_disk_health.py tests/test_host_probe.py`
Expected: PASS.
```bash
git add servermanage/ssh_client.py servermanage/disk_health.py servermanage/host_probe.py tests/test_sudo.py
git commit -m "feat: add sudo password channel for privileged checks"
```

---

### Task 4: availability.py 检查执行

**Files:**
- Create: `servermanage/availability.py`
- Test: `tests/test_availability.py` (create)

**Interfaces:**
- Consumes: `HostCheckConfig`、`HostCheckResult`、`CommandResult`
- Produces: `build_check_command(check: HostCheckConfig) -> str`
- Produces: `parse_check_result(check: HostCheckConfig, result: CommandResult) -> HostCheckResult`
- Produces: `run_host_checks(host: HostConfig, runner: CommandRunner, checks: list[HostCheckConfig], command_timeout: int) -> list[HostCheckResult]`

- [ ] **Step 1: Write failing command construction tests**

```python
def test_http_url_with_shell_metacharacters_is_rejected():
    with pytest.raises(ValueError):
        build_check_command(HostCheckConfig(name="bad", type="http", target="http://x/$(id)"))


def test_tcp_target_rejects_quotes():
    with pytest.raises(ValueError):
        build_check_command(HostCheckConfig(name="bad", type="tcp", target="22'; id; '"))


def test_timeout_seconds_injection_is_rejected():
    with pytest.raises(ValueError):
        build_check_command(HostCheckConfig(name="bad", type="http", target="http://127.0.0.1:8000/health", timeout_seconds="5; rm -rf /"))


def test_http_command_quotes_url():
    cmd = build_check_command(HostCheckConfig(name="api", type="http", target="http://127.0.0.1:8000/health"))
    assert "curl -sS" in cmd
    assert "http://127.0.0.1:8000/health" in cmd
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest -q tests/test_availability.py`
Expected: FAIL with missing module.

- [ ] **Step 3: Implement validation and command builder**

Implement four check types and validation from design §5. `timeout_seconds = int()` 1..30 and render integer only; reject userinfo/`?`/`#`/whitespace/control/backtick/`$(`/`;`/`|`/`&` in HTTP, validate TCP host/port (IPv6 `rsplit` + `ip_address`), exact process/service regex, `shlex.quote` all interpolated values.

- [ ] **Step 4: Write failing parse/run tests**

```python
def test_http_500_is_failed_and_000_is_error():
    failed = parse_check_result(http_check, CommandResult("500 0.12", "", 0))
    error = parse_check_result(http_check, CommandResult("000 0.00", "", 0))
    assert failed.status == "failed"
    assert error.status == "error"


def test_one_check_failure_does_not_abort_others():
    results = run_host_checks(host, FakeRunner({...}), [bad_check, good_check], 10)
    assert [r.status for r in results] == ["failed", "ok"]
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `python -m pytest -q tests/test_availability.py`
Expected: FAIL on parse.

- [ ] **Step 6: Implement parsing and runner loop**

Follow design §5 status mapping; catch per-check exceptions and return `error` for that check only.

- [ ] **Step 7: Run tests and commit**

Run: `python -m pytest -q tests/test_availability.py`
Expected: PASS.
```bash
git add servermanage/availability.py tests/test_availability.py
git commit -m "feat: add availability check execution"
```

---

### Task 5: Collector 与 run_status_once 接入

**Files:**
- Modify: `servermanage/collectors.py:100-125`
- Modify: `servermanage/app.py:406-412,460-549`
- Modify: `servermanage/models.py` (`HostReport.checks`)
- Test: `tests/test_collectors.py`

**Interfaces:**
- Consumes: `run_host_checks` from Task 4; `save_host_check_results` from Task 2
- Produces: `HostReport.checks: list[HostCheckResult]`
- Produces: `run_status_once` 保存成功主机的检查结果；失败主机检查置 `unknown`

- [ ] **Step 1: Write failing collector test**

```python
def test_collect_host_report_includes_check_results(monkeypatch):
    report = collect_host_report(host_with_checks, runner)
    assert report.checks[0].name == "API"
    assert report.checks[0].status == "ok"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest -q tests/test_collectors.py -k checks`
Expected: FAIL.

- [ ] **Step 3: Implement collector integration**

After metrics parse, call `run_host_checks`; ensure exceptions inside checks do not mark host failed. In `run_status_once`, after successful report, `save_host_check_results`; for failed host, build `unknown` results for configured checks and save them.

- [ ] **Step 4: Run tests and commit**

Run: `python -m pytest -q tests/test_collectors.py`
Expected: PASS.
```bash
git add servermanage/collectors.py servermanage/app.py servermanage/models.py tests/test_collectors.py
git commit -m "feat: collect and persist host service checks"
```

---

### Task 6: 告警规则与连续周期

**Files:**
- Modify: `servermanage/alerts.py:99-206,661+`
- Modify: `servermanage/app.py:406-549`
- Modify: `servermanage/models.py` if needed
- Test: `tests/test_alert_rules.py`
- Test: `tests/test_app_service.py` or existing service test

**Interfaces:**
- Produces: `evaluate_availability_alerts(host_name: str, results: list[HostCheckResult]) -> list[AlertEvent]`
- Produces: `AlertEngine.open_alert_fingerprints(host_name: str, *, category: str | None = None) -> set[str]`（读 open alerts 的 fingerprint）
- Produces: `MonitorService._alert_streaks: dict[tuple[str,str], int]`、`_clear_streaks: dict[tuple[str,str], int]`、`_streak_lock`（仅 `run_status_once` 使用）、`_effective_periods(host_name)`
- Consumes: `HostConfig.alert_rules` from Task 1

- [ ] **Step 1: Write failing alert tests**

```python
def test_host_threshold_overrides_global():
    thresholds = effective_thresholds(global_t=90, host_rules=HostAlertRules(cpu_percent=95))
    assert thresholds.cpu_percent == 95
    assert thresholds.memory_percent == 90


def test_availability_alert_fingerprint_and_recovery():
    events = evaluate_availability_alerts("gpu-01", [failed_check("API")])
    assert events[0].category == "availability"
    assert events[0].fingerprint == fingerprint_for("availability", "gpu-01", "API")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest -q tests/test_alert_rules.py -k "availability or threshold"`
Expected: FAIL.

- [ ] **Step 3: Write failing streak-state tests**

```python
def test_alert_requires_consecutive_periods(service):
    service.run_status_once(metrics_cpu_99)  # 1st
    assert service.active_alerts == []
    service.run_status_once(metrics_cpu_99)  # 2nd
    assert len(service.active_alerts) == 1


def test_offline_host_does_not_resolve_availability_alerts(service):
    service.run_status_once(successful_with_failed_check)
    service.run_status_once(host_offline=True)
    assert service.active_alerts  # still open


def test_availability_alert_resolves_after_consecutive_good_periods(service):
    service.run_status_once(successful_with_failed_check)  # 1st bad
    service.run_status_once(successful_with_failed_check)  # open
    assert any(a.category == "availability" for a in service.active_alerts)
    service.run_status_once(successful_with_ok_check)      # good 1, still open
    assert any(a.category == "availability" for a in service.active_alerts)
    service.run_status_once(successful_with_ok_check)      # good 2 -> resolve
    assert not any(a.category == "availability" for a in service.active_alerts)


def test_bad_good_bad_restarts_streak(service):
    service.run_status_once(metrics_cpu_99)  # bad 1
    service.run_status_once(metrics_cpu_50)  # good -> streak 0, clear 1
    service.run_status_once(metrics_cpu_99)  # bad 1 again, must NOT alert yet
    assert service.active_alerts == []


def test_recovery_requires_consecutive_good_periods(service):
    service.run_status_once(metrics_cpu_99)  # 1
    service.run_status_once(metrics_cpu_99)  # alert
    service.run_status_once(metrics_cpu_50)  # good 1, still active
    assert service.active_alerts
    service.run_status_once(metrics_cpu_50)  # good 2 -> resolve
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `python -m pytest -q tests/test_app_service.py -k "consecutive or offline"`
Expected: FAIL.

- [ ] **Step 5: Implement alerting**

Add `evaluate_availability_alerts`; add `effective_thresholds`/`_effective_periods` helpers for loop use. Implement `_alert_streaks`/`_clear_streaks` exactly per design §7.2, keyed by `(host, fingerprint)`: `present_by_host` vs `ready_events`; compute `seen_keys = {keys for this host} | {(host, fp) for fp in previous_open_fps}` and `absent_keys = seen_keys - present_keys`; for every absent key set `_alert_streaks[key]=0` and `_clear_streaks[key]+=1` (this includes fingerprints that were never open); build per-category `remaining = {fp for fp in open_fps if fp in present or _clear_streaks.get((host, fp), 0) < periods}` and call `resolve_missing(host, remaining, category=cat)`; skip offline hosts entirely. **After both category loops**, use cross-category `still_open = engine.open_alert_fingerprints(host)` to clean keys for this host with `fp not in still_open and _clear_streaks[(host,fp)] >= periods`; never clean inside the per-category loop (otherwise availability clear counters get popped before its resolve, and availability alerts never close). Add `AlertEngine.open_alert_fingerprints`. Disk health alerts remain immediate.

- [ ] **Step 6: Run tests and commit**

Run: `python -m pytest -q tests/test_alert_rules.py tests/test_app_service.py`
Expected: PASS.
```bash
git add servermanage/alerts.py servermanage/app.py servermanage/models.py tests/test_alert_rules.py tests/test_app_service.py
git commit -m "feat: add per-host thresholds and consecutive alert periods"
```

---

### Task 7: 设置 API 与主机编辑 UI

**Files:**
- Modify: `servermanage/web/routes.py:1936-1970,2252-2266,2320-2342`
- Modify: `servermanage/web/templates/settings.html:131-162`
- Modify: `servermanage/web/static/settings.js:194-300`
- Test: `tests/test_settings_api.py`
- Test: `tests/test_settings_page.py`

**Interfaces:**
- Consumes: Task 1 settings service
- Produces: `PUT /api/settings/hosts/<name>` accepts `sudo_password`、`checks`、`alert_rules`
- Produces: `GET /api/settings` hosts 返回 `sudo_configured`、`checks`、`alert_rules`；alerts 返回 `consecutive_periods`
- Produces: 现有告警设置保存接口接受全局 `consecutive_periods`（1..10）
- Produces: `POST /api/settings/hosts/<name>/checks/test`

- [ ] **Step 1: Write failing API tests**

```python
def test_save_host_checks_and_sudo_password(client):
    response = client.put("/api/settings/hosts/gpu-01", json=host_payload(
        checks=[{"name": "API", "type": "http", "target": "http://127.0.0.1:8000/health"}],
        alert_rules={"cpu_percent": 95, "consecutive_periods": 3},
        sudo_password="pw",
    ), headers=csrf_headers(client))
    assert response.status_code == 200
    body = client.get("/api/settings").get_json()
    host = body["hosts"][0]
    assert host["sudo_configured"] is True
    assert "pw" not in json.dumps(body)
    assert host["checks"][0]["name"] == "API"


def test_invalid_alert_rules_returns_400(client):
    response = client.put("/api/settings/hosts/gpu-01", json=host_payload(alert_rules={"cpu_percent": 101}), headers=csrf_headers(client))
    assert response.status_code == 400
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest -q tests/test_settings_api.py -k "checks or sudo or alert_rules"`
Expected: FAIL.

- [ ] **Step 3: Implement API**

Update `PUT` handler to pass fields to `upsert_host`; add `POST /api/settings/hosts/<name>/checks/test` that resolves an **already saved** host by `<name>` (404 if missing), builds a temporary HostConfig and calls `run_host_checks`; ensure no secrets in response. Do not accept connection credentials from the test request body. Audit `routes.py` `asdict` 调用（约 1383/2100/2118/2148/2192/2266）：凡涉及 HostConfig/导入候选/probe/collect 响应，改用 `to_jsonable` 或显式剔除 `sudo_password`，并加测试断言响应不含密码。

- [ ] **Step 4: Write failing UI tests**

```python
def test_host_form_contains_sudo_and_check_editor(client):
    html = client.get("/settings").get_data(as_text=True)
    assert 'data-host-field="sudo_password"' in html
    assert 'id="host-checks"' in html
    assert "添加检查" in html


def test_settings_js_submits_checks_and_rules(client):
    js = client.get("/static/settings.js").get_data(as_text=True)
    assert "hostPayload()" in js
    assert "sudo_password" in js
    assert "alert_rules" in js
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `python -m pytest -q tests/test_settings_page.py -k "sudo or checks"`
Expected: FAIL.

- [ ] **Step 6: Implement settings UI**

Add sudo field + `已配置/未配置` + clear checkbox; dynamic check rows with add/remove/test; alert rule inputs with shared 1..100/温度1..120/周期1..10 min/max; update `hostPayload()`/`openHostForm()`; adjust table colspan. 新增主机未保存时测试按钮提示“请先保存主机再测试”。Keep all values via `textContent`/DOM properties.

- [ ] **Step 7: Run tests and commit**

Run: `python -m pytest -q tests/test_settings_api.py tests/test_settings_page.py`
Expected: PASS.
```bash
git add servermanage/web/routes.py servermanage/web/templates/settings.html servermanage/web/static/settings.js tests/test_settings_api.py tests/test_settings_page.py
git commit -m "feat: edit host checks, thresholds and sudo password"
```

---

### Task 8: 概览、主机详情与报告展示

**Files:**
- Modify: `servermanage/web/routes.py` (`_host_row`, `_build_host_detail`, report builder)
- Modify: `servermanage/web/templates/hosts.html`
- Modify: `servermanage/web/templates/overview.html`
- Modify: `servermanage/web/templates/host.html`
- Modify: `servermanage/web/static/app.js` / `host-detail.js`
- Modify: `servermanage/report.py`
- Modify: `servermanage/models.py`（`WeeklyHostSummary.checks`）
- Modify: `servermanage/weekly.py`（读取当前 `host_check_snapshot` 填充 checks）
- Modify: `servermanage/templates/report_weekly.txt.j2`、`report_weekly.html.j2`
- Test: `tests/test_desktop_pages.py`
- Test: `tests/test_report.py`
- Test: `tests/test_report_weekly.py`

**Interfaces:**
- Consumes: `get_host_check_results` from Task 2
- Produces: `/api/host/<name>` 与 `/api/overview` 包含 checks；主机详情 `checks` 标签；报告 `[服务可用性]` 段
- Produces: `WeeklyHostSummary.checks: list[dict]`，周报用当前 `host_check_snapshot` 快照填充（非周历史），模板显示 ok/total

- [ ] **Step 1: Write failing page tests**

```python
def test_overview_and_host_pages_show_check_summary(client):
    overview = client.get("/api/overview").get_json()
    assert "checks" in overview["hosts"][0]
    html = client.get("/host/gpu-01").get_data(as_text=True)
    assert 'data-host-tab="checks"' in html
    assert "服务可用性" in html
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest -q tests/test_desktop_pages.py -k checks`
Expected: FAIL.

- [ ] **Step 3: Implement overview/host detail/report**

Add checks aggregation to `_host_row`; `_build_host_detail` returns stored results; add tab/table; include `[服务可用性]` in `_build_host_report`; add failed-check summary to daily email context (`HostReport.checks`); extend `WeeklyHostSummary` with `checks` and populate from current `host_check_snapshot` in `weekly.generate_weekly_report`, then render ok/total in both weekly templates. Do not claim weekly check history.

- [ ] **Step 4: Run tests and commit**

Run: `python -m pytest -q tests/test_desktop_pages.py tests/test_report.py`
Expected: PASS.
```bash
git add servermanage/web/routes.py servermanage/web/templates/hosts.html servermanage/web/templates/overview.html servermanage/web/templates/host.html servermanage/web/static/app.js servermanage/web/static/host-detail.js servermanage/report.py servermanage/models.py servermanage/weekly.py servermanage/templates/report_weekly.txt.j2 servermanage/templates/report_weekly.html.j2 tests/test_desktop_pages.py tests/test_report.py
git commit -m "feat: show service checks in dashboard and reports"
```

---

### Task 9: 版本、文档、全量测试与打包冒烟

**Files:**
- Modify: `pyproject.toml`、`desktop/package.json`、`servermanage/__init__.py`
- Modify: `README.md`、`使用说明.txt`
- Test: `tests/test_config_example.py`、`tests/test_launchers.py`

**Interfaces:**
- Produces: 版本 `0.2.0`，文档说明检查项、告警阈值、sudo 密码

- [ ] **Step 1: Bump version and update docs**

Run: `python tools/bump_version.py 0.2.0`; update version assertions and README/使用说明 (keep UTF-8 BOM).

- [ ] **Step 2: Run all tests**

Run: `python -m pytest -q`
Expected: PASS.
Run: `node --test desktop/test/*.test.js`
Expected: PASS.

- [ ] **Step 3: Build and verify package**

Run:
```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
powershell -File packaging/build-backend.ps1
powershell -File desktop/scripts/build-portable.ps1
powershell -File desktop/scripts/verify-package.ps1 -PackageZip "release/服务器轮询监测工具-Windows-x64-v0.2.0.zip"
```
Expected: backend 6.6+ MB, portable zip created, verify passed.

- [ ] **Step 4: Commit and release v0.2.0**

```bash
git add pyproject.toml desktop/package.json servermanage/__init__.py README.md 使用说明.txt tests/test_config_example.py tests/test_launchers.py
git commit -m "release: bump version to 0.2.0"
```
Then subtree split/push, `gh release create v0.2.0`, upload zip + sha, wait for Actions digest, install locally, smoke `/login`, host check display, sudo status, and verify auto-update 0.1.28→0.2.0.
