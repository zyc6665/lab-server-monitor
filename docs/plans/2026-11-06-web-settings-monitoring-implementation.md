# 网页在线配置与监控增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Windows 绿色包用户在浏览器内完成首次设置与日常维护配置（主机/SSH、邮件、Webhook、看板密码、报告启停、磁盘健康规则、每台主机的容量监控目录），并新增“当前登录用户”展示与按主机磁盘容量监控。

**Architecture:** 配置分层为 SQLite 运行时覆盖 + YAML 首次种子。`app_settings` 保存非敏感配置，`app_secrets` 以 Windows DPAPI（用户作用域）保存密码/私钥/Webhook URL；启动时 `SettingsService` 合并出 `AppConfig`，保存后 `MonitorService.apply_config()` 热重建调度。Web 层保持 Flask + Jinja2 + 原生 JS，无前端构建链。

**Tech Stack:** Python 3.11、Flask 3、waitress、Jinja2、SQLite、PyInstaller `--onedir`、Windows DPAPI（ctypes）、PBKDF2-HMAC-SHA256（标准库 hashlib）。

**Spec:** `servermonitor-main/servermonitor-main/docs/plans/2026-11-06-web-settings-monitoring-design.md`

## Global Constraints

- Python `>=3.11`；主交付平台 Windows 11 x64；Docker/Linux 保留原 YAML/.env 只读模式，不开放网页敏感配置。
- 不得引入前端构建链；页面使用 Jinja2 + 原生 JS + 现有 `style.css`。
- 密码哈希固定 PBKDF2-HMAC-SHA256、200000 次迭代、16 字节随机 salt。
- DPAPI 使用当前 Windows 用户作用域；服务端任何 API 都不得返回明文秘密或可逆密文。
- 默认值保持：`poll_interval_seconds=600`、`disk_poll_interval_seconds=86400`、`timezone=Asia/Shanghai`、`retention_days=90`。
- 每台主机默认容量挂载点为 `["/", "/data"]`；缺失挂载点只展示“未挂载”，绝不产生告警。
- 首次 `/setup` 仅允许 loopback（`127.0.0.1` / `::1`）。
- 所有写请求（页面表单与 `/api/settings/*`）必须校验 CSRF。
- 版本号提升到 `1.1.0`；打包仍使用 PyInstaller `--onedir`。

## Review Focus

- 把整个文件夹（含 `data/servermonitor.db`）拷到新电脑后，首次打开必须强制 `/setup`，不能继承旧管理员密码，也不能因 DPAPI 解密失败而崩溃。
- 只修改一个设置分区（例如报告启停）而未重新输入秘密时，已有 SSH 密码/私钥/SMTP 密码/Webhook URL 必须原样保留，不得被空白覆盖或删除。
- 旧 YAML/.env 首次升级时凭据必须自动迁入 `app_secrets`；迁移失败要明确提示“请重新填写”，并保留可启动状态。
- 配置了 `/data` 但主机没有该挂载点时，页面显示“未挂载”且不告警；根目录容量超阈值仍必须正常告警。
- 保存配置触发调度重建时，正在运行的轮询线程必须安全停止/替换，不能卡死、重复启动或让 Web 请求等死。

---

### Task 1: 配置模型扩展与宽松加载

**Files:**
- Modify: `servermonitor-main/servermonitor-main/servermanage/models.py:9-16, 26-34, 54-60, 95-100`
- Modify: `servermonitor-main/servermonitor-main/servermanage/config.py:218-269, 272-344`
- Test: `servermonitor-main/servermonitor-main/tests/test_config_extended.py`

**Interfaces:**
- Consumes: 现有 `load_config(path)` 行为必须保持默认严格（现有 9 个 config 测试不改）。
- Produces:
  - `AuthConfig.key_data: str | None = None`
  - `HostConfig.disk_mounts: list[str] = field(default_factory=lambda: ["/", "/data"])`
  - `WeeklyReportConfig.weekday: int = 4`
  - `DashboardAuthConfig.password_hash: str | None = None`、`password_salt: str | None = None`、`password_iterations: int = 200000`
  - `load_config_from_mapping(raw: dict[str, Any], *, allow_empty_servers: bool = False, allow_missing_secrets: bool = False) -> AppConfig`
  - `load_config(path: str | Path, *, allow_empty_servers: bool = False, allow_missing_secrets: bool = False) -> AppConfig`

- [ ] **Step 1: 写失败测试**

在 `tests/test_config_extended.py` 追加：

```python
def test_host_disk_mounts_default_to_root_and_data():
    cfg = _load({"servers": [_server()]})
    assert cfg.servers[0].disk_mounts == ["/", "/data"]


def test_host_disk_mounts_override():
    cfg = _load({"servers": [_server(disk_mounts=["/", "/data", "/scratch"])]})
    assert cfg.servers[0].disk_mounts == ["/", "/data", "/scratch"]


def test_empty_servers_allowed_when_flag():
    cfg = load_config_from_mapping({"servers": []}, allow_empty_servers=True)
    assert cfg.servers == []


def test_missing_env_password_allowed_when_flag(monkeypatch):
    monkeypatch.delenv("MISSING_PW", raising=False)
    cfg = load_config_from_mapping(
        {"servers": [_server(auth={"type": "password", "password_env": "MISSING_PW"})]},
        allow_missing_secrets=True,
    )
    assert cfg.servers[0].auth.password is None


def test_weekly_weekday_parsed():
    cfg = _load({"servers": [_server()], "report": {"weekly": {"weekday": 0}}})
    assert cfg.report.weekly.weekday == 0


def test_auth_key_data_roundtrip():
    cfg = _load({"servers": [_server(auth={"type": "key", "key_data": "PEM"})]})
    assert cfg.servers[0].auth.key_data == "PEM"
```

用现有测试文件的 `_load` helper；若不存在，则用 `tmp_path` 写 YAML 后 `load_config()`。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_config_extended.py -q`
Expected: FAIL（`disk_mounts` / `load_config_from_mapping` 不存在）。

- [ ] **Step 3: 实现模型与配置加载**

`models.py`：按 Interfaces 增加字段；`AuthConfig` 的 `key_path` 保持 `Path | None`，新增 `key_data` 放最后。

`config.py`：
- 把 `load_config()` 的解析主体抽成 `load_config_from_mapping(raw, *, allow_empty_servers=False, allow_missing_secrets=False)`。
- `load_config()` 只读 YAML 后调用它。
- `_load_auth(data, *, allow_missing_secrets=False)`：`password` 的 env 缺失时，严格模式仍抛 `ConfigError`，宽松模式返回 `password=None`；`key` 模式若 `key_path` 缺失但 `key_data` 存在则允许，若两者都无且宽松模式则返回 `AuthConfig(type="key")`，否则维持现有报错。
- `_load_smtp(data, *, allow_missing_secrets=False)`：密码 env 缺失时严格模式抛错，宽松模式 `password=""`。
- 新增 `_load_host(item)` 集中处理 `name/host/port/username/auth/tags/disk_health/disk_mounts`；`disk_mounts` 用 `list(item.get("disk_mounts") or ["/", "/data"])`。
- `_load_weekly_report_config` 读取 `weekday=int(mapping.get("weekday", 4))`。

- [ ] **Step 4: 运行配置测试**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_config.py tests/test_config_extended.py -q`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add servermonitor-main/servermonitor-main/servermanage/models.py servermonitor-main/servermonitor-main/servermanage/config.py servermonitor-main/servermonitor-main/tests/test_config_extended.py
git commit -m "feat: extend config models for disk mounts and web settings"
```

---

### Task 2: 安全原语（DPAPI / 密码哈希 / 机器标识）

**Files:**
- Create: `servermonitor-main/servermonitor-main/servermanage/security.py`
- Test: `servermonitor-main/servermonitor-main/tests/test_security.py`

**Interfaces:**
- Produces:
  - `class SecurityError(RuntimeError)`
  - `dpapi_available() -> bool`
  - `protect_secret(data: bytes) -> bytes`
  - `unprotect_secret(blob: bytes) -> bytes`
  - `hash_password(password: str, *, iterations: int = 200_000) -> tuple[str, str]` 返回 `(hash_hex, salt_hex)`
  - `verify_password(password: str, hash_hex: str, salt_hex: str, iterations: int) -> bool`
  - `current_machine_id() -> str`

- [ ] **Step 1: 写失败测试**

```python
import sys
import pytest
from servermanage import security


