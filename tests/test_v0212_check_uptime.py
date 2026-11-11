"""v0.1.112：服务检查可用率列。"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.models import HostCheckResult
from servermanage.storage import append_host_check_history, init_storage, save_host_check_results
from servermanage.web import create_app

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"


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


def _result(name: str, status: str) -> HostCheckResult:
    return HostCheckResult(
        name=name,
        type="tcp",
        target="127.0.0.1:22",
        status=status,
        message="" if status == "ok" else "connection refused",
        latency_ms=3.0,
    )


def _client(tmp_path: Path, statuses: list[str]):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    now = datetime(2026, 11, 11, 9, 0, tzinfo=timezone.utc)
    save_host_check_results("a100-zyc", [_result("SSH 22", statuses[-1])], db_path)
    for index, status in enumerate(statuses):
        append_host_check_history(
            "a100-zyc",
            [HostCheckResult(
                name="SSH 22",
                type="tcp",
                target="127.0.0.1:22",
                status=status,
                message="" if status == "ok" else "connection refused",
                latency_ms=3.0,
                checked_at=now.replace(minute=index),
            )],
            db_path,
        )
    app = create_app(config=_config(), db_path=db_path)
    app.config.update(TESTING=True)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "tester"
        session["csrf_token"] = "token"
    return client


def test_page_shows_uptime_percentage(tmp_path: Path):
    html = _client(tmp_path, ["ok", "error", "ok"]).get("/host/a100-zyc").get_data(as_text=True)
    assert "可用率" in html
    assert "66.7%" in html


def test_low_uptime_is_flagged(tmp_path: Path):
    html = _client(tmp_path, ["ok", "error"]).get("/host/a100-zyc").get_data(as_text=True)
    assert "50.0%" in html
    assert "uptime-cell is-low" in html


def test_missing_history_renders_dash(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    save_host_check_results("a100-zyc", [_result("SSH 22", "ok")], db_path)
    app = create_app(config=_config(), db_path=db_path)
    app.config.update(TESTING=True)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "tester"
        session["csrf_token"] = "token"
    html = client.get("/host/a100-zyc").get_data(as_text=True)
    assert 'class="mono uptime-cell">—</td>' in html


def test_script_has_uptime_helpers():
    script = (STATIC / "host-detail.js").read_text(encoding="utf-8")
    assert "function uptimeFor(statuses)" in script
    assert "function uptimeText(statuses)" in script
    assert "uptimeCell.textContent = uptimeText(checkHistory[check.check_name]);" in script
    assert "uptimeSummary.ratio < 95" in script


def test_styles_cover_uptime_cell():
    tail = (STATIC / "style.css").read_text(encoding="utf-8").split("v0.1.112 服务检查可用率")[1]
    assert ".uptime-cell { white-space: nowrap; font-variant-numeric: tabular-nums; }" in tail
    assert ".uptime-cell.is-low { color: #b45309; font-weight: 600; }" in tail
