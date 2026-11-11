"""v0.1.109：主机指标分区。"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.models import HostMetrics, HostReport
from servermanage.storage import save_host_snapshot
from servermanage.web import create_app

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"
TEMPLATES = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "templates"


def _config():
    return load_config_from_mapping(
        {
            "report": {"daily_enabled": False, "weekly": {"enabled": False}},
            "dashboard": {"auth": {"password": "secret"}},
            "servers": [
                {
                    "name": "a100-zyc",
                    "host": "202.119.189.245",
                    "username": "root",
                    "auth": {"type": "key", "key_data": "PEM"},
                }
            ],
        }
    )


def _client(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    config = _config()
    save_host_snapshot(
        HostReport(
            host_name="a100-zyc",
            host="202.119.189.245",
            success=True,
            metrics=HostMetrics(
                os_pretty_name="Ubuntu 22.04.4 LTS",
                kernel_version="5.15.0-105-generic",
                uptime="up 5 days",
                cpu_core_count=64,
                cpu_usage_percent=12.5,
                collected_at=datetime(2026, 11, 11, 9, 0, tzinfo=timezone.utc),
            ),
        ),
        db_path,
    )
    app = create_app(config=config, db_path=db_path)
    app.config.update(TESTING=True)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "tester"
        session["csrf_token"] = "token"
    return client


def test_metrics_are_split_into_three_groups(tmp_path: Path):
    html = _client(tmp_path).get("/host/a100-zyc").get_data(as_text=True)
    assert html.count('class="kv-group"') == 3
    positions = [html.index(title) for title in ("系统", "资源", "网络与温度")]
    assert positions == sorted(positions)


def test_group_titles_precede_their_fields(tmp_path: Path):
    html = _client(tmp_path).get("/host/a100-zyc").get_data(as_text=True)
    system_at = html.index(">系统<")
    kernel_at = html.index("内核版本")
    resource_at = html.index(">资源<")
    cpu_at = html.index("CPU 核心")
    network_at = html.index(">网络与温度<")
    assert system_at < kernel_at < resource_at < cpu_at < network_at


def test_network_and_temperature_live_together(tmp_path: Path):
    html = _client(tmp_path).get("/host/a100-zyc").get_data(as_text=True)
    network_at = html.index(">网络与温度<")
    assert network_at < html.index("网络吞吐") < html.index("kv-thermal")


def test_styles_cover_kv_groups():
    tail = (STATIC / "style.css").read_text(encoding="utf-8").split("v0.1.109 主机指标分区")[1]
    assert ".kv-group + .kv-group" in tail
    assert ".kv-group-title {" in tail
    assert "letter-spacing: .06em;" in tail


def test_template_defines_group_titles():
    html = (TEMPLATES / "host.html").read_text(encoding="utf-8")
    for title in ("系统", "资源", "网络与温度"):
        assert f'<h3 class="kv-group-title">{title}</h3>' in html