def test_dpapi_roundtrip():
    if not security.dpapi_available():
        pytest.skip("DPAPI requires Windows")
    blob = security.protect_secret(b"top-secret")
    assert blob != b"top-secret"
    assert security.unprotect_secret(blob) == b"top-secret"


def test_dpapi_unavailable_on_non_windows(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    assert security.dpapi_available() is False
    with pytest.raises(security.SecurityError):
        security.protect_secret(b"x")


def test_hash_password_verifies_and_rejects_wrong():
    hashed, salt = security.hash_password("admin-pass", iterations=1000)
    assert security.verify_password("admin-pass", hashed, salt, 1000) is True
    assert security.verify_password("wrong", hashed, salt, 1000) is False


def test_machine_id_is_stable():
    assert security.current_machine_id() == security.current_machine_id()
    assert len(security.current_machine_id()) >= 16
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_security.py -q`
Expected: FAIL（module not found）。

- [ ] **Step 3: 实现 `security.py`**

- `dpapi_available()` 用 `sys.platform == "win32"`。
- `protect_secret` / `unprotect_secret` 用 `ctypes` 调 `CryptProtectData` / `CryptUnprotectData`，`DATA_BLOB` 结构字段为 `cbData: DWORD`、`pbData: POINTER(c_char)`；`CRYPTPROTECT_UI_FORBIDDEN = 0x1`；输出块用 `LocalFree` 释放。失败抛 `SecurityError`。
- `hash_password`：`salt = os.urandom(16)`，`hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)`，返回 `(hash.hex(), salt.hex())`。
- `verify_password`：用 `hmac.compare_digest` 比较；任何格式错误返回 `False`。
- `current_machine_id()`：Windows 读注册表 `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`（`winreg`），取不到则回退 `platform.node()`；与 `getpass.getuser()` 拼接后 SHA-256，返回 hex。

- [ ] **Step 4: 运行安全测试**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_security.py -q`
Expected: PASS（Windows 上 DPAPI 测试实际执行）。

- [ ] **Step 5: 提交**

```bash
git add servermonitor-main/servermonitor-main/servermanage/security.py servermonitor-main/servermonitor-main/tests/test_security.py
git commit -m "feat: add DPAPI secret storage and password hashing primitives"
```

---

### Task 3: 设置与秘密的 SQLite 存储

**Files:**
- Modify: `servermonitor-main/servermonitor-main/servermanage/storage.py:29-148, 178-186`
- Test: `servermonitor-main/servermonitor-main/tests/test_storage_extended.py`

**Interfaces:**
- Produces:
  - 表 `app_settings(section TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)`
  - 表 `app_secrets(name TEXT PRIMARY KEY, ciphertext BLOB NOT NULL, updated_at TEXT NOT NULL)`
  - `save_app_settings(section: str, payload: dict, db_path: Path) -> None`
  - `load_app_settings(db_path: Path) -> dict[str, dict]`
  - `delete_app_settings(section: str, db_path: Path) -> None`
  - `set_secret(name: str, ciphertext: bytes, db_path: Path) -> None`
  - `get_secret(name: str, db_path: Path) -> bytes | None`
  - `delete_secret(name: str, db_path: Path) -> None`
  - `list_secret_names(db_path: Path) -> list[str]`

- [ ] **Step 1: 写失败测试**

```python
def test_app_settings_roundtrip_and_upsert(tmp_path):
    db = tmp_path / "s.db"
    storage.save_app_settings("report", {"daily_enabled": False}, db)
    storage.save_app_settings("report", {"daily_enabled": True}, db)
    assert storage.load_app_settings(db)["report"]["daily_enabled"] is True


def test_secret_roundtrip_and_delete(tmp_path):
    db = tmp_path / "s.db"
    storage.set_secret("smtp:password", b"ciphertext", db)
    assert storage.get_secret("smtp:password", db) == b"ciphertext"
    assert storage.list_secret_names(db) == ["smtp:password"]
    storage.delete_secret("smtp:password", db)
    assert storage.get_secret("smtp:password", db) is None


def test_settings_tables_created_by_init_storage(tmp_path):
    db = tmp_path / "s.db"
    storage.init_storage(db)
    names = {row[0] for row in sqlite3.connect(db).execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"app_settings", "app_secrets"} <= names
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_storage_extended.py -q`
Expected: FAIL（函数不存在）。

- [ ] **Step 3: 实现存储函数**

在 `storage.py` 增加 `_CREATE_SETTINGS_TABLES_SQL`，`init_storage()` 末尾执行。`payload` 用现有 `dump_json` 写入、`json.loads` 读出。写函数先 `init_storage(db_path)`；读函数在 `db_path.exists()` 为 False 时返回空/None。`set_secret` 使用 `sqlite3.Binary(ciphertext)`。

- [ ] **Step 4: 运行存储测试**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_storage_extended.py -q`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add servermonitor-main/servermonitor-main/servermanage/storage.py servermonitor-main/servermonitor-main/tests/test_storage_extended.py
git commit -m "feat: persist web settings and encrypted secrets in sqlite"
```

---

### Task 4: SSH 支持内存私钥

**Files:**
- Modify: `servermonitor-main/servermonitor-main/servermanage/ssh_client.py:1-45`
- Test: `servermonitor-main/servermonitor-main/tests/test_ssh_client.py`

**Interfaces:**
- Consumes: `AuthConfig.key_data`（Task 1）。
- Produces: `_build_connect_kwargs()` 在 `auth.type == "key"` 且 `key_data` 非空时返回 `pkey=<paramiko.PKey>`；`key_path` 仍作为兼容路径。

- [ ] **Step 1: 写失败测试**

```python
def test_ssh_client_uses_inline_key(monkeypatch):
    sentinel = object()
    monkeypatch.setattr(
        ssh_client.paramiko.PKey,
        "from_private_key",
        classmethod(lambda cls, stream, password=None: sentinel),
    )
    host = HostConfig(
        name="h", host="10.0.0.1", port=22, username="u",
        auth=AuthConfig(type="key", key_data="-----BEGIN KEY-----"),
    )
    wrapper = ssh_client.SSHClientWrapper(host=host, connect_timeout=5)
    assert wrapper._build_connect_kwargs()["pkey"] is sentinel
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_ssh_client.py::test_ssh_client_uses_inline_key -q`
Expected: FAIL（未使用 `key_data`）。

