"""Task 1 tests: 0.3.0 read-only user monitoring models and YAML settings."""

from __future__ import annotations

from datetime import datetime

import pytest

from servermanage.config import ConfigError, load_config, load_config_from_mapping
from servermanage.models import (
    AppConfig,
    AuthConfig,
    HostConfig,
    HostReport,
    HostUserAccount,
    ReportConfig,
    SSHRuntimeConfig,
    UserMonitoringConfig,
)


def make_account(**overrides) -> HostUserAccount:
    """Build a HostUserAccount with a minimal valid baseline."""
    data = {
        "host_name": "gpu-01",
        "username": "alice",
        "uid": 1000,
        "gid": 1000,
    }
    data.update(overrides)
    return HostUserAccount(**data)


def make_host(**overrides) -> HostConfig:
    data = {
        "name": "gpu-01",
        "host": "10.0.0.1",
        "port": 22,
        "username": "u",
        "auth": AuthConfig(type="password", password="pw"),
    }
    data.update(overrides)
    return HostConfig(**data)


def _base_server(**overrides):
    server = {
        "name": "gpu-01",
        "host": "10.0.0.1",
        "username": "u",
        "auth": {"type": "password", "password_env": "GPU01_PASSWORD"},
    }
    server.update(overrides)
    return server


@pytest.fixture(autouse=True)
def _stub_gpu_password(monkeypatch):
    monkeypatch.setenv("GPU01_PASSWORD", "x")


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


def test_user_monitoring_config_defaults():
    cfg = UserMonitoringConfig()
    assert cfg.enabled is True
    assert cfg.scan_interval_seconds == 3600
    assert cfg.usage_interval_seconds == 172800
    assert cfg.command_timeout == 120


def test_host_user_account_defaults():
    account = make_account()
    assert account.host_name == "gpu-01"
    assert account.username == "alice"
    assert account.uid == 1000
    assert account.gid == 1000
    assert account.primary_group is None
    assert account.gecos == ""
    assert account.home == ""
    assert account.shell == ""
    assert account.groups == []
    assert account.in_docker is False
    assert account.in_sudo is False
    assert account.home_exists is False
    assert account.home_owner is None
    assert account.home_group is None
    assert account.home_mode is None
    assert account.home_size_bytes is None
    assert account.data_exists is False
    assert account.data_owner is None
    assert account.data_group is None
    assert account.data_mode is None
    assert account.data_size_bytes is None
    assert account.data_supported is True
    assert account.usage_readable is True
    assert account.usage_stale is False
    assert account.usage_collected_at is None
    assert isinstance(account.collected_at, datetime)
    assert account.state == "present"


def test_host_user_account_default_state_is_present():
    assert make_account().state == "present"
    assert make_account(state="missing").state == "missing"


def test_host_user_account_groups_are_not_shared():
    first = make_account()
    second = make_account()
    first.groups.append("docker")
    assert second.groups == []


def test_host_config_user_monitoring_defaults_to_none():
    assert make_host().user_monitoring is None
    assert make_host(user_monitoring=True).user_monitoring is True
    assert make_host(user_monitoring=False).user_monitoring is False


def test_host_report_users_defaults_to_empty_list():
    report = HostReport(host_name="gpu-01", host="10.0.0.1", success=True)
    assert report.users == []
    other = HostReport(host_name="gpu-02", host="10.0.0.2", success=True)
    report.users.append(make_account())
    assert other.users == []


def test_host_report_keeps_provided_users():
    account = make_account()
    report = HostReport(
        host_name="gpu-01", host="10.0.0.1", success=True, users=[account]
    )
    assert report.users == [account]


def test_app_config_user_monitoring_defaults():
    cfg = AppConfig(
        smtp=None,
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        report=ReportConfig(subject_prefix="[x]"),
        servers=[],
    )
    assert cfg.user_monitoring == UserMonitoringConfig()


def test_app_config_from_mapping_has_user_monitoring_defaults():
    cfg = load_config_from_mapping({}, allow_empty_servers=True)
    assert cfg.user_monitoring == UserMonitoringConfig()


# ---------------------------------------------------------------------------
# Global YAML settings
# ---------------------------------------------------------------------------


def test_global_user_monitoring_overrides_every_field():
    cfg = load_config_from_mapping(
        {
            "user_monitoring": {
                "enabled": False,
                "scan_interval_seconds": 7200,
                "usage_interval_seconds": 43200,
                "command_timeout": 300,
            },
            "servers": [_base_server()],
        }
    )
    assert cfg.user_monitoring.enabled is False
    assert cfg.user_monitoring.scan_interval_seconds == 7200
    assert cfg.user_monitoring.usage_interval_seconds == 43200
    assert cfg.user_monitoring.command_timeout == 300


