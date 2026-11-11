"""v0.1.75：网络吞吐只读采集与展示。"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage.commands import NET_STAGE
from servermanage.config import load_config_from_mapping
from servermanage.models import CommandResult, DailyReport, HostMetrics, HostReport
from servermanage.parsers import parse_host_metrics, parse_net_totals
from servermanage.storage import (
    fetch_host_network_rates,
    init_storage,
    persist_host_reports,
)
from servermanage.web import create_app


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
                }
            ],
        }
    )


def _report(collected_at: datetime, rx: int | None, tx: int | None) -> HostReport:
    return HostReport(
        host_name="a100-zyc",
        host="202.119.189.245",
        success=True,
        metrics=HostMetrics(collected_at=collected_at, net_rx_bytes=rx, net_tx_bytes=tx),
    )


def _save(report: HostReport, db_path: Path) -> None:
    persist_host_reports(
        DailyReport(
            generated_at=report.metrics.collected_at or datetime.now(timezone.utc),
            reports=[report],
            subject_prefix="test",
        ),
        db_path,
    )


def test_parse_net_totals_accepts_aggregate_output():
    assert parse_net_totals("123456 654321\n") == (123456, 654321)
    assert parse_net_totals("  ") == (None, None)
    assert parse_net_totals(None) == (None, None)
    assert parse_net_totals("nonsense") == (None, None)
    assert parse_net_totals("-1 -2") == (None, None)


def test_parse_host_metrics_reads_net_counters():
    results = {
        NET_STAGE: CommandResult(stdout="1048576 2097152\n", stderr="", exit_status=0),
    }
    metrics = parse_host_metrics(results, _config().servers[0])
    assert metrics.net_rx_bytes == 1048576
    assert metrics.net_tx_bytes == 2097152


def test_network_rate_uses_last_two_samples(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    start = datetime(2026, 11, 11, 2, 0, tzinfo=timezone.utc)
    _save(_report(start, 1_000_000, 500_000), db_path)
    _save(_report(start + timedelta(seconds=60), 1_600_000, 620_000), db_path)

    rates = fetch_host_network_rates(db_path, "a100-zyc")
    assert rates["rx_bytes_per_second"] == 10_000.0
    assert rates["tx_bytes_per_second"] == 2_000.0


def test_network_rate_handles_single_sample_and_reset(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    start = datetime(2026, 11, 11, 2, 0, tzinfo=timezone.utc)
    _save(_report(start, 1_000_000, 500_000), db_path)
    assert fetch_host_network_rates(db_path, "a100-zyc") == {
        "rx_bytes_per_second": None,
        "tx_bytes_per_second": None,
    }

    # Counter reset (reboot / interface re-created) must not yield negatives.
    _save(_report(start + timedelta(seconds=60), 900, 400), db_path)
    rates = fetch_host_network_rates(db_path, "a100-zyc")
    assert rates["rx_bytes_per_second"] is None
    assert rates["tx_bytes_per_second"] is None


def test_init_storage_migrates_legacy_metrics_table(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE host_metrics_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collected_at TEXT NOT NULL,
                host_name TEXT NOT NULL,
                host TEXT NOT NULL,
                success INTEGER NOT NULL DEFAULT 0,
                cpu_usage_percent REAL,
                memory_used_mb INTEGER,
                memory_total_mb INTEGER,
                disk_used_percent REAL,
                gpu_utilization_percent REAL,
                gpu_memory_used_mb INTEGER,
                gpu_memory_total_mb INTEGER,
                total_processes INTEGER,
                logged_in_user_count INTEGER,
                load_1 REAL,
                load_5 REAL,
                load_15 REAL
            )
            """
        )
        conn.execute(
            "INSERT INTO host_metrics_history (collected_at, host_name, host, success)"
            " VALUES ('2026-11-11T00:00:00+00:00', 'a100-zyc', '1.2.3.4', 1)"
        )
        conn.commit()

    init_storage(db_path)

    with sqlite3.connect(db_path) as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(host_metrics_history)")}
        assert {"net_rx_bytes", "net_tx_bytes"} <= columns
        # Existing rows survive the migration with NULL counters.
        row = conn.execute(
            "SELECT net_rx_bytes, net_tx_bytes FROM host_metrics_history"
        ).fetchone()
        assert row == (None, None)


def test_host_page_shows_network_throughput(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    start = datetime(2026, 11, 11, 2, 0, tzinfo=timezone.utc)
    _save(_report(start, 0, 0), db_path)
    # 1.5 MiB/s down and 512 KiB/s up over a 60 s gap.
    _save(
        _report(start + timedelta(seconds=60), 94_371_840, 31_457_280),
        db_path,
    )

    app = create_app(config=_config(), db_path=db_path)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "zyc"

    html = client.get("/host/a100-zyc").get_data(as_text=True)
    assert "网络吞吐" in html
    assert "↓ 1.5 MB/s" in html
    assert "↑ 512 KB/s" in html
    assert 'class="net-rx"' in html

    rate = app.jinja_env.filters["rate"]
    assert rate(None) == "—"
    assert rate(0) == "0 B/s"
    assert rate(2048) == "2.0 KB/s"
    assert rate(1024 * 1024 * 200) == "200 MB/s"
