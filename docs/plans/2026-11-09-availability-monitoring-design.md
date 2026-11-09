# 0.2.0 可用性监控与按主机 sudo 密码设计

日期：2026-11-09

## 1. 目标

0.2.0 在现有“系统指标采集 + 磁盘健康 + 告警”的基础上，增加两块能力：

1. **服务可用性检查**：每台主机可以配置多个 TCP 端口、HTTP/HTTPS、进程、systemd 服务检查项；检查结果进入主机详情、概览和告警，失败告警、恢复通知。
2. **按主机 sudo 密码**：每台主机可以单独保存 sudo 密码，供 storcli 磁盘健康等必须提权的检查使用，不要求管理员账号在目标机上配置免密 sudo。

同时增强告警规则：支持按主机覆盖 CPU/内存/磁盘/GPU 显存/磁盘温度阈值，并支持“连续 N 个采集周期异常才告警”。

**不在 0.2.0 范围**：容量预测、定时 HTML 巡检报告、企业微信/钉钉/飞书、自定义命令检查、批量远程操作。这些放到 0.2.1 或后续版本。

## 2. 现状与约束

- 主机清单目前存在 `app_settings` 的 `hosts` section（`servermanage/settings.py:90-97`、`_read_host_entries`/`_save_host_entries`），SSH/私钥/私钥口令存在 `app_secrets`，通过 `host:{name}:*` 命名。
- `HostConfig` 只有 `auth`、`disk_mounts`、`disk_health` 等字段，没有 sudo 密码、检查项、告警规则字段（`servermanage/models.py:20-40`）。
- 每轮采集通过一条 SSH 连接执行命令（`servermanage/collectors.py:100-125`），SSH 客户端包装类的 `run` 使用 `client.exec_command(command)`，没有 stdin 写入能力（`servermanage/ssh_client.py:34-129`）。
- 系统告警在 `MonitorService.run_status_once` 中按全局 `config.alerts.thresholds` 评估（`servermanage/app.py:350-458`），`AlertEngine` 负责去重/冷却/持久化/通知（`servermanage/alerts.py:661-789`）。
- 磁盘健康目前用 `"sudo -n "` 前缀（`servermanage/disk_health.py:803-807`），无密码时直接失败，错误提示要求配置免密 sudo。
- 设置页主机表单字段在 `servermanage/web/templates/settings.html:131-162`，提交逻辑在 `servermanage/web/static/settings.js:194-300`。

约束：

- 所有 sudo 密码只能写、不能回显，不能出现在命令行参数、日志、异常文本或 HTTP 响应中。
- 检查项配置属于主机配置，必须支持导出/导入、复制主机、删除主机时一并处理。
- 不新增本机对目标服务端口的依赖：检查默认在目标主机上通过现有 SSH 连接执行，避免防火墙/绑定地址差异。
- 保持现有 YAML + SQLite 配置两种装载路径向后兼容。

## 3. 数据模型

### 3.1 新增模型

在 `servermanage/models.py` 增加：

```python
@dataclass(frozen=True)
class HostCheckConfig:
    name: str
    type: str                 # tcp | http | process | service
    target: str               # 端口 / host:port / URL / 精确进程名 / systemd unit
    timeout_seconds: int = 5  # 1..30
    expected: str | None = None  # HTTP 状态码范围，如 "200-399"；service 默认 "active"
    enabled: bool = True

@dataclass(frozen=True)
class HostAlertRules:
    cpu_percent: float | None = None
    memory_percent: float | None = None
    disk_percent: float | None = None
    gpu_memory_percent: float | None = None
    disk_temperature_c: float | None = None
    consecutive_periods: int | None = None  # 1..10，None=继承全局

@dataclass(frozen=True)
class HostCheckResult:
    name: str
    type: str
    target: str
    status: str               # ok | failed | error | unknown
    message: str
    latency_ms: float | None = None
    checked_at: datetime | None = None
```

`HostConfig` 增加：

```python
checks: list[HostCheckConfig] = field(default_factory=list)
alert_rules: HostAlertRules | None = None
sudo_password: str | None = field(default=None, repr=False, metadata={"sensitive": True})  # 仅内存使用；serialization 跳过 sensitive 字段
```

`HostReport` 增加 `checks: list[HostCheckResult] = field(default_factory=list)`。