def test_global_user_monitoring_partial_override_keeps_defaults():
    cfg = load_config_from_mapping(
        {"user_monitoring": {"enabled": False}, "servers": [_base_server()]}
    )
    assert cfg.user_monitoring.enabled is False
    assert cfg.user_monitoring.scan_interval_seconds == 3600
    assert cfg.user_monitoring.usage_interval_seconds == 172800
    assert cfg.user_monitoring.command_timeout == 120


def test_global_user_monitoring_empty_mapping_uses_defaults():
    cfg = load_config_from_mapping(
        {"user_monitoring": {}, "servers": [_base_server()]}
    )
    assert cfg.user_monitoring == UserMonitoringConfig()


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("scan_interval_seconds", 300),
        ("scan_interval_seconds", 86400),
        ("usage_interval_seconds", 3600),
        ("usage_interval_seconds", 604800),
        ("command_timeout", 10),
        ("command_timeout", 600),
    ],
)
def test_global_user_monitoring_accepts_range_boundaries(key, value):
    cfg = load_config_from_mapping(
        {"user_monitoring": {key: value}, "servers": [_base_server()]}
    )
    assert getattr(cfg.user_monitoring, key) == value


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("scan_interval_seconds", 299),
        ("scan_interval_seconds", 86401),
        ("usage_interval_seconds", 3599),
        ("usage_interval_seconds", 604801),
        ("command_timeout", 9),
        ("command_timeout", 601),
    ],
)
def test_global_user_monitoring_rejects_out_of_range_values(key, value):
    with pytest.raises(ConfigError, match=f"user_monitoring.{key}"):
        load_config_from_mapping(
            {"user_monitoring": {key: value}, "servers": [_base_server()]}
        )


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("enabled", "yes"),
        ("enabled", 1),
        ("scan_interval_seconds", "abc"),
        ("scan_interval_seconds", True),
        ("usage_interval_seconds", None),
        ("command_timeout", 12.5),
    ],
)
def test_global_user_monitoring_rejects_wrong_types(key, value):
    with pytest.raises(ConfigError, match=f"user_monitoring.{key}"):
        load_config_from_mapping(
            {"user_monitoring": {key: value}, "servers": [_base_server()]}
        )


@pytest.mark.parametrize("value", ["not-a-mapping", [1, 2], True])
def test_global_user_monitoring_rejects_non_mapping(value):
    with pytest.raises(ConfigError, match="user_monitoring"):
        load_config_from_mapping({"user_monitoring": value, "servers": [_base_server()]})


def test_yaml_file_parses_global_and_per_host_user_monitoring(tmp_path):
    path = tmp_path / "config.yaml"
    path.write_text(
        """user_monitoring:
  enabled: true
  scan_interval_seconds: 1800
  usage_interval_seconds: 7200
  command_timeout: 240
servers:
  - name: "gpu-01"
    host: "10.0.0.1"
    username: "u"
    auth: {type: "password", password_env: "GPU01_PASSWORD"}
    user_monitoring: true
  - name: "jump-01"
    host: "10.0.0.2"
    username: "u"
    auth: {type: "password", password_env: "GPU01_PASSWORD"}
    user_monitoring: false
  - name: "gpu-03"
    host: "10.0.0.3"
    username: "u"
    auth: {type: "password", password_env: "GPU01_PASSWORD"}
""",
        encoding="utf-8",
    )
    cfg = load_config(path)
    assert cfg.user_monitoring.scan_interval_seconds == 1800
    assert cfg.user_monitoring.usage_interval_seconds == 7200
    assert cfg.user_monitoring.command_timeout == 240
    assert [host.user_monitoring for host in cfg.servers] == [True, False, None]


# ---------------------------------------------------------------------------
# Per-host YAML settings
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [(True, True), (False, False), (None, None)],
)
def test_host_user_monitoring_parsed_from_mapping(value, expected):
    overrides = {} if value is None else {"user_monitoring": value}
    cfg = load_config_from_mapping({"servers": [_base_server(**overrides)]})
    assert cfg.servers[0].user_monitoring is expected


def test_host_user_monitoring_absent_inherits_global():
    cfg = load_config_from_mapping(
        {"user_monitoring": {"enabled": False}, "servers": [_base_server()]}
    )
    assert cfg.servers[0].user_monitoring is None


@pytest.mark.parametrize("value", ["yes", 1, {"enabled": True}, []])
def test_host_user_monitoring_rejects_non_bool(value):
    with pytest.raises(ConfigError, match=r"servers\[\].user_monitoring"):
        load_config_from_mapping(
            {"servers": [_base_server(user_monitoring=value)]}
        )
