"""Task 1 tests: 0.2.0 availability models and per-host YAML settings."""

from __future__ import annotations

from pathlib import Path

import pytest

from servermanage.config import ConfigError, load_config, load_config_from_mapping
from servermanage.models import (
    AuthConfig,
    HostAlertRules,
    HostCheckConfig,
    HostConfig,
)
from servermanage.serialization import dump_json, to_jsonable


def make_host(**overrides) -> HostConfig:
    """Build a HostConfig with a minimal valid baseline."""
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


def test_host_config_defaults_for_checks_and_sudo():
    host = make_host()
    assert host.checks == []
    assert host.alert_rules is None
    assert host.sudo_password is None


def test_host_check_config_defaults():
    check = HostCheckConfig(name="API", type="http", target="http://127.0.0.1/")
    assert check.timeout_seconds == 5
    assert check.expected is None
    assert check.enabled is True


def test_host_alert_rules_default_to_none():
    rules = HostAlertRules()
    assert rules.cpu_percent is None
    assert rules.memory_percent is None
    assert rules.disk_percent is None
    assert rules.gpu_memory_percent is None
    assert rules.disk_temperature_c is None
    assert rules.consecutive_periods is None


# ---------------------------------------------------------------------------
# YAML loading
# ---------------------------------------------------------------------------


def test_yaml_load_parses_checks_alert_rules_and_sudo_env(tmp_path, monkeypatch):
    monkeypatch.setenv("LAB_GPU01_SUDO_PASSWORD", "s3cret")
    path = tmp_path / "config.yaml"
    path.write_text(
        """servers:
  - name: "gpu-01"
    host: "10.0.0.1"
    username: "u"
    auth: {type: "password", password_env: "GPU01_PASSWORD"}
    sudo_password_env: "LAB_GPU01_SUDO_PASSWORD"
    checks:
      - name: "训练 API"
        type: "http"
        target: "http://127.0.0.1:8000/health"
        timeout_seconds: 5
        expected: "200-299"
      - name: "SSH 端口"
        type: "tcp"
        target: "22"
    alert_rules:
      cpu_percent: 95
      consecutive_periods: 3
""",
        encoding="utf-8",
    )
    cfg = load_config(path)
    host = cfg.servers[0]
    assert [check.name for check in host.checks] == ["训练 API", "SSH 端口"]
    assert host.checks[0].type == "http"
    assert host.checks[0].target == "http://127.0.0.1:8000/health"
    assert host.checks[0].timeout_seconds == 5
    assert host.checks[0].expected == "200-299"
    assert host.checks[1].type == "tcp"
    assert host.checks[1].target == "22"
    assert host.checks[1].expected is None
    assert isinstance(host.alert_rules, HostAlertRules)
    assert host.alert_rules.cpu_percent == 95
    assert host.alert_rules.consecutive_periods == 3
    assert host.sudo_password == "s3cret"


def test_yaml_direct_sudo_password_and_env_priority(tmp_path, monkeypatch):
    monkeypatch.setenv("LAB_GPU01_SUDO_PASSWORD", "from-env")
    path = tmp_path / "config.yaml"
    path.write_text(
        """servers:
  - name: "gpu-01"
    host: "10.0.0.1"
    username: "u"
    auth: {type: "password", password_env: "GPU01_PASSWORD"}
    sudo_password: "direct-pw"
    sudo_password_env: "LAB_GPU01_SUDO_PASSWORD"
""",
        encoding="utf-8",
    )
    assert load_config(path).servers[0].sudo_password == "from-env"


@pytest.mark.parametrize(
    "checks",
    [
        [{"name": "a", "type": "tcp", "target": "22", "timeout_seconds": 0}],
        [{"name": "a", "type": "tcp", "target": "22", "timeout_seconds": 31}],
        [{"name": "a", "type": "tcp", "target": "22", "timeout_seconds": "x"}],
        [
            {"name": "Same", "type": "tcp", "target": "22"},
            {"name": "same", "type": "tcp", "target": "23"},
        ],
        [{"name": "a" * 65, "type": "tcp", "target": "22"}],
        [{"name": "a", "type": "tcp", "target": "22", "expected": "abc"}],
        [{"name": f"c{i}", "type": "tcp", "target": "22"} for i in range(21)],
        "not-a-list",
    ],
)
def test_invalid_yaml_checks_raise_config_error(checks):
    with pytest.raises(ConfigError):
        load_config_from_mapping({"servers": [_base_server(checks=checks)]})


def test_yaml_check_timeout_accepts_numeric_string():
    checks = [{"name": "a", "type": "tcp", "target": "22", "timeout_seconds": "5"}]
    cfg = load_config_from_mapping({"servers": [_base_server(checks=checks)]})
    assert cfg.servers[0].checks[0].timeout_seconds == 5


def test_invalid_alert_rules_raise_config_error():
    with pytest.raises(ConfigError):
        load_config_from_mapping(
            {"servers": [_base_server(alert_rules="not-a-mapping")]}
        )


def test_alerts_consecutive_periods_default_and_override():
    default = load_config_from_mapping({}, allow_empty_servers=True)
    assert default.alerts.consecutive_periods == 2
    override = load_config_from_mapping(
        {"alerts": {"consecutive_periods": 7}}, allow_empty_servers=True
    )
    assert override.alerts.consecutive_periods == 7
    # Out-of-range values are handled cleanly instead of crashing.
    clamped_low = load_config_from_mapping(
        {"alerts": {"consecutive_periods": 0}}, allow_empty_servers=True
    )
    assert clamped_low.alerts.consecutive_periods == 1
    clamped_high = load_config_from_mapping(
        {"alerts": {"consecutive_periods": 99}}, allow_empty_servers=True
    )
    assert clamped_high.alerts.consecutive_periods == 10


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------


def test_to_jsonable_skips_sensitive_fields():
    host = make_host(sudo_password="super-secret")
    payload = to_jsonable(host)
    assert "sudo_password" not in payload
    assert "super-secret" not in dump_json(host)


def test_dump_json_keeps_non_sensitive_host_fields():
    host = make_host(sudo_password="super-secret")
    text = dump_json(host)
    assert "gpu-01" in text
    assert "super-secret" not in text