`AlertsConfig` 增加 `consecutive_periods: int = 2`（1..10）。默认 2 个周期是为了减少单次瞬时抖动误报；希望立即告警的主机可以显式设为 1。

### 3.2 存储位置

- 检查项、告警规则保存在 `hosts` section 的每条 host entry 中：
  - `checks`: `[{name,type,target,timeout_seconds,expected,enabled}, ...]`
  - `alert_rules`: `{cpu_percent,memory_percent,disk_percent,gpu_memory_percent,disk_temperature_c,consecutive_periods}`
- `sudo_configured` **不持久化**，只由 `_public_host_entry` 按 `app_secrets` 中是否存在 secret 实时计算，避免 secret 删除后仍显示“已配置”。
- sudo 密码保存在 `app_secrets`：
  - 新增常量 `_HOST_SECRET_SUDO_PASSWORD = "host:{name}:sudo_password"`。
  - 与 SSH 密码/私钥共用现有 `_store_secret`/`get_secret`/`delete_secret` 加密路径。
- 主机检查最新结果保存在新表 `host_check_snapshot`（每主机每检查项一行，不累计历史）：

```sql
CREATE TABLE IF NOT EXISTS host_check_snapshot (
    host_name TEXT NOT NULL,
    check_name TEXT NOT NULL,
    check_type TEXT NOT NULL,
    target TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    latency_ms REAL,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (host_name, check_name)
);
CREATE INDEX IF NOT EXISTS idx_host_check_snapshot_host
    ON host_check_snapshot(host_name);
```

`save_host_check_results` 在单个 `BEGIN IMMEDIATE ... COMMIT` 事务内先 `DELETE` 该主机旧行再批量插入，失败回滚，避免并发读到半更新状态；`delete_host` 同时 `DELETE FROM host_check_snapshot WHERE host_name=?`。只保留最新结果即可支撑详情页、概览和报告，也不会让数据库持续增长。

## 4. 配置读取与写入

### 4.1 Settings DB 路径

- `settings.py` 增加 `_HOST_SECRET_SUDO_PASSWORD`，`delete_host`、`copy_host`、`_reset_secrets_for_machine`/机器重绑迁移都处理 sudo secret；`copy_host` 还要显式复制 `checks`/`alert_rules`。
- `upsert_host`：
  - 在 `_apply_host_secrets` 之前或之后单独调用 `_apply_host_sudo_password(name, payload)`：
    - payload 有 `sudo_password` 非空 → 先校验无换行且 ≤256 字符，再写入 secret；
    - `clear_secrets` 包含 `"sudo_password"` → 删除 secret；
    - 空字符串/缺省 → 保持原值。
  - 主机 entry 的 `checks`/`alert_rules` 必须区分“键缺省=保留 existing”和“键存在=覆盖（含 `[]`/`null` 清空）”：
    - `if "checks" in payload: entry["checks"] = _sanitize_host_checks(payload["checks"]) else: entry["checks"] = existing.get("checks", [])`
    - `if "alert_rules" in payload: entry["alert_rules"] = _validate_alert_rules(payload["alert_rules"]) else: entry["alert_rules"] = existing.get("alert_rules")`
    - 任何不经完整 `hostPayload()` 的部分更新都不得清空已有配置。
  - `_sanitize_host_checks` 校验：名称唯一（casefold 后）且 ≤64 字符、每主机 ≤20 项、`timeout_seconds = int()` 且 1..30、`type` 在 tcp/http/process/service、`expected` 仅允许 `^\d{3}(-\d{3})?$`；非法值抛 `ValueError`，API 返回 400。
- `_settings_snapshot`、`_host_entry_from_config`、`_build_servers`、`_public_host_entry` 全部同步读写 `checks`/`alert_rules`；只读 fallback、导出、seed 也不能丢字段。
- `_reset_secrets_for_machine`/机器迁移涉及的 `host:{name}:*` 模板集合必须加上 `sudo_password`，避免机器重绑后旧密文残留/不可解。
- `_public_host_entry` 增加：
  - `checks`、`alert_rules`
  - `sudo_configured: bool`（绝不返回密码，由 secret 存在性计算）
- `_build_servers` 解析 `checks`、`alert_rules`、`sudo_password=self._read_secret_text(...)`。
- `_host_entry_from_config` 支持从 YAML `HostConfig` 回写同样的字段。
- `_build_servers`/`_host_entry_from_config` 必须过滤 `HostConfig.sudo_password`（sensitive），只写 entry 的元数据，不把密码写入 `hosts` section。