- [ ] **Step 3: 实现内存私钥**

`ssh_client.py` 导入 `io`；在 key 分支：

```python
if self.host.auth.key_data:
    kwargs["pkey"] = paramiko.PKey.from_private_key(
        io.StringIO(self.host.auth.key_data),
        password=self.host.auth.passphrase or None,
    )
elif self.host.auth.key_path:
    kwargs["key_filename"] = str(Path(self.host.auth.key_path).expanduser())
    if self.host.auth.passphrase:
        kwargs["passphrase"] = self.host.auth.passphrase
```

`key_data` 与 `key_path` 都为空时抛 `ValueError("SSH key is not configured")`。

- [ ] **Step 4: 运行 SSH 测试**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_ssh_client.py -q`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add servermonitor-main/servermonitor-main/servermanage/ssh_client.py servermonitor-main/servermonitor-main/tests/test_ssh_client.py
git commit -m "feat: support inline ssh private keys for web-configured hosts"
```

---

### Task 5: SettingsService 配置合成与公开设置

**Files:**
- Create: `servermonitor-main/servermonitor-main/servermanage/settings.py`
- Test: `servermonitor-main/servermonitor-main/tests/test_settings_service.py`

**Interfaces:**
- Consumes: Task 1 `load_config_from_mapping`、Task 2 security、Task 3 storage。
- Produces:
  - `class SettingsError(ValueError)`
  - `class SettingsService`
  - `SettingsService(*, config_path: Path, db_path: Path, base_config: AppConfig | None = None)`
  - `load() -> AppConfig`
  - `is_writable() -> bool`
  - `setup_required() -> bool`
  - `public_settings() -> dict[str, Any]`
  - `save_section(section: str, payload: dict[str, Any]) -> AppConfig`
  - 分区名常量：`monitoring`、`dashboard`、`alerts`、`report`、`disk_health`、`ssh`
  - 秘密名常量：`SECRET_SMTP_PASSWORD="smtp:password"`、`SECRET_WEBHOOK_URL="webhook:url"`、`SECRET_ADMIN="dashboard:admin_password"`、`SECRET_SESSION="dashboard:session_secret"`

`public_settings()` 返回：

```json
{
  "writable": true,
  "setup_required": false,
  "monitoring": {"timezone": "Asia/Shanghai", "poll_interval_seconds": 600,
                 "disk_poll_interval_seconds": 86400, "concurrency": 8, "retention_days": 90},
  "dashboard": {"host": "0.0.0.0", "port": 8080, "username": "admin",
                "session_lifetime_hours": 12},
  "ssh": {"connect_timeout": 10, "command_timeout": 20},
  "alerts": {"enabled": true, "desktop_notification": true, "email": false,
             "webhook": {"enabled": false, "type": "wecom", "url_configured": false},
             "thresholds": {"cpu_percent": 90, "memory_percent": 90,
                             "disk_percent": 90, "gpu_memory_percent": 90,
                             "disk_temperature_c": 55},
             "cooldown_minutes": 60, "repeat_while_active": false, "offline_failures": 2},
  "report": {"daily_enabled": true, "daily_time": "09:00",
             "weekly": {"enabled": true, "subject_prefix": "[Server Weekly Report]",
                        "busy_threshold": 70.0, "idle_threshold": 20.0,
                        "time": "16:00", "weekday": 4}},
  "disk_health": {"enabled": true, "use_sudo": true,
                  "storcli_candidates": ["storcli", "storcli64"],
                  "rules": {"alert_on_media_errors": true, "alert_on_other_errors": true,
                            "alert_on_predictive_failure": true, "alert_on_smart_flag": true,
                            "alert_on_state_not_optimal": true, "alert_on_error_increase": true}},
  "hosts": [{"name": "a100", "host": "202.119.189.245", "port": 22, "username": "zhouyc",
             "auth_type": "key", "key_configured": true, "password_configured": false,
             "passphrase_configured": false, "tags": [], "disk_mounts": ["/", "/data"],
             "disk_health": {"enabled": true, "storcli_path": null, "use_sudo": true}}]
}
```

- [ ] **Step 1: 写失败测试**

```python
def _service(tmp_path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("servers: []\nreport:\n  subject_prefix: '[D]'\n", encoding="utf-8")
    db = tmp_path / "monitor.db"
    return SettingsService(config_path=cfg, db_path=db)


def test_empty_servers_start_with_setup_required(tmp_path, monkeypatch):
    monkeypatch.delenv("DASHBOARD_PASSWORD", raising=False)
    svc = _service(tmp_path)
    assert svc.setup_required() is True
    assert svc.load().servers == []


def test_save_report_section_persists_and_loads(tmp_path):
    svc = _service(tmp_path)
    cfg = svc.save_section("report", {"daily_enabled": False, "daily_time": "08:30",
                                      "weekly": {"enabled": False}})
    assert cfg.report.daily_enabled is False
    assert svc.load().report.weekly.enabled is False


def test_save_alerts_thresholds(tmp_path):
    svc = _service(tmp_path)
    cfg = svc.save_section("alerts", {"thresholds": {"disk_percent": 80}})
    assert cfg.alerts.thresholds.disk_percent == 80


def test_public_settings_masks_smtp_password(tmp_path, monkeypatch):
    monkeypatch.setenv("SMTP_PW", "topsecret")
    cfg = tmp_path / "config.yaml"
    cfg.write_text("servers: []\nsmtp:\n  host: mail\n  port: 465\n  username: u\n"
                   "  password_env: SMTP_PW\n  use_ssl: true\n  from_addr: a@b\n"
                   "  to_addrs: [c@d]\n", encoding="utf-8")
    svc = SettingsService(config_path=cfg, db_path=tmp_path / "m.db")
    payload = svc.public_settings()
    assert payload["alerts"]["email"] is True
    assert "topsecret" not in repr(payload)


def test_non_windows_is_read_only(tmp_path, monkeypatch):
    import sys
    monkeypatch.setattr(sys, "platform", "linux")
    svc = _service(tmp_path)
    assert svc.is_writable() is False
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_settings_service.py -q`
Expected: FAIL（module not found）。

- [ ] **Step 3: 实现 SettingsService 配置合成**

要求：
- `__init__` 读取 `base_config`（未传时 `load_config(config_path, allow_empty_servers=True, allow_missing_secrets=True)`），保存 `base_config` 与 `db_path`，调用 `_ensure_secret_session()`（Windows 且无 session secret 时生成并加密存储）。
- `load()`：`sections = storage.load_app_settings(db_path)`，以 base 为底，按 section 覆盖；秘密用 `storage.get_secret` 解密读取；返回 `AppConfig`。
- 只允许 `save_section` 的六个分区；payload 必须为 dict，否则 `SettingsError`。
- `save_section("alerts", payload)` 中的 `webhook.url`（如客户端提供）写入 `app_secrets['webhook:url']`，`payload` 中保存 `url_configured`，不存明文。
- 保存时 `save_app_settings(section, sanitized_payload, db_path)`，返回 `self.load()`。
- `setup_required()`：若 `security` 区 `force_setup` 为 true → True；若 `app_secrets` 有 `dashboard:admin_password` → False；否则若 base dashboard 有明文 env 密码且可写 → 在 `load()` 时自动哈希并存储 → False；否则 True。
- `is_writable()`：`security.dpapi_available()`。
- `public_settings()`：输出 Interfaces 中的结构，所有秘密只输出 `*_configured` 布尔；`hosts` 暂返回空列表（Task 6 补齐）。

