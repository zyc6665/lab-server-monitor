"""v0.1.73：主机行 24h 趋势线 + 服务可用性心跳条（全部只读）。"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage.availability import HostCheckResult
from servermanage.config import load_config_from_mapping
from servermanage.storage import (
    append_host_check_history,
    delete_host_check_results,
    fetch_host_sparklines,
    get_host_check_history,
    init_storage,
    save_host_check_results,
)
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
                    "group": "GPU",
                    "auth": {"type": "key", "key_data": "PEM"},
                    "checks": [
                        {"name": "ssh", "type": "process", "target": "sshd"},
                    ],
                },
            ],
        }
    )


def _result(name: str = "ssh", status: str = "ok", when: datetime | None = None):
    return HostCheckResult(
        name=name,
        type="process",
        target="sshd",
        status=status,
        message="" if status == "ok" else "进程未运行",
        latency_ms=12.0 if status == "ok" else None,
        checked_at=when or datetime.now(timezone.utc),
    )


def _seed_metrics(db_path: Path, host: str = "a100-zyc", count: int = 5) -> None:
    init_storage(db_path)
    now = datetime.now(timezone.utc)
    with sqlite3.connect(db_path) as conn:
        for index in range(count):
            conn.execute(
                """
                INSERT INTO host_metrics_history
                    (collected_at, host_name, host, success, cpu_usage_percent,
                     memory_used_mb, memory_total_mb)
                VALUES (?, ?, ?, 1, ?, ?, ?)
                """,
                (
                    (now - timedelta(minutes=(count - index) * 10)).isoformat(),
                    host,
                    "10.0.0.1",
                    10.0 + index,
                    1000 * (index + 1),
                    10_000,
                ),
            )
        conn.commit()


def _client(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    _seed_metrics(db_path)
    app = create_app(config=_config(), db_path=db_path)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "zyc"
    return client


def test_sparklines_are_grouped_per_host(tmp_path: Path) -> None:
    db_path = tmp_path / "monitor.db"
    _seed_metrics(db_path, "a100-zyc", 4)
    _seed_metrics(db_path, "v100-zyc", 2)

    data = fetch_host_sparklines(db_path)

    assert list(data["a100-zyc"]["cpu"]) == [10.0, 11.0, 12.0, 13.0]
    assert data["a100-zyc"]["memory"] == [10.0, 20.0, 30.0, 40.0]
    assert data["v100-zyc"]["cpu"] == [10.0, 11.0]


def test_sparklines_respect_point_limit_and_skip_failures(tmp_path: Path) -> None:
    db_path = tmp_path / "monitor.db"
    _seed_metrics(db_path, "a100-zyc", 6)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO host_metrics_history
                (collected_at, host_name, host, success, cpu_usage_percent)
            VALUES (?, 'a100-zyc', '10.0.0.1', 0, 99)
            """,
            (datetime.now(timezone.utc).isoformat(),),
        )
        conn.commit()

    data = fetch_host_sparklines(db_path, points=3)

    assert data["a100-zyc"]["cpu"] == [13.0, 14.0, 15.0]


def test_check_history_keeps_order_and_prunes(tmp_path: Path) -> None:
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)

    for index in range(5):
        append_host_check_history(
            "a100-zyc", [_result(status="ok" if index % 2 == 0 else "error")], db_path
        )

    history = get_host_check_history("a100-zyc", db_path)
    assert history["ssh"] == ["ok", "error", "ok", "error", "ok"]

    append_host_check_history("a100-zyc", [_result()], db_path, keep=2)
    trimmed = get_host_check_history("a100-zyc", db_path)
    assert len(trimmed["ssh"]) == 2
    assert trimmed["ssh"][-1] == "ok"


def test_deleting_check_results_clears_history(tmp_path: Path) -> None:
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    save_host_check_results("a100-zyc", [_result()], db_path)
    append_host_check_history("a100-zyc", [_result()], db_path)

    delete_host_check_results("a100-zyc", db_path)

    assert get_host_check_history("a100-zyc", db_path) == {}


def test_overview_payload_carries_spark_series(tmp_path: Path) -> None:
    payload = _client(tmp_path).get("/api/overview").get_json()

    host = next(item for item in payload["hosts"] if item["name"] == "a100-zyc")
    assert host["spark"]["cpu"] == [10.0, 11.0, 12.0, 13.0, 14.0]
    assert host["spark"]["memory"] == [10.0, 20.0, 30.0, 40.0, 50.0]


def test_overview_hosts_without_history_get_empty_spark(tmp_path: Path) -> None:
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    app = create_app(config=_config(), db_path=db_path)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "zyc"

    host = next(
        item for item in client.get("/api/overview").get_json()["hosts"]
        if item["name"] == "a100-zyc"
    )

    assert host["spark"] == {"cpu": [], "memory": []}


def test_host_detail_renders_heartbeat_and_api_exposes_history(tmp_path: Path) -> None:
    db_path = tmp_path / "monitor.db"
    _seed_metrics(db_path)
    save_host_check_results("a100-zyc", [_result()], db_path)
    for status in ("ok", "ok", "error"):
        append_host_check_history("a100-zyc", [_result(status=status)], db_path)

    app = create_app(config=_config(), db_path=db_path)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "zyc"

    html = client.get("/host/a100-zyc").get_data(as_text=True)
    assert "最近 40 次" in html
    assert html.count('class="hb hb-ok"') == 2
    assert html.count('class="hb hb-error"') == 1

    payload = client.get("/api/host/a100-zyc").get_json()
    assert payload["check_history"]["ssh"] == ["ok", "ok", "error"]


def test_client_scripts_render_sparkline_and_heartbeat() -> None:
    app_js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function sparkline(values, className)" in app_js
    assert "percentCell(host.cpu_percent, spark.cpu)" in app_js
    assert "percentCell(host.memory_percent, spark.memory)" in app_js

    host_js = (STATIC / "host-detail.js").read_text(encoding="utf-8")
    assert "function buildHeartbeat(statuses)" in host_js
    assert "payload.check_history" in host_js
    # 刷新后显卡片的检查时间要与服务端 `|stamp` 一致，不能回退成原始 ISO。
    assert "function stamp(value)" in host_js
    assert "stamp(check.checked_at)" in host_js

    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.73 主机趋势线与可用性心跳条" in css
    for selector in (".spark {", ".heartbeat {", ".heartbeat .hb-ok {"):
        assert selector in css, selector