### 4.2 YAML 路径（Docker/旧配置兼容）

`servermanage/config.py` 的 `_load_host` 增加可选字段：

```yaml
servers:
  - name: gpu-01
    host: 10.0.0.1
    username: zhouyc
    auth:
      type: key
      key_path: /home/zhouyc/.ssh/id_ed25519
    sudo_password_env: LAB_GPU01_SUDO_PASSWORD  # 可选
    alert_rules:
      cpu_percent: 95
      consecutive_periods: 3
    checks:
      - name: 训练 API
        type: http
        target: http://127.0.0.1:8000/health
        timeout_seconds: 5
        expected: "200-299"
      - name: SSH 端口
        type: tcp
        target: "22"
```

`_load_host` 同时支持 `sudo_password_env`（读取环境变量）和直接 `sudo_password`（仅本地配置兼容，文档不推荐）；两者同时出现时 `sudo_password_env` 优先。没有这些字段的旧 YAML 继续使用默认空列表/None。加载 `checks` 时即校验：`timeout_seconds` 强转 int 且 1..30、名称唯一且 ≤64、`expected` 符合格式；非法 YAML 抛 `ConfigError`，不要拖到每轮采集才变成 error。

## 5. 检查执行

新增 `servermanage/availability.py`：

- `build_check_command(check: HostCheckConfig) -> str`
  - 先执行 `t = int(check.timeout_seconds)` 并校验 `1 <= t <= 30`；非法抛 `ValueError`，命令中只渲染整数：`f"timeout {t}"` / `f"--max-time {t}"`。`timeout_seconds` 来自 YAML/API/导入时必须强转校验，**绝不允许字符串直接插值**。
  - 所有 target 都先通过 `validate_check_target(type, target)`：
    - `tcp`: target 为 `port` 或 `host:port`；port 必须是 1..65535 的整数；host 用 `ipaddress.ip_address` 或严格校验 `^[A-Za-z0-9.-]{1,253}$`，拒绝引号/空白/控制字符；默认 `127.0.0.1`。IPv6 用 `rsplit(":", 1)` 拆端口并支持 `[::1]:22`，host 用 `ipaddress.ip_address` 校验。
    - `http`: 用 `urllib.parse.urlsplit` 解析，只允许 `http/https`、必须有 netloc；拒绝 userinfo（`@`）、查询/片段（`?`/`#`）、空白/控制字符、反引号、`$(`、`;`、`|`、`&`；最终 URL 仍用 `shlex.quote` 包裹。检查目标不得携带 token 等凭据。
    - `process`: 只允许精确进程名 `^[A-Za-z0-9._+-]{1,64}$`；注意 `pgrep -x` 只匹配 comm（通常 15 字符截断），长名称请使用 `service` 或后续自定义命令。
    - `service`: 只允许 `^[A-Za-z0-9@._:-]{1,128}$`。
  - `tcp`: `timeout <t> bash -c <shlex.quote('cat < /dev/null > /dev/tcp/<host>/<port>')>`。
  - `http`: `curl -sS -o /dev/null -w '%{http_code} %{time_total}' --max-time <t> <shlex.quote(url)>`。
  - `process`: `pgrep -x -- <shlex.quote(name)>`（精确进程名，避免 `pgrep -f` 匹配到 SSH/检查命令自身）。
  - `service`: `systemctl is-active -- <shlex.quote(unit)>`。
  - 所有 target/unit/pattern 长度 ≤256。
- `parse_check_result(check, result: CommandResult) -> HostCheckResult`
  - `tcp`: exit 0 → `ok`；`timeout` 命令缺失/无法执行 → `error`；其它非 0 → `failed`。
  - `http`: 解析状态码和耗时；状态码 `000` → `error`（连接失败），在 expected 范围（默认 200-399）→ `ok`，否则 `failed`；exit 127（curl 缺失）→ `error`。
  - `process`: exit 0 且有 stdout → `ok`；exit 1 → `failed`；其它 → `error`。
  - `service`: stdout 为 `active` → `ok`；`inactive/failed` → `failed`；`unknown`/`not-found` → `error`。
