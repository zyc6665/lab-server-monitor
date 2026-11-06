from pathlib import Path
import pytest
from servermanage.config import ConfigError, load_config, load_config_from_mapping

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


def test_dashboard_secrets_read_without_dashboard_section(tmp_path, monkeypatch):
    monkeypatch.setenv("GPU01_PASSWORD", "x")
    monkeypatch.setenv("DASHBOARD_PASSWORD", "pw")
    monkeypatch.setenv("DASHBOARD_SECRET", "secret")
    cfg = load_config(_write(tmp_path, ""))
    assert cfg.dashboard.auth.password == "pw"
    assert cfg.dashboard.session_secret == "secret"


def test_webhook_url_read_without_webhook_section(tmp_path, monkeypatch):
    monkeypatch.setenv("GPU01_PASSWORD", "x")
    monkeypatch.setenv("ALERT_WEBHOOK_URL", "https://example.com/hook")
    cfg = load_config(_write(tmp_path, ""))
    assert cfg.alerts.webhook.url == "https://example.com/hook"


@pytest.fixture(autouse=True)
def _stub_gpu_password(monkeypatch):
    monkeypatch.setenv("GPU01_PASSWORD", "x")


def _server(**overrides):
    server = {
        "name": "gpu-01",
        "host": "10.0.0.1",
        "username": "zhouyc",
        "auth": {"type": "password", "password_env": "GPU01_PASSWORD"},
    }
    server.update(overrides)
    return server


def _load(raw):
    return load_config_from_mapping(raw)


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

from pathlib import Path


def test_missing_key_path_allowed_for_packaged_seed(tmp_path):
    missing = tmp_path / "not-there" / "id_rsa"

    cfg = load_config_from_mapping(
        {"servers": [_server(auth={"type": "key", "key_path": str(missing)})]},
        allow_empty_servers=False,
        allow_missing_secrets=True,
    )

    assert cfg.servers[0].auth.key_path == missing
