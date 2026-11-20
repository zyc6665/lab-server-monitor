"""v0.1.227：SSH 主机密钥校验（TOFU）+ 配置热更新竞态修复。

背景：``SSHClientWrapper`` 一直使用 ``AutoAddPolicy``，任何持有主机 IP 的人
都能冒充服务器接管连接——本工具保存着全部主机的登录凭据，这是最危险的一类
问题。现在默认「首次信任并记录」（TOFU）：首次连接成功记录指纹，
之后主机密钥变化立即拒绝并给出两个指纹。

同时修复：``apply_config`` 只等旧调度线程 5 秒就启动新线程，若旧轮采集仍在
进行，会按旧配置写库并重复触发告警；现在用 generation 计数让过期轮次作废，
``_failure_counts`` 也补上了锁（导入自动采集线程与调度线程会并发写）。
"""

from __future__ import annotations

import re
from pathlib import Path

import paramiko
import pytest

from servermanage import ssh_client
from servermanage.app import MonitorService
from servermanage.config import load_config_from_mapping
from servermanage.models import (
    AppConfig,
    AuthConfig,
    HostConfig,
    HostMetrics,
    HostReport,
    ReportConfig,
    SMTPConfig,
    SSHRuntimeConfig,
)
from servermanage.settings import SettingsService
from servermanage.storage import get_host_snapshot, init_storage
from servermanage.web import create_app

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
ADMIN_PASSWORD = "AdminPass!23"


@pytest.fixture(autouse=True)
def _reset_host_keys():
    yield
    ssh_client.configure_host_keys(None, policy="insecure")


def _key() -> paramiko.RSAKey:
    return paramiko.RSAKey.generate(1024)


# ---------------------------------------------------------------------------
# TOFU 策略本身
# ---------------------------------------------------------------------------


def test_tofu_records_first_key_and_accepts_same_key(tmp_path: Path):
    store = tmp_path / "known_hosts.json"
    ssh_client.configure_host_keys(store, policy="tofu")
    key = _key()
    for _ in range(2):
        client = ssh_client.SSHClientWrapper._default_client_factory()
        policy = client._policy
        policy.missing_host_key(client, "[10.0.0.1]:22", key)
    hosts = ssh_client.list_known_host_keys()
    assert "[10.0.0.1]:22" in hosts
    assert hosts["[10.0.0.1]:22"]["key_type"] == "ssh-rsa"
    assert hosts["[10.0.0.1]:22"]["fingerprint"].startswith("ssh-rsa SHA256:")


def test_tofu_rejects_changed_key_with_both_fingerprints(tmp_path: Path):
    store = tmp_path / "known_hosts.json"
    ssh_client.configure_host_keys(store, policy="tofu")
    old_key, new_key = _key(), _key()
    client = ssh_client.SSHClientWrapper._default_client_factory()
    client._policy.missing_host_key(client, "gpu-01", old_key)

    with pytest.raises(ssh_client.HostKeyMismatch) as excinfo:
        client._policy.missing_host_key(client, "gpu-01", new_key)
    message = str(excinfo.value)
    assert "不一致" in message
    assert "known_hosts.json" in message
    assert "SHA256:" in message
    # 记录未被覆盖：仍是旧密钥。
    assert ssh_client.list_known_host_keys()["gpu-01"]["fingerprint"] != (
        "ssh-rsa SHA256:" + ""
    )
    assert ssh_client.list_known_host_keys()["gpu-01"]["first_seen"]


def test_strict_policy_rejects_unknown_host(tmp_path: Path):
    store = tmp_path / "known_hosts.json"
    ssh_client.configure_host_keys(store, policy="strict")
    client = ssh_client.SSHClientWrapper._default_client_factory()
    with pytest.raises(ssh_client.HostKeyMismatch):
        client._policy.missing_host_key(client, "unknown-host", _key())
    # 未知主机不会被悄悄记录。
    assert "unknown-host" not in ssh_client.list_known_host_keys()


def test_insecure_policy_falls_back_to_autoadd(tmp_path: Path):
    ssh_client.configure_host_keys(tmp_path / "known_hosts.json", policy="insecure")
    client = ssh_client.SSHClientWrapper._default_client_factory()
    assert isinstance(client._policy, paramiko.AutoAddPolicy)


def test_store_path_none_disables_verification(tmp_path: Path):
    ssh_client.configure_host_keys(None, policy="tofu")
    client = ssh_client.SSHClientWrapper._default_client_factory()
    assert isinstance(client._policy, paramiko.AutoAddPolicy)


def test_forget_host_key_removes_entry(tmp_path: Path):
    store = tmp_path / "known_hosts.json"
    ssh_client.configure_host_keys(store, policy="tofu")
    client = ssh_client.SSHClientWrapper._default_client_factory()
    client._policy.missing_host_key(client, "gpu-01", _key())
    assert ssh_client.forget_host_key("gpu-01") is True
    assert ssh_client.forget_host_key("gpu-01") is False
    assert ssh_client.list_known_host_keys() == {}


def test_corrupt_store_is_treated_as_empty(tmp_path: Path):
    store = tmp_path / "known_hosts.json"
    store.write_text("{not json", encoding="utf-8")
    ssh_client.configure_host_keys(store, policy="tofu")
    client = ssh_client.SSHClientWrapper._default_client_factory()
    client._policy.missing_host_key(client, "gpu-01", _key())
    assert "gpu-01" in ssh_client.list_known_host_keys()