- `run_host_checks(host, runner, checks, command_timeout) -> list[HostCheckResult]`
  - 只执行 `enabled` 的检查；每台主机最多 20 个检查项。
  - 单个检查异常只影响该检查，不能把主机采集标记为失败。
  - 超时统一用 `min(int(check.timeout_seconds), int(command_timeout))`；顺序执行，避免并发 SSH 命令互相干扰。

`collectors.collect_host_report` 在 metrics 解析完成后调用 `run_host_checks`，把结果放入 `HostReport.checks`。因为复用同一条 SSH 连接，不增加连接数。

`run_status_once` 在成功报告后调用 `storage.save_host_check_results`：先删除该主机旧的 `host_check_snapshot` 行，再写入当前检查集合，避免删除检查项后残留旧结果。主机整体采集失败时，把该主机所有已配置检查项标记为 `unknown`，不产生“服务检查失败”告警，由现有离线告警负责。删除主机时同时调用 `storage.delete_host_check_results(name)`。

## 6. sudo 密码通道

### 6.1 SSH 客户端

`servermanage/ssh_client.py` 新增：

```python
def run_sudo(self, command: str, timeout: int) -> CommandResult
```

- 主机没有 `sudo_password`：等价于 `sudo -n <command>`。
- 有密码：
  - `client.exec_command("sudo -S -p '' " + command, timeout=timeout)`；
  - 向 `stdin.write(password + "\n")`，`flush()`，`channel.shutdown_write()`；
  - 先 `stdout.read()`/`stderr.read()` 再 `recv_exit_status()`，避免大输出（storcli JSON）阻塞 channel 导致死锁；
  - 不把密码放进 command、日志或异常；异常用 `raise ... from None`，避免链式异常带出上下文。
- **现有 `run()` 也改为 read-first**：抽出共用 `_execute_read_first(channel)`，`run()` 与 `run_sudo()` 都先读 stdout/stderr 再 `recv_exit_status()`；否则非 sudo 的 storcli 大输出仍会死锁。
- 识别 `incorrect password` / `Sorry, try again` → 抛 `SudoAuthError("sudo 密码错误")`；无密码且目标机未配置免密 sudo → `SudoUnavailable("未配置 sudo 密码且免密 sudo 不可用")`。所有 `disk_health.py` 中需要提权的 `runner.run` 调用统一走局部 `_run_privileged(runner, command, timeout, use_sudo)`；当前提权调用点为 4 处（约 826/851/904/921），不能只改一处。

### 6.2 磁盘健康

`disk_health.py` 不再拼 `"sudo -n "` 字符串，改为：

```python
result = runner.run_sudo(command, timeout) if use_sudo else runner.run(command, timeout)
```

为兼容测试 double，先检查 `hasattr(runner, "run_sudo")`；没有时回退到现有 `sudo -n` 行为（仍走 read-first 的 `run()`），避免破坏旧 fake runner。`disk_health.collect_disk_health` 的探测块（约 822-926，而非不存在的 `_probe_storcli`）必须显式 `except SudoAuthError` → `permission_denied("sudo 密码错误，请在主机编辑中修正")`，`except SudoUnavailable` → `permission_denied("未配置 sudo 密码且免密 sudo 不可用")`；同时把现有 842/863 的“请配置免密 sudo”文案改为区分密码错误/未配置。

`host_probe._run_probe` 的 sudo 可用性检测同样优先 `run_sudo`：`ProbeRunner` 协议增加 `run_sudo`，`_build_host_config` 与 `routes.py:_host_config_from_payload` 把候选主机的 `sudo_password` 传入（仅内存）；配置了密码就能通过验证；未配置时仍检测免密 sudo，并提示“可在主机编辑中配置 sudo 密码”。

## 7. 告警规则增强

### 7.1 按主机阈值

- `alerts.py` 的 `evaluate_system_alerts` 继续接收 `AlertThresholds`；`run_status_once`（`app.py:406-412`）必须在循环内取 `srv = servers_by_name.get(report.host_name)`，再用 `rules = srv.alert_rules if srv is not None else None` 计算有效阈值（主机被热更新删除时安全兜底），再调用评估：
  - `HostAlertRules` 中非 None 的字段覆盖全局值；
  - 其余字段使用 `config.alerts.thresholds`。