- [ ] **Step 4: 运行设置服务测试**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_settings_service.py -q`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add servermonitor-main/servermonitor-main/servermanage/settings.py servermonitor-main/servermonitor-main/tests/test_settings_service.py
git commit -m "feat: compose effective config from sqlite settings"
```

---

### Task 6: 主机 CRUD、秘密迁移、换机重置与管理员密码

**Files:**
- Modify: `servermonitor-main/servermonitor-main/servermanage/settings.py`
- Test: `servermonitor-main/servermonitor-main/tests/test_settings_service.py`

**Interfaces:**
- Produces（在 `SettingsService` 上）：
  - `list_hosts() -> list[dict]`
  - `get_host(name: str) -> dict | None`
  - `upsert_host(name: str, payload: dict[str, Any]) -> AppConfig`
  - `delete_host(name: str) -> AppConfig`
  - `verify_admin(username: str, password: str) -> bool`
  - `set_admin_password(current_password: str | None, new_password: str, *, username: str | None = None) -> None`
  - 秘密名：`host:<name>:ssh_password`、`host:<name>:ssh_key`、`host:<name>:ssh_passphrase`
- 主机 payload：`name,host,port,username,tags,disk_mounts,auth_type,key_path,password,private_key,passphrase,clear_secrets,disk_health`
  - `password/private_key/passphrase` 为只写字段，绝不回显。
  - `clear_secrets` 是列表，元素 `password|key|passphrase`。

- [ ] **Step 1: 写失败测试**

```python
def test_upsert_host_stores_and_masks_secret(tmp_path):
    svc = _service(tmp_path)
    svc.set_admin_password(None, "AdminPass!23", username="admin")
    cfg = svc.upsert_host("a100", {
        "host": "202.119.189.245", "port": 22, "username": "zhouyc",
        "auth_type": "password", "password": "ssh-secret",
        "disk_mounts": ["/", "/data"],
    })
    assert [h.name for h in cfg.servers] == ["a100"]
    assert cfg.servers[0].auth.password == "ssh-secret"
    assert "ssh-secret" not in repr(svc.public_settings())


def test_updating_host_without_password_keeps_existing_secret(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host("h", {"host": "1.2.3.4", "username": "u",
                          "auth_type": "password", "password": "keepme"})
    svc.upsert_host("h", {"host": "1.2.3.5", "username": "u", "auth_type": "password"})
    assert svc.load().servers[0].auth.password == "keepme"


def test_delete_host_removes_secrets(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host("h", {"host": "1.2.3.4", "username": "u",
                          "auth_type": "password", "password": "x"})
    svc.delete_host("h")
    assert svc.load().servers == []
    assert storage.get_secret("host:h:ssh_password", svc.db_path) is None


def test_verify_admin_and_change_password(tmp_path):
    svc = _service(tmp_path)
    svc.set_admin_password(None, "OldPass!23", username="admin")
    assert svc.verify_admin("admin", "OldPass!23") is True
    assert svc.verify_admin("admin", "wrong") is False
    svc.set_admin_password("OldPass!23", "AdminPass!23")
    assert svc.verify_admin("admin", "AdminPass!23") is True


def test_machine_mismatch_forces_setup_and_clears_secrets(tmp_path):
    svc = _service(tmp_path)
    svc.set_admin_password(None, "Pass!23", username="admin")
    storage.save_app_settings("security", {"machine_id": "other-machine"}, svc.db_path)
    svc2 = SettingsService(config_path=svc.config_path, db_path=svc.db_path)
    assert svc2.setup_required() is True
    assert storage.get_secret("dashboard:admin_password", svc.db_path) is None


def test_legacy_env_password_migrates_to_dpapi(tmp_path, monkeypatch):
    monkeypatch.setenv("DASHBOARD_PASSWORD", "LegacyPass!23")
    cfg = tmp_path / "config.yaml"
    cfg.write_text("servers: []\n", encoding="utf-8")
    svc = SettingsService(config_path=cfg, db_path=tmp_path / "m.db")
    svc.load()
    if security.dpapi_available():
        assert storage.get_secret("dashboard:admin_password", svc.db_path) is not None
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_settings_service.py -q`
Expected: FAIL。

- [ ] **Step 3: 实现主机与管理员逻辑**

要求：
- `upsert_host` 校验 `name/host/username/auth_type`；端口默认 22；`disk_mounts` 默认 `["/", "/data"]`。
- password auth：新明文写 `host:<name>:ssh_password`；未提供且已有秘密则保留；无秘密则 `SettingsError("SSH 密码未设置")`。
- key auth：`private_key` 写 `host:<name>:ssh_key`；`key_path` 可保存到 settings；`passphrase` 写 `host:<name>:ssh_passphrase`；新机无任何 key 来源则 `SettingsError("SSH 私钥未设置")`。
- `hosts` section 存 `{"hosts":[...]}` 列表（不含明文秘密）；`load()` 的 servers 从该 section 构建；无 `hosts` section 时用 base `config.servers`（并迁移）。
- `list_hosts()` 从 `public_settings()["hosts"]` 返回。
- `delete_host` 删除三个秘密并重写 hosts section。
- `set_admin_password`: 若已有管理员哈希且 `current_password` 为空或不匹配 → `SettingsError("当前密码不正确")`；新密码长度 ≥8；写 `SECRET_ADMIN` 为 DPAPI 加密 JSON `{"username","hash","salt","iterations"}`；清理 `security.force_setup`；写入当前 `machine_id`；同时生成新 session secret 并写 `SECRET_SESSION`。
- `verify_admin`: 解密 JSON，检查 username 与 PBKDF2；无哈希时回退 base dashboard 明文密码仅用于迁移期。
- `__init__` 调用 `_ensure_machine_binding()`：读 `security.machine_id`；若存在且不等于 `security.current_machine_id()` → 删除所有秘密、`save_app_settings("security",{"machine_id":current,"force_setup":True})`；若不存在 → 写入当前机器 id。
- `_migrate_legacy_secrets()`：仅 Windows 且可写、`security.migrated_at` 不存在时执行；从 base config 的 smtp.password、webhook.url、dashboard.password、servers 的 auth 读取并 `protect_secret` 存储；key_path 若存在则读文本存 `ssh_key`；成功后写 `migrated_at`；任一失败写 `migration_error` 并继续启动。

- [ ] **Step 4: 运行设置服务测试**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_settings_service.py tests/test_security.py tests/test_storage_extended.py -q`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add servermonitor-main/servermonitor-main/servermanage/settings.py servermonitor-main/servermonitor-main/tests/test_settings_service.py
git commit -m "feat: manage hosts, secrets, migration and admin password"
```

---

### Task 7: Web 首次设置、登录哈希、CSRF 与限速

**Files:**
- Modify: `servermonitor-main/servermonitor-main/servermanage/web/__init__.py:26-57`
- Modify: `servermonitor-main/servermonitor-main/servermanage/web/routes.py:314-366`
- Create: `servermonitor-main/servermonitor-main/servermanage/web/templates/setup.html`
- Test: `servermonitor-main/servermonitor-main/tests/test_web_setup.py`