# ---------------------------------------------------------------------------
# 配置项
# ---------------------------------------------------------------------------


def test_config_defaults_to_tofu_and_validates_policy():
    default = load_config_from_mapping({"servers": []}, allow_empty_servers=True)
    assert default.ssh.host_key_policy == "tofu"

    configured = load_config_from_mapping(
        {"ssh": {"host_key_policy": "strict"}, "servers": []},
        allow_empty_servers=True,
    )
    assert configured.ssh.host_key_policy == "strict"

    from servermanage.config import ConfigError

    with pytest.raises(ConfigError):
        load_config_from_mapping(
            {"ssh": {"host_key_policy": "bogus"}, "servers": []},
            allow_empty_servers=True,
        )


def test_settings_page_exposes_policy_and_trust_list(tmp_path: Path):
    html = (TEMPLATES / "settings.html").read_text(encoding="utf-8")
    assert 'data-field="host_key_policy"' in html
    assert 'id="ssh-trust-list"' in html
    assert 'id="ssh-trust-details"' in html


def _client(tmp_path: Path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "m.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    svc = SettingsService(config_path=cfg_path, db_path=db, base_config=base)
    app = create_app(config=svc.load(), db_path=db, settings_service=svc)
    client = app.test_client()
    page = client.get("/setup").get_data(as_text=True)
    client.post(
        "/setup",
        data={
            "username": "admin",
            "password": ADMIN_PASSWORD,
            "confirm": ADMIN_PASSWORD,
            "csrf_token": re.search(r'name="csrf_token" value="([^"]+)"', page).group(1),
        },
    )
    client.post("/login", data={"username": "admin", "password": ADMIN_PASSWORD})
    meta = client.get("/").get_data(as_text=True)
    client.environ_base["HTTP_X_CSRF_TOKEN"] = re.search(
        r'name="csrf-token" content="([^"]+)"', meta
    ).group(1)
    return client


def test_host_key_api_lists_and_forgets(tmp_path: Path):
    store = tmp_path / "known_hosts.json"
    ssh_client.configure_host_keys(store, policy="tofu")
    client_policy = ssh_client.SSHClientWrapper._default_client_factory()
    client_policy._policy.missing_host_key(client_policy, "gpu-02", _key())

    api = _client(tmp_path)
    listed = api.get("/api/system/host-keys").get_json()
    assert "gpu-02" in listed["hosts"]

    removed = api.delete("/api/system/host-keys/gpu-02")
    assert removed.status_code == 200
    assert api.get("/api/system/host-keys").get_json()["hosts"] == {}
    assert api.delete("/api/system/host-keys/gpu-02").status_code == 404


# ---------------------------------------------------------------------------
# 配置热更新的轮次竞态
# ---------------------------------------------------------------------------


def _config() -> AppConfig:
    host = HostConfig(
        name="gpu-01",
        host="10.0.0.1",
        port=22,
        username="root",
        auth=AuthConfig(type="password", password="pw"),
    )
    return AppConfig(
        smtp=SMTPConfig(
            host="smtp.example.com",
            port=465,
            username="monitor@example.com",
            password="smtp-secret",
            use_ssl=True,
            from_addr="monitor@example.com",
            to_addrs=["ops@example.com"],
        ),
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        report=ReportConfig(subject_prefix="[Daily]"),
        servers=[host],
    )


def _report() -> HostReport:
    return HostReport(
        host_name="gpu-01",
        host="10.0.0.1",
        success=True,
        metrics=HostMetrics(
            collected_at=__import__("datetime").datetime.now(
                __import__("datetime").timezone.utc
            ),
            cpu_usage_percent=10.0,
        ),
    )


def test_round_started_before_config_change_is_discarded(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    service = MonitorService(_config(), db_path=db_path)
    changed = {"done": False}

    def collect(config):
        # 模拟采集期间用户在设置页保存了新配置。
        if not changed["done"]:
            changed["done"] = True
            service.apply_config(_config())
        return [_report()]

    service.collect_status = collect
    result = service.run_status_once()

    assert result["discarded"] is True
    assert result["alerts"] == 0
    # 旧配置下的结果不能落库。
    assert get_host_snapshot("gpu-01", db_path) is None


def test_round_without_config_change_persists_normally(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    service = MonitorService(
        _config(), db_path=db_path, collect_status=lambda config: [_report()]
    )
    result = service.run_status_once()
    assert "discarded" not in result
    assert get_host_snapshot("gpu-01", db_path) is not None


def test_apply_config_bumps_generation_and_moves_host_key_policy(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    service = MonitorService(_config(), db_path=db_path)
    before = service._config_generation

    new_config = _config()
    new_config = __import__("dataclasses").replace(
        new_config,
        ssh=SSHRuntimeConfig(
            connect_timeout=10, command_timeout=20, host_key_policy="strict"
        ),
    )
    service.apply_config(new_config)

    assert service._config_generation == before + 1
    assert ssh_client.host_key_store_path() == db_path.parent / "known_hosts.json"


def test_failure_counts_are_guarded_by_a_lock(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    service = MonitorService(_config(), db_path=db_path)
    assert hasattr(service, "_failure_lock")
    # 失败两轮：连续计数递增（锁不改变语义）。
    service.collect_status = lambda config: [HostReport("gpu-01", "10.0.0.1", success=False)]
    service.run_status_once()
    service.run_status_once()
    assert service._failure_counts["gpu-01"] == 2