- `run_disk_once` 循环内使用 `host.alert_rules.disk_temperature_c`（若有）覆盖全局 `config.alerts.thresholds.disk_temperature_c`，再传给 `collect_disk`。
- 设置页全局告警表单增加“连续异常周期数”，默认 2；`public_settings()`/配置导出需包含该字段，否则表单无法回填；主机表单增加五个阈值输入 + 连续周期输入，留空表示继承。
- 阈值/周期校验统一用 `servermanage.settings._validate_alert_rules(rules: dict | None) -> dict | None`，同时服务 `upsert_host` 与配置导入：CPU/内存/磁盘/GPU 显存为 1..100，磁盘温度为 1..120，`consecutive_periods` 为 1..10；非法值返回 400，不静默截断。前端 `min/max` 与后端使用同一组数值。

### 7.2 连续 N 个周期

- `MonitorService` 维护 `_alert_streaks: dict[tuple[str, str], int]`、`_clear_streaks: dict[tuple[str, str], int]` 和 `_streak_lock`；key 为 `(host_name, fingerprint)`，锁只保护这两个内存字典，**只由 `run_status_once` 使用**。`run_disk_once` 的磁盘健康告警仍即时，不碰 streak 状态。
- `_effective_periods(host_name: str) -> int`：读取该主机 `alert_rules.consecutive_periods`（若 None 用 `config.alerts.consecutive_periods`），并 clamp 到 1..10。
- 每轮 `run_status_once` 对每个成功主机区分：
  - `present_by_host[host]`：本轮该主机产生的**所有**候选事件（system + availability，不经过 streak 过滤），key 为 fingerprint。
  - `ready_events`：仅 `_alert_streaks[(host, fp)] >= _effective_periods(host)` 的事件，送入 `engine.process`。
- 需要持久化活动告警 fingerprint 才能正确求“保留集”：给 `AlertEngine` 增加 `open_alert_fingerprints(host_name, *, category=None) -> set[str]`，内部读取 open alerts（active + acknowledged）返回 fingerprint 集合；不要直接依赖私有 `_open_alerts`。
- 状态推进（每个成功主机）：
  - `previous_open_fps = engine.open_alert_fingerprints(host)`（本轮 process 之前）。
  - `seen_keys = {key for key in _alert_streaks if key[0] == host} | {(host, fp) for fp in previous_open_fps}`；`present_keys = {(host, fp) for fp in present}`；`absent_keys = seen_keys - present_keys`。`seen_keys` 包含**从未 open 过但曾出现过**的指纹，这是 R1 的关键。
  - 对 `present_keys` 每个 key：`_alert_streaks[key] += 1`，`_clear_streaks.pop(key, None)`。
  - 对 `absent_keys` 每个 key：`_alert_streaks[key] = 0`，`_clear_streaks[key] += 1`。这样“坏1（从未告警）→好→坏”的第二次“坏”从 0 重新累计，不会第 3 周期误报。
  - `engine.process([event for fp, event in present.items() if _alert_streaks[(host, fp)] >= periods])` 持久化/降温/通知；可用性告警也走同一入口。
  - 对 `category in ("system", "availability")` 分别：
    - `open_fps = engine.open_alert_fingerprints(host, category=cat)`（process 之后重新读取）
    - `periods = _effective_periods(host)`
    - `remaining = {fp for fp in open_fps if fp in present or _clear_streaks.get((host, fp), 0) < periods}`
    - `engine.resolve_missing(host, remaining, category=cat, notify=True)`
  - **两趟 resolve 全部完成后**再清理内存键（不能在 category 循环内用该 category 的 `open_fps` 清理，否则会误删另一 category 的 clear 计数，导致 availability 告警永远无法恢复）：`still_open = engine.open_alert_fingerprints(host)`（不带 category）；`for key in [k for k in _alert_streaks if k[0] == host and k[1] not in still_open and _clear_streaks.get(k, 0) >= periods]: pop(_alert_streaks[key]); pop(_clear_streaks[key])`。