**Interfaces:**
- Consumes: `SettingsService`（Task 5/6）。
- Produces:
  - `create_app(*, config: AppConfig, db_path: Path, settings_service=None, on_config_changed: Callable[[AppConfig], None] | None = None) -> Flask`
  - `app.config["SETTINGS_SERVICE"]`、`app.config["ON_CONFIG_CHANGED"]`
  - 路由 `GET/POST /setup`
  - `_csrf_token() -> str`、`_require_csrf()`、`_refresh_config(app)`

- [ ] **Step 1: 写失败测试**

```python
def _app(tmp_path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "m.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    svc = SettingsService(config_path=cfg_path, db_path=db, base_config=base)
    return create_app(config=svc.load(), db_path=db, settings_service=svc)


def test_setup_required_redirects_to_setup(tmp_path):
    client = _app(tmp_path).test_client()
    resp = client.get("/")
    assert resp.status_code == 302
    assert "/setup" in resp.headers["Location"]


def test_setup_rejects_non_loopback(tmp_path):
    client = _app(tmp_path).test_client()
    resp = client.post("/setup", data={"username": "admin", "password": "AdminPass!23",
                                       "confirm": "AdminPass!23"},
                       environ_base={"REMOTE_ADDR": "10.0.0.9"})
    assert resp.status_code == 403


def test_setup_sets_password_and_then_login(tmp_path):
    client = _app(tmp_path).test_client()
    page = client.get("/setup").get_data(as_text=True)
    token = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
    resp = client.post("/setup", data={"username": "admin", "password": "AdminPass!23",
                                       "confirm": "AdminPass!23", "csrf_token": token})
    assert resp.status_code == 302
    login = client.post("/login", data={"username": "admin", "password": "AdminPass!23"})
    assert login.status_code == 302
    assert "/api/overview" not in login.headers["Location"]


def test_login_rate_limited(tmp_path):
    client = _app(tmp_path).test_client()
    for _ in range(6):
        resp = client.post("/login", data={"username": "admin", "password": "bad"})
    assert resp.status_code == 429
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_web_setup.py -q`
Expected: FAIL。

- [ ] **Step 3: 实现 Web 首次设置与鉴权**

- `create_app` 接收并保存 `settings_service` / `on_config_changed`；`app.secret_key` 优先 `config.dashboard.session_secret`，否则生成随机值。
- `register_routes` 的 `before_request`：
  1. 放行 `/static/*`、`/setup`；
  2. 若 `settings_service.setup_required()`：`/api/*` 返回 `428 {"error":"setup_required"}`，其他页面 302 `/setup`；
  3. 现有登录 gate 原样（`/login` 放行）。
- `GET /setup`：非 loopback 返回 403；渲染 `setup.html`（用户名、密码、确认密码、csrf_token）。
- `POST /setup`：非 loopback 403；校验 csrf；两次密码一致且 ≥8；`settings_service.set_admin_password(None, password, username=username)`；`_refresh_config(app)`；302 `/login`。
- `login_submit`：存在 `settings_service` 时用 `settings_service.verify_admin(username, password)`，否则保留旧明文比较；同一 `remote_addr` 60 秒内第 6 次失败返回 429。
- CSRF：session 中 `csrf_token`；所有 `POST/PUT/DELETE`（`/login` 除外，登录表单改为不要求）在 `before_request` 校验表单字段 `csrf_token` 或请求头 `X-CSRF-Token`；失败 400。
- `_refresh_config(app)`：`new = settings_service.load()`；更新 `app.config["CONFIG"]/["config"]`；`app.secret_key = new.dashboard.session_secret or app.secret_key`；调用 `on_config_changed(new)`。
- 新增 `setup.html`：沿用 `base.html`，表单字段、错误提示、`<input type="hidden" name="csrf_token">`。

- [ ] **Step 4: 运行 Web 设置测试**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_web_setup.py tests/test_web_api.py -q`
Expected: PASS（旧 web_api 不传 settings_service，仍可用）。

- [ ] **Step 5: 提交**

```bash
git add servermonitor-main/servermonitor-main/servermanage/web/__init__.py servermonitor-main/servermonitor-main/servermanage/web/routes.py servermonitor-main/servermonitor-main/servermanage/web/templates/setup.html servermonitor-main/servermonitor-main/tests/test_web_setup.py
git commit -m "feat: add first-run setup, hashed login and csrf protection"
```

---

### Task 8: 设置 API（分区保存 / 主机 CRUD / 连通性测试 / 改密）

**Files:**
- Modify: `servermonitor-main/servermonitor-main/servermanage/web/routes.py`
- Test: `servermonitor-main/servermonitor-main/tests/test_settings_api.py`

**Interfaces:**
- Produces:
  - `GET /api/settings` → `public_settings()` + `writable/setup_required`
  - `PUT /api/settings/<section>` body 为 section payload
  - `GET /api/settings/hosts`
  - `PUT /api/settings/hosts/<name>`
  - `DELETE /api/settings/hosts/<name>`
  - `POST /api/settings/password` body `{"current_password","new_password","new_username"}`
  - `POST /api/settings/test-ssh` body 同 host payload（不含保存）
  - `POST /api/settings/test-email` body `{"host","port","username","password","use_ssl","from_addr","to_addrs"}`
  - `POST /api/settings/test-webhook` body `{"type","url"}`
- 所有写路由：非 `settings_service.is_writable()` → `409 {"error":"settings_not_writable"}`；无 settings_service → 404。

- [ ] **Step 1: 写失败测试**

```python
def test_get_settings_returns_masked_payload(client):
    resp = client.get("/api/settings")
    body = resp.get_json()
    assert body["monitoring"]["poll_interval_seconds"] == 600
    assert "password" not in repr(body["hosts"])


def test_put_report_section_persists(client):
    resp = client.put("/api/settings/report", json={"daily_enabled": False})
    assert resp.status_code == 200
    assert resp.get_json()["ok"] is True


def test_put_settings_rejected_when_not_writable(client, monkeypatch):
    monkeypatch.setattr(client.application.config["SETTINGS_SERVICE"],
                        "is_writable", lambda: False)
    resp = client.put("/api/settings/report", json={"daily_enabled": True})
    assert resp.status_code == 409


def test_host_crud(client):
    payload = {"host": "10.0.0.5", "port": 22, "username": "u",
               "auth_type": "password", "password": "pw"}
    assert client.put("/api/settings/hosts/edge", json=payload).status_code == 200
    assert client.get("/api/settings/hosts").get_json()["hosts"][0]["name"] == "edge"
    assert client.delete("/api/settings/hosts/edge").status_code == 200


