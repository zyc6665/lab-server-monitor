"""v0.1.131：占用统计单独超时 + 默认两天一次的采样节奏。"""

from __future__ import annotations

from pathlib import Path

from servermanage import user_collection
from servermanage.config import load_config_from_mapping
from servermanage.models import UserMonitoringConfig
from servermanage.user_scan import collect_host_users

from test_user_scan import FakeRunner, NOW, make_host

ROOT = Path(__file__).resolve().parents[1]


def _scan_stdout(home: str = "/home/alice") -> str:
    return (
        "P\t1\n"
        f"U\talice\t1001\t1001\t{home}\t/bin/bash\tAlice\n"
        "U\troot\t0\t0\t/root\t/bin/bash\troot\n"
        "G\talice\t1001\t\n"
        "G\tdocker\t998\talice\n"
        "H\talice\t1\talice\talice\t755\n"
        "D\talice\t1\talice\talice\t755\n"
        "END\t1\n"
    )


def test_defaults_are_two_days_and_thirty_minutes():
    config = UserMonitoringConfig()
    assert config.usage_interval_seconds == 172800
    assert config.usage_timeout_seconds == 1800
    assert config.command_timeout == 120


def test_yaml_accepts_and_defaults_timeout():
    mapping = {
        "servers": [],
        "user_monitoring": {"usage_timeout_seconds": 3600, "usage_interval_seconds": 172800},
    }
    config = load_config_from_mapping(mapping, allow_empty_servers=True)
    assert config.user_monitoring.usage_timeout_seconds == 3600
    fallback = load_config_from_mapping({"servers": []}, allow_empty_servers=True)
    assert fallback.user_monitoring.usage_timeout_seconds == 1800


def test_usage_uses_its_own_timeout():
    runner = FakeRunner(
        scan_stdout=_scan_stdout(),
        usage_stdout="1024\t/home/alice\n2048\t/data/alice\n",
    )
    accounts, readable, refreshed = collect_host_users(
        make_host(),
        runner,
        now=NOW,
        usage_due=True,
        command_timeout=120,
        usage_timeout=1800,
    )
    assert refreshed is True
    assert readable is True
    assert runner.run_calls[0][1] == 120
    assert runner.sudo_calls[0][1] == 1830
    assert "timeout -k 10 1800 bash -c" in runner.sudo_calls[0][0]
    assert accounts


def test_usage_falls_back_to_command_timeout():
    runner = FakeRunner(
        scan_stdout=_scan_stdout(),
        usage_stdout="1024\t/home/alice\n",
    )
    collect_host_users(
        make_host(), runner, now=NOW, usage_due=True, command_timeout=90
    )
    assert runner.sudo_calls[0][1] == 120
    assert "timeout -k 10 90 bash -c" in runner.sudo_calls[0][0]


def test_collection_forwards_configured_timeout(tmp_path, monkeypatch):
    monkeypatch.setenv("PW", "secret")
    captured: dict[str, object] = {}

    def fake_scan(host, runner, **kwargs):
        captured.update(kwargs)
        return [], True, False

    config = load_config_from_mapping(
        {
            "servers": [
                {
                    "name": "gpu-01",
                    "host": "10.0.0.1",
                    "username": "u",
                    "auth": {"type": "password", "password_env": "PW"},
                }
            ],
            "user_monitoring": {"usage_timeout_seconds": 3600},
        }
    )
    user_collection.run_user_scan(
        config,
        tmp_path / "monitor.db",
        engine=None,
        build_runner=lambda host, timeout: FakeRunner(),
        scan=fake_scan,
        now=NOW,
        force_usage=True,
    )
    assert captured["usage_timeout"] == 3600
    assert captured["command_timeout"] == config.user_monitoring.command_timeout
    assert captured["usage_due"] is True


def _settings_client(tmp_path):
    import re

    from servermanage.settings import SettingsService
    from servermanage.web import create_app

    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "settings.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    service = SettingsService(config_path=cfg_path, db_path=db, base_config=base)
    app = create_app(config=service.load(), db_path=db, settings_service=service)
    app.config.update(TESTING=True)
    client = app.test_client()
    token = re.search(r'name="csrf_token" value="([^"]+)"', client.get("/setup").get_data(as_text=True)).group(1)
    client.post(
        "/setup",
        data={"username": "admin", "password": "admin" + "-pw-123", "confirm": "admin" + "-pw-123", "csrf_token": token},
    )
    # setup 只建账号，还需要登录一次才能进设置页。
    client.post(
        "/login",
        data={"username": "admin", "password": "admin" + "-pw-123"},
    )
    page = client.get("/settings").get_data(as_text=True)
    csrf = re.search(r'name="csrf-token" content="([^"]+)"', page).group(1)
    return client, csrf


def test_settings_roundtrip_usage_timeout(tmp_path):
    client, csrf = _settings_client(tmp_path)
    headers = {"X-CSRF-Token": csrf}
    response = client.put(
        "/api/settings/user_monitoring",
        json={"usage_timeout_seconds": 3600, "usage_interval_seconds": 172800},
        headers=headers,
    )
    assert response.status_code == 200, response.get_data(as_text=True)
    payload = client.get("/api/settings").get_json()
    monitoring = payload["user_monitoring"]
    assert monitoring["usage_timeout_seconds"] == 3600
    assert monitoring["usage_interval_seconds"] == 172800


def test_settings_rejects_absurd_usage_timeout(tmp_path):
    client, csrf = _settings_client(tmp_path)
    response = client.put(
        "/api/settings/user_monitoring",
        json={"usage_timeout_seconds": 5},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 400