- 对未成功采集的主机（离线/SSH 失败）：不产生 system/availability 事件，**跳过 streak 更新与 `resolve_missing`**；既有活动告警保持 open，检查结果置 `unknown`，由现有离线告警负责。`successful_hosts` 守卫必须覆盖 system 与 availability。
- 伪代码（可直接实现）：
  ```python
  for host in successful_hosts:
      present = present_by_host[host]  # dict fp -> AlertEvent
      periods = self._effective_periods(host)
      with self._streak_lock:
          previous_open_fps = self.engine.open_alert_fingerprints(host)
          seen_keys = {k for k in self._alert_streaks if k[0] == host}
          seen_keys |= {(host, fp) for fp in previous_open_fps}
          present_keys = {(host, fp) for fp in present}
          absent_keys = seen_keys - present_keys
          for key in present_keys:
              self._alert_streaks[key] = self._alert_streaks.get(key, 0) + 1
              self._clear_streaks.pop(key, None)
          for key in absent_keys:
              self._alert_streaks[key] = 0
              self._clear_streaks[key] = self._clear_streaks.get(key, 0) + 1
          ready = [event for fp, event in present.items()
                   if self._alert_streaks.get((host, fp), 0) >= periods]
      self.engine.process(ready)
      for category in ("system", "availability"):
          open_fps = self.engine.open_alert_fingerprints(host, category=category)
          remaining = {
              fp for fp in open_fps
              if fp in present or self._clear_streaks.get((host, fp), 0) < periods
          }
          self.engine.resolve_missing(host, remaining, category=category, notify=True)
      # 两趟 resolve 后再清理；用跨 category 的 still_open，禁止在循环内用单类 open_fps 清理。
      still_open = self.engine.open_alert_fingerprints(host)
      with self._streak_lock:
          for key in list(self._alert_streaks):
              if key[0] == host and key[1] not in still_open and self._clear_streaks.get(key, 0) >= periods:
                  self._alert_streaks.pop(key, None)
                  self._clear_streaks.pop(key, None)
  ```
- 测试必须覆盖：坏→好→坏时 streak 重新从 0 开始；恢复需连续两个好周期；离线一个周期不计数、既有 availability 告警不消失；**availability 检查 failed 两周期→open，随后 ok 两周期必须真正 resolve/关闭**（避免 category 清理顺序导致永不恢复）。
- 磁盘健康告警仍保持即时触发，不套用连续周期（驱动器故障需要立即通知）。

### 7.3 可用性告警

新增 `evaluate_availability_alerts(host_name, results)`：

- 仅对 `failed` / `error` 结果生成 `AlertEvent`；
- `category="availability"`、`severity="critical"`（服务不可用视为业务中断，按严重告警处理）；
- `fingerprint_for("availability", host_name, check.name)`；
- 标题 `服务检查失败：<check.name>`，消息包含类型、目标和具体原因（不包含秘密）；
- 检查恢复后从活动集合消失，`resolve_missing(..., category="availability")` 关闭并按 `notify_on_recovery` 发送恢复通知。
- 主机离线/采集失败时检查为 `unknown`，不生成 availability 事件；该主机必须在 `successful_hosts` 中才允许 `resolve_missing`，否则既有可用性告警保持 open，不能误发“服务恢复”。

## 8. UI / API

### 8.1 设置页 — 主机编辑

`settings.html` 主机表单新增：

- **sudo 密码**：`data-host-field="sudo_password"`，`type=password`，`autocomplete=new-password`；旁边显示“已配置/未配置”，留空不改；提供“清除 sudo 密码”复选框。
- **告警规则**：CPU/内存/磁盘/GPU 显存/磁盘温度五个数字输入 + 连续异常周期数；空白=继承全局。
- **服务检查**：动态列表 `#host-checks`：
  - 每行：名称、类型下拉、目标、超时、期望值、启用、删除、测试；
  - “添加检查”按钮；“测试”按钮调用 `POST /api/settings/hosts/<name>/checks/test` 并显示本次结果；
  - 保存时 `settings.js` 收集为 `checks` 数组。

`settings.js` 的 `hostPayload()` 增加 `sudo_password`、`alert_rules`、`checks`；`openHostForm()` 恢复检查和规则，但 sudo 密码只显示状态，不填充值；勾选“清除 sudo 密码”时把 `"sudo_password"` 加入 `clear_secrets`。主机表格 `colspan="9"` 需随新增“检查”列同步调整，概览模板列也同步。

### 8.2 主机详情

- `_build_host_detail` 增加 `checks: storage.get_host_check_results(name, db_path)`。
- 新增标签 `data-host-tab="checks"` / 面板 `#host-checks-panel`，表格列：名称、类型、目标、状态、耗时、最近检查、消息。
- 概览面板的摘要卡增加“服务检查 2/2 正常”。

### 8.3 概览