def test_change_password_requires_current(client):
    resp = client.post("/api/settings/password",
                       json={"current_password": "bad", "new_password": "AdminPass!23"})
    assert resp.status_code == 400
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_settings_api.py -q`
Expected: FAIL。

- [ ] **Step 3: 实现设置 API**

- 统一 helper `_settings_or_404(app)`、`_ensure_writable(svc)`。
- `PUT /api/settings/<section>`：允许 `monitoring/dashboard/alerts/report/disk_health/ssh`；`settings_service.save_section(section, payload)`，`_refresh_config(app)`；返回 `{"ok":True,"restart_required": section in {"dashboard"}}`。
- hosts 路由调用 `upsert_host/delete_host/list_hosts`，每次 `_refresh_config`。
- `password` 路由：`set_admin_password(current,new,username=new_username)`；`_refresh_config`；返回 `{"ok":True}`；`SettingsError` → 400。
- `test-ssh`：构造临时 `HostConfig`，`SSHClientWrapper.run("echo ok", timeout=config.ssh.command_timeout)`，返回 `{"ok":True,"detail":stdout}` 或 `{"ok":False,"detail":str(exc)}`；不持久化。
- `test-email`：只做 `smtplib` 连接+登录，不发送；`test-webhook` 调 `notify_webhook` 的发送函数一次。
- 所有异常只返回错误文本，不泄露堆栈/秘密。

- [ ] **Step 4: 运行设置 API 测试**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_settings_api.py tests/test_web_setup.py -q`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add servermonitor-main/servermonitor-main/servermanage/web/routes.py servermonitor-main/servermonitor-main/tests/test_settings_api.py
git commit -m "feat: expose settings management api"
```

---

### Task 9: 按主机磁盘容量监控（`/` 与 `/data`）

**Files:**
- Create: `servermonitor-main/servermonitor-main/servermanage/disk_capacity.py`
- Modify: `servermonitor-main/servermonitor-main/servermanage/storage.py:157-169, 188-247`
- Modify: `servermonitor-main/servermonitor-main/servermanage/alerts.py:97-177`
- Modify: `servermonitor-main/servermonitor-main/servermanage/web/routes.py:130-143, 207-311`
- Modify: `servermonitor-main/servermonitor-main/servermanage/app.py:187-250`
- Test: `servermonitor-main/servermonitor-main/tests/test_disk_capacity.py`

**Interfaces:**
- Produces:
  - `DEFAULT_DISK_MOUNTS = ("/", "/data")`
  - `normalize_mounts(mounts: Sequence[str] | None) -> list[str]`
  - `mount_statuses(rows: Sequence[object], mounts: Sequence[str] | None) -> list[dict]`：每项 `{"mountpoint","present","filesystem","size","used","available","percent"}`
  - `max_percent(rows: Sequence[object], mounts: Sequence[str] | None) -> float | None`
  - `storage._extract_disk_used_percent(host_report, mounts=None) -> float | None`
  - `storage.persist_host_reports(report, db_path, *, disk_mounts: Mapping[str, Sequence[str]] | None = None) -> None`
  - `alerts.evaluate_system_alerts(..., disk_percent=None, disk_mounts: list[dict] | None = None)`
  - `routes._host_row(..., disk_mounts=None)`、`_disk_percent(metrics, mounts=None)`

- [ ] **Step 1: 写失败测试**

```python
ROWS = [
    {"filesystem": "/dev/sda1", "mountpoint": "/", "size": "100G", "used": "95G", "available": "5G", "percent": "95%"},
    {"filesystem": "/dev/sdb1", "mountpoint": "/data", "size": "10T", "used": "2T", "available": "8T", "percent": "20%"},
    {"filesystem": "tmpfs", "mountpoint": "/run", "size": "1G", "used": "0", "available": "1G", "percent": "0%"},
]


def test_mount_statuses_only_configured_and_present():
    statuses = disk_capacity.mount_statuses(ROWS, ["/", "/data", "/scratch"])
    assert [s["mountpoint"] for s in statuses] == ["/", "/data", "/scratch"]
    assert statuses[0]["percent"] == 95
    assert statuses[2]["present"] is False


def test_max_percent_ignores_unconfigured_mounts():
    assert disk_capacity.max_percent(ROWS, ["/data"]) == 20.0


def test_default_mounts():
    assert disk_capacity.normalize_mounts(None) == ["/", "/data"]