- `_host_row` 增加 `checks: {total, ok, failed, unknown}`；表格新增“检查”列显示 `ok/total`，异常时红色/黄色。
- `_build_host_report` 增加 `[服务可用性]` 段：逐项列出 `名称（type target）：status message latency`。
- 全网巡检报告自动包含每台主机该段。
- 日报邮件（`report.py`，`HostReport.checks`）在主机摘要中增加“检查 ok/total”，文本/HTML 列出失败检查项。
- 周报由 `weekly.py` 从日聚合构建，**没有检查历史**；因此周报只展示“当前 `host_check_snapshot` 快照”的 `ok/total`，并在 `WeeklyHostSummary` 增加 `checks: list[dict] = field(default_factory=list)` 由 `generate_weekly_report` 按主机读取当前快照填充（不声称是周历史）。模板 `servermanage/templates/report_weekly.txt.j2` 与 `report_weekly.html.j2` 增加该行，既有字段语义不变。

### 8.4 新增/变更 API

- `GET /api/host/<name>`：响应增加 `checks`。
- `GET /api/overview`：每主机增加 `checks` 汇总。
- `PUT /api/settings/hosts/<name>`：请求体接受 `sudo_password`、`checks`、`alert_rules`；响应仍不返回秘密。
- 新增 `POST /api/settings/hosts/<name>/checks/test`：
  - 请求单个 check 配置；`<name>` 必须在已保存主机中存在，否则 404；
  - 立即建立一次 SSH 连接执行并返回 `HostCheckResult`（不落库）；
  - 用于设置页“测试”按钮。**新增主机在保存前不能测试**，前端提示“请先保存主机再测试”，避免为了测试而通过 API 传递连接密码。
- `GET /api/settings` 的 hosts 响应增加 `sudo_configured`、`checks`、`alert_rules`。

## 9. 安全要求

- sudo 密码只存在于 `app_secrets` 密文和 `HostConfig` 内存对象中；`public_settings()`、日志、异常、HTTP 响应、CSV/JSON 导出中都不能出现明文。
- `HostConfig.sudo_password` 标记 `metadata={"sensitive": True}`；`serialization.to_jsonable` 改为按 dataclass 字段遍历并跳过 sensitive 字段（不再用 `asdict`），`report.py` 中对 host 的序列化改用 `to_jsonable`；测试断言 `dump_json(HostConfig(...sudo_password=...))` 不含密码。
- SSH 客户端包装类的 `run_sudo` 不把密码拼入命令；不记录命令 stdin；错误信息统一为用户可读文本。
- 检查命令必须使用 `shlex.quote`；HTTP URL 只允许 http/https 且禁止 userinfo 与 `?`/`#`（防 query token）；target 长度 ≤256；检查名唯一（不区分大小写）且 ≤64 字符；每主机最多 20 个检查项；检查目标不得内嵌凭据/令牌（会进入 hosts entry、snapshot、报告和 API）。
- `timeout_seconds` 必须 `int()` 且 1..30；命令模板只渲染整数，禁止 YAML/API/导入字符串直接插值；单测覆盖 `"5; rm -rf /"` 被拒绝。
- 保存时校验：sudo 密码不得包含换行符且长度 ≤256；告警阈值必须在 1..100（温度 1..120）、`consecutive_periods` 在 1..10；非法值返回 400，不落库。
- **所有 `dataclasses.asdict` 调用点审计**：`routes.py` 约 1383/2100/2118/2148/2192/2266 等如涉及 `HostConfig`/导入候选/probe/collect 响应，必须改用 `to_jsonable` 或显式剔除 `sudo_password`；新增“导入预览/探测/采集响应不含 sudo 密码”的测试。
- 设置页所有新字段继续使用现有 `textContent` 渲染，禁止 `innerHTML` 拼接用户输入。
- 清除 sudo 密码使用 `clear_secrets=["sudo_password"]`，与 SSH 密码一致。

## 10. 错误处理与降级

- 单个检查超时/命令不存在：该检查记 `error`，主机其它指标和检查继续。
- sudo 密码错误：磁盘健康记错误信息“sudo 密码错误”，不让整个采集失败；设置页测试磁盘健康时提示去主机编辑修正。
- 未配置 sudo 密码：继续 `sudo -n`，失败提示“未配置 sudo 密码且免密 sudo 不可用”。
- 检查项 target 非法：保存时返回 400，不落库。
- 主机离线：检查结果置 `unknown`，不产生服务检查告警，由离线告警处理。
- 升级前旧数据：`checks`/`alert_rules` 缺失 → 空列表/None；`host_check_snapshot` 用 `CREATE TABLE IF NOT EXISTS` 自动创建。