def test_missing_mount_does_not_alert_but_root_does():
    from servermanage.alerts import evaluate_system_alerts
    from servermanage.models import AlertThresholds, HostMetrics
    metrics = HostMetrics(host_name="h", collected_at=None)
    events = evaluate_system_alerts(
        "h", metrics, AlertThresholds(disk_percent=90),
        disk_mounts=[{"mountpoint": "/", "present": True, "percent": 95},
                     {"mountpoint": "/data", "present": False, "percent": None}],
    )
    assert [e.fingerprint for e in events] == ["system:h:disk:/"]
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_disk_capacity.py -q`
Expected: FAIL。

- [ ] **Step 3: 实现容量过滤与接线**

- `disk_capacity.py` 支持 dict 与对象两种行（用 `getattr`/`get`）；`percent` 从 `"95%"` 或数字解析。
- `storage._extract_disk_used_percent`：`max_percent(host_report.metrics.disk_usage, mounts)`；`mounts` 为空/None 时保持旧行为（所有真实文件系统最大值）。
- `persist_host_reports`：新增 `disk_mounts` 映射；写 `host_metrics_history.disk_used_percent` 时传该主机的 mounts。
- `app.run_status_once`：构造 `mount_statuses(report.metrics.disk_usage, host.disk_mounts)`，传 `disk_mounts=` 给 `evaluate_system_alerts`，并传 `disk_mounts={h.name: h.disk_mounts}` 给 `persist_host_reports`。
- `alerts.evaluate_system_alerts`：若 `disk_mounts is not None`，逐个 present 且 percent ≥ 阈值生成事件，fingerprint `system:<host>:disk:<mountpoint>`，消息含挂载点；否则沿用旧单 `disk_percent`（fingerprint `system:<host>:disk`）。
- `routes._disk_percent(metrics, mounts)`：用 `mount_statuses` 取配置挂载点最大百分比；`_host_row` 增加 `disk_mounts` 透传；`_build_overview` 用 `{server.name: server.disk_mounts}`。

- [ ] **Step 4: 运行容量与回归测试**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_disk_capacity.py tests/test_alert_rules.py tests/test_storage_extended.py tests/test_web_api.py -q`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add servermonitor-main/servermonitor-main/servermanage/disk_capacity.py servermonitor-main/servermonitor-main/servermanage/storage.py servermonitor-main/servermonitor-main/servermanage/alerts.py servermonitor-main/servermonitor-main/servermanage/web/routes.py servermonitor-main/servermonitor-main/servermanage/app.py servermonitor-main/servermonitor-main/tests/test_disk_capacity.py
git commit -m "feat: monitor disk capacity only for configured mounts"
```

---

### Task 10: 当前登录用户展示

**Files:**
- Modify: `servermonitor-main/servermonitor-main/servermanage/web/routes.py:207-311`
- Modify: `servermonitor-main/servermonitor-main/servermanage/web/templates/overview.html:33-68`
- Modify: `servermonitor-main/servermonitor-main/servermanage/web/templates/host.html`
- Test: `servermonitor-main/servermonitor-main/tests/test_web_api.py`

**Interfaces:**
- `_host_row` 增加：
  - `logged_in_user_count: int`（去重用户名数）
  - `logged_in_sessions: int`（`who` 行数）
- `_build_host_detail` 无需改结构：`metrics.logged_in_users` 已含 `username/terminal/login_at/remote_host`。

- [ ] **Step 1: 写失败测试**

```python
def test_overview_counts_distinct_logged_in_users(tmp_path):
    # 构造快照 metrics.logged_in_users = 同一用户两个终端 + 另一个用户
    ...
    row = routes._build_overview(config, db)["hosts"][0]
    assert row["logged_in_user_count"] == 2
    assert row["logged_in_sessions"] == 3
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_web_api.py -q`
Expected: FAIL。

- [ ] **Step 3: 实现计数与页面**

`_host_row` 提取 `users = metrics.get("logged_in_users") or []`；`usernames = {u.get("username") for u in users if isinstance(u, dict) and u.get("username")}`。overview 表加“登录用户”列显示 `{{ host.logged_in_user_count }}`。`host.html` 在“指标详情”后新增“当前登录用户”卡片，表格列：用户名/终端/登录时间/来源 IP，无数据时“暂无登录用户”。

- [ ] **Step 4: 运行测试**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_web_api.py -q`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add servermonitor-main/servermonitor-main/servermanage/web/routes.py servermonitor-main/servermonitor-main/servermanage/web/templates/overview.html servermonitor-main/servermonitor-main/servermanage/web/templates/host.html servermonitor-main/servermonitor-main/tests/test_web_api.py
git commit -m "feat: show current logged-in users per host"
```

---

### Task 11: 设置页面与前端交互

**Files:**
- Modify: `servermonitor-main/servermonitor-main/servermanage/web/templates/settings.html`
- Modify: `servermonitor-main/servermonitor-main/servermanage/web/routes.py:445-449`
- Create: `servermonitor-main/servermonitor-main/servermanage/web/static/settings.js`
- Modify: `servermonitor-main/servermonitor-main/servermanage/web/static/style.css`
- Test: `servermonitor-main/servermonitor-main/tests/test_settings_page.py`

**Interfaces:**
- Consumes: `GET /api/settings`、`PUT /api/settings/*`、hosts API、password API、test APIs（Task 8）。
- Produces: `/settings` 渲染 `settings.html`，`settings_service.public_settings()` 作为初始数据。

- [ ] **Step 1: 写失败测试**

```python
def test_settings_page_has_all_sections(client):
    html = client.get("/settings").get_data(as_text=True)
    for label in ["监控与存储", "主机与 SSH", "通知", "报告", "磁盘健康", "看板与安全"]:
        assert label in html
    assert 'id="settings-root"' in html
    assert "settings.js" in html


def test_settings_page_readonly_when_not_writable(client, monkeypatch):
    monkeypatch.setattr(client.application.config["SETTINGS_SERVICE"],
                        "is_writable", lambda: False)
    html = client.get("/settings").get_data(as_text=True)
    assert "只读" in html
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_settings_page.py -q`
Expected: FAIL。

- [ ] **Step 3: 实现设置页**

- `settings.html`：`id="settings-root" data-csrf="{{ csrf_token() }}"`；六个 `section.card`，每个有 `data-section="monitoring|hosts|alerts|report|disk_health|dashboard"`、表单字段、保存按钮；主机列表与新增/编辑表单；改密表单；`<script src="{{ url_for('static', filename='settings.js') }}"></script>`。只读时在每张卡显示“只读”徽标并禁用保存。
- `settings.js`：加载时读取 `window.__SETTINGS__`（模板注入）或 fetch `/api/settings`；`saveSection(name)` 发 `PUT /api/settings/<name>` 带 `X-CSRF-Token`；主机 CRUD 发 `PUT/DELETE /api/settings/hosts/<name>`；测试按钮发 `POST /api/settings/test-*`；密码表单发 `POST /api/settings/password`；所有请求 `credentials: "same-origin"`；成功后显示“已保存”；401 → `location.href="/login"`；409 → 显示只读提示；不使用 innerHTML 插值用户数据。
- `routes.settings_page`：`render_template("settings.html", active_page="settings", settings=svc.public_settings())`。

- [ ] **Step 4: 运行页面测试**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_settings_page.py tests/test_settings_api.py -q`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add servermonitor-main/servermonitor-main/servermanage/web/templates/settings.html servermonitor-main/servermonitor-main/servermanage/web/routes.py servermonitor-main/servermonitor-main/servermanage/web/static/settings.js servermonitor-main/servermonitor-main/servermanage/web/static/style.css servermonitor-main/servermonitor-main/tests/test_settings_page.py
git commit -m "feat: build in-browser settings page"
```

---

### Task 12: 服务启动接线与配置热应用

**Files:**
- Modify: `servermonitor-main/servermonitor-main/servermanage/app.py:119-132, 140-175, 413-428, 448-485`
- Test: `servermonitor-main/servermonitor-main/tests/test_app_service.py`

**Interfaces:**
- Produces:
  - `load_runtime_with_settings(config_path: Path, dotenv_path: Path | None = None) -> tuple[AppConfig, Path, SettingsService]`
  - `MonitorService.apply_config(new_config: AppConfig) -> None`
  - `main()` 使用 `load_runtime_with_settings`，并把 `settings_service` 传给 `create_app`。

- [ ] **Step 1: 写失败测试**

```python
def test_apply_config_updates_scheduler_interval(tmp_path):
    service = MonitorService(_config(), db_path=tmp_path / "m.db")
    new = replace(service.config, app=replace(service.config.app, poll_interval_seconds=120))
    service.apply_config(new)
    assert service.config.app.poll_interval_seconds == 120


def test_apply_config_rebuilds_notifier_and_engine(tmp_path):
    service = MonitorService(_config(), db_path=tmp_path / "m.db")
    old_engine = service.engine
    service.apply_config(replace(service.config, alerts=replace(service.config.alerts, enabled=False)))
    assert service.engine is not old_engine


def test_load_runtime_with_settings_returns_service(tmp_path, monkeypatch):
    monkeypatch.setenv("DASHBOARD_PASSWORD", "Pass!23")
    cfg = tmp_path / "config.yaml"
    cfg.write_text("servers: []\n", encoding="utf-8")
    config, db_path, settings = load_runtime_with_settings(cfg)
    assert db_path.exists()
    assert settings.setup_required() is False or True
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_app_service.py -q`
Expected: FAIL。

- [ ] **Step 3: 实现启动接线**

- `load_runtime_with_settings`：加载 dotenv（若有）→ `base = load_config(path, allow_empty_servers=True, allow_missing_secrets=True)` → `db_path = base.storage.db_path` → `init_storage(db_path)` → `settings = SettingsService(config_path=Path(path), db_path=db_path, base_config=base)` → `config = settings.load()` → 返回。
- `MonitorService.apply_config(new_config)`：
  1. 若 `self._scheduler is not None`：`self._scheduler.stop()`，`self._scheduler = None`；
  2. `self.config = new_config`；`self._tz = resolve_timezone(new_config.app.timezone)`；
  3. `self._notifier = Notifier(smtp=new_config.smtp)`；`self.engine = AlertEngine(self.db_path, new_config.alerts, self._notifier, clock=self._clock)`；
  4. 若原先已启动（用 `self._running` 记录），调用 `self.start()`。
- `start()` 设 `self._running=True`；`stop()` 设 False。
- `main()`：`config, db_path, settings = load_runtime_with_settings(...)`；`service = MonitorService(config, db_path=db_path)`；`create_app(config=config, db_path=db_path, settings_service=settings, on_config_changed=service.apply_config)`。

- [ ] **Step 4: 运行应用测试**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_app_service.py tests/test_scheduler.py -q`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add servermonitor-main/servermonitor-main/servermanage/app.py servermonitor-main/servermonitor-main/tests/test_app_service.py
git commit -m "feat: wire settings service into startup and live config apply"
```

---

### Task 13: 打包、示例配置、版本与文档

**Files:**
- Modify: `servermonitor-main/servermonitor-main/servermanage/packaging/servermonitor.spec`（仓库实际为 `packaging/servermonitor.spec`）
- Modify: `servermonitor-main/servermonitor-main/pyproject.toml`
- Modify: `servermonitor-main/servermonitor-main/config/config.yaml.example`
- Modify: `servermonitor-main/servermonitor-main/config/.env.example`
- Modify: `servermonitor-main/servermonitor-main/README.md`
- Modify: `servermonitor-main/servermonitor-main/使用说明.txt`（若在打包目录；源码模板同路径）
- Test: `servermonitor-main/servermonitor-main/tests/test_config_example.py`

**Interfaces:**
- 版本 `1.1.0`；示例配置新增 `disk_mounts: ["/", "/data"]`；启动脚本允许无 `.env`。

- [ ] **Step 1: 写失败测试**

```python
def test_config_example_has_disk_mounts_and_defaults():
    text = Path("config/config.yaml.example").read_text(encoding="utf-8")
    assert "disk_mounts:" in text
    assert '"/data"' in text
    assert "poll_interval_seconds: 600" in text
    assert "disk_poll_interval_seconds: 86400" in text


def test_project_version_is_1_1_0():
    text = Path("pyproject.toml").read_text(encoding="utf-8")
    assert 'version = "1.1.0"' in text
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_config_example.py -q`
Expected: FAIL。

- [ ] **Step 3: 更新打包与文档**

- `packaging/servermonitor.spec`：`hiddenimports` 追加 `servermanage.settings`、`servermanage.security`、`servermanage.disk_capacity`；保持 `excludes` 现有列表。
- `pyproject.toml`：`version = "1.1.0"`。
- `config/config.yaml.example`：每台 server 示例加 `disk_mounts: ["/", "/data"]`；注释说明可在网页修改；保留密码/密钥两种 auth 示例。
- `config/.env.example`：说明 `.env` 仅首次迁移用，之后秘密由网页保存并加密；可留空。
- `启动.bat`：`--dotenv "config\.env"` 仅在文件存在时传入（用 `if exist` 分支），否则只传 `--config`。
- `README.md` / `使用说明.txt`：新增“网页设置”章节，说明首次 `/setup`、换电脑强制重设、秘密不回显、Docker 只读限制。

- [ ] **Step 4: 运行示例与打包测试**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_config_example.py -q`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add servermonitor-main/servermonitor-main/packaging/servermonitor.spec servermonitor-main/servermonitor-main/pyproject.toml servermonitor-main/servermonitor-main/config/config.yaml.example servermonitor-main/servermonitor-main/config/.env.example servermonitor-main/servermonitor-main/README.md servermonitor-main/servermonitor-main/tests/test_config_example.py
git commit -m "chore: package and document v1.1 web settings release"
```

---

### Task 14: 端到端设置流程与全量回归

**Files:**
- Modify: `servermonitor-main/servermonitor-main/tests/test_integration_smoke.py`
- Test: `servermonitor-main/servermonitor-main/tests/test_integration_smoke.py`

**Interfaces:**
- Consumes: Task 5–13 全部。
- Produces: 一个覆盖“首次设置→登录→保存主机→保存报告/磁盘→概览体现登录用户与挂载点”的集成测试。

- [ ] **Step 1: 写失败测试**

```python
def test_web_settings_end_to_end(tmp_path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text("servers: []\n", encoding="utf-8")
    base = load_config_from_mapping({}, allow_empty_servers=True)
    settings = SettingsService(config_path=config_path, db_path=tmp_path / "m.db",
                               base_config=base)
    app = create_app(config=settings.load(), db_path=tmp_path / "m.db",
                     settings_service=settings,
                     on_config_changed=lambda cfg: None)
    client = app.test_client()

    page = client.get("/setup").get_data(as_text=True)
    token = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
    client.post("/setup", data={"username": "admin", "password": "E2ePass!23",
                                "confirm": "E2ePass!23", "csrf_token": token})
    client.post("/login", data={"username": "admin", "password": "E2ePass!23"})

    with client.session_transaction() as sess:
        token = sess["csrf_token"]
    headers = {"X-CSRF-Token": token}
    assert client.put("/api/settings/hosts/a100", headers=headers, json={
        "host": "202.119.189.245", "username": "zhouyc", "auth_type": "key",
        "private_key": "FAKE", "disk_mounts": ["/", "/data"],
    }).status_code == 200
    assert client.put("/api/settings/report", headers=headers,
                      json={"daily_enabled": False}).status_code == 200
    assert client.put("/api/settings/monitoring", headers=headers,
                      json={"poll_interval_seconds": 300}).status_code == 200

    saved = settings.load()
    assert saved.servers[0].name == "a100"
    assert saved.servers[0].disk_mounts == ["/", "/data"]
    assert saved.report.daily_enabled is False
    assert saved.app.poll_interval_seconds == 300
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest tests/test_integration_smoke.py::test_web_settings_end_to_end -q`
Expected: FAIL（流程未接线）。

- [ ] **Step 3: 修复接线并补集成断言**

- 若失败点来自 CSRF/session 或 `_refresh_config`，修对应路由；不得在测试中绕过 CSRF。
- 追加断言：`/api/overview` 返回 `logged_in_user_count` 与 `disk_mounts` 字段；`/settings` 含六个分区。
- 保持现有 `test_run_once...` 测试不变。

- [ ] **Step 4: 运行全量测试**

Run: `cd servermonitor-main/servermonitor-main && python -m pytest -q`
Expected: 全部 PASS（包括原有 254 个测试）。

- [ ] **Step 5: 提交**

```bash
git add servermonitor-main/servermonitor-main/tests/test_integration_smoke.py
git commit -m "test: cover end-to-end web settings flow"
```

---

## Self-Review

**1. Spec coverage**
- 网页修改主机/SSH：Task 4/6/8/11。
- 邮件/Webhook：Task 5/8/11。
- 看板密码/用户名：Task 6/7/8。
- 告警阈值、报告启停与时间、磁盘健康规则：Task 5/8/11。
- 每台主机容量监控目录：Task 1/9/11。
- 当前登录用户：Task 10。
- 首次 `/setup`、换机重置、DPAPI、CSRF、限速：Task 2/5/6/7。
- 打包与文档：Task 13。
缺失：无（Docker/Linux 只读模式由 Task 5 `is_writable` + Task 8 `409` 覆盖）。

**2. Step scan**
每个 Step 都是单一动作（写指定测试、跑指定命令、实现指定签名、提交）。没有“处理边界情况”之类空步骤。

**3. Type consistency**
`HostConfig.disk_mounts`、`AuthConfig.key_data`、`SettingsService` 方法签名在 Task 1/5/6/8/12 中一致；`mount_statuses` 在 Task 9/10 中一致；`load_runtime_with_settings` 在 Task 12/13 中一致。

**4. Review Focus**
五行都已落到测试：
- 换机强制 setup → Task 6 `test_machine_mismatch_forces_setup_and_clears_secrets`。
- 未重输秘密保留 → Task 6 `test_updating_host_without_password_keeps_existing_secret`。
- YAML/.env 迁移 → Task 6 `test_legacy_env_password_migrates_to_dpapi`。
- 缺失挂载点不告警、根目录仍告警 → Task 9 `test_missing_mount_does_not_alert_but_root_does`。
- 保存配置时调度重建 → Task 12 `test_apply_config_rebuilds_notifier_and_engine` + `test_apply_config_updates_scheduler_interval`。

**5. Proportion**
计划约 700 行，核心是接口签名、测试断言与接线位置；没有逐行转写实现代码。