## 11. 测试计划

### 11.1 单元测试

- `tests/test_availability.py`：
  - TCP/HTTP/process/service 命令构建与解析；
  - HTTP 200/500、超时、curl 缺失；
  - 非法 target/URL、命令注入字符被 quote；`timeout_seconds="5; rm -rf /"` 被拒绝；名称重复/超过 20 项被拒绝；HTTP 200/500、`000`、curl 缺失；
  - 单检查失败不影响其它检查。
- `tests/test_sudo.py`：
  - 有密码时 `run_sudo` 通过 stdin 写入密码且命令不含密码；
  - `run_sudo` 与普通 `run` 都先读 stdout/stderr 再取 exit status（fake channel 记录调用顺序）；
  - 无密码时走 `sudo -n`；
  - 错误密码/无权限的异常文本不包含秘密；
  - `disk_health.collect_disk_health` 使用 `run_sudo` 且旧 fake runner 兼容，`SudoAuthError` 映射 `permission_denied`。
- `tests/test_host_checks_storage.py`：保存/读取/覆盖主机检查结果；删除主机级联清理；保存事务失败回滚保留旧结果。
- `tests/test_settings_hosts.py`：sudo 密码写-only、`sudo_configured` 实时计算且不落 entry、clear_secrets、checks/alert_rules 校验、编辑其它字段不丢 checks/alert_rules、复制主机、机器重绑清理 sudo secret、旧数据兼容；`to_jsonable(HostConfig(sudo_password=...))` 不含密码。
- `tests/test_alerts.py`：按主机阈值覆盖；连续 N 周期才触发；`present` 与 `ready` 分离；恢复需连续周期；离线主机不产生假恢复；可用性告警 fingerprint。

### 11.2 集成测试

- `run_status_once` 使用 fake runner 返回检查结果，验证：
  - 前 N-1 个周期不产生告警，第 N 个周期产生；
  - 检查恢复后产生恢复通知；
  - 主机离线时既有可用性告警不误恢复、检查为 unknown；
  - 阈值覆盖生效（例如全局 90、主机 95，92 不告警）。
- 主机详情/概览/报告包含检查结果。
- 设置页新增字段、检查编辑器和 JS 提交逻辑。

### 11.3 回归

- 全量 `python -m pytest -q` 和 `node --test desktop/test/*.test.js` 必须通过。
- 真实四台主机冒烟：无 sudo 密码时旧 storcli 行为不退化；配置 sudo 密码后磁盘健康成功；至少一个 TCP/HTTP/process 检查成功与失败各一次。

## 12. 验收标准

1. 每台主机可添加/编辑/删除多个检查项，保存后下一轮采集显示结果。
2. 检查失败产生告警，恢复产生恢复通知；连续异常周期可配置，默认 2。
3. 主机详情、概览、单机报告和全网巡检报告都能看到检查状态。
4. 主机可单独配置 sudo 密码，保存后不回显；配置后 storcli 磁盘健康不再依赖免密 sudo。
5. sudo 密码不出现在任何日志、API 响应、导出文件或命令行中。
6. 旧配置/旧数据库升级后无需手动迁移即可正常启动。
7. 全量 Python/Node 测试通过，打包后本机四台主机冒烟通过。

## 13. 实施顺序建议

1. 数据模型 + storage 表 + 设置读写 + sudo secret（含测试）。
2. `servermanage/ssh_client.py` 的 `run_sudo` + disk_health/host_probe 接入。
3. `availability.py` 检查执行 + `collectors` 接入 + storage 保存。
4. 告警评估：按主机阈值 + 连续周期 + 可用性告警/恢复。
5. 设置页表单/检查编辑器 + 主机详情/概览/报告 UI。
6. 全量测试、打包、发布、四台真机冒烟。

## 14. 待确认项

- 检查执行位置默认在目标主机上（通过 SSH），因此 `tcp` 的 `127.0.0.1:端口` 表示检查目标机本机端口；若希望从监测机直接发起，需要额外增加 `where: local` 模式，0.2.0 暂不实现。
- 连续异常周期默认 2；若现场希望保持“单次超阈值立即告警”，在设置中改为 1 即可。
