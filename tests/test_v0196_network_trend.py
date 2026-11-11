"""v0.1.96：主机历史趋势中的网络下行速率。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage.models import DailyReport, HostMetrics, HostReport
from servermanage.storage import fetch_host_history, init_storage, persist_host_reports

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"

START = datetime(2026, 11, 11, 2, 0, tzinfo=timezone.utc)


def _save(moment: datetime, rx: int | None, tx: int | None, db_path: Path) -> None:
    report = HostReport(
        host_name="a100-zyc",
        host="202.119.189.245",
        success=True,
        metrics=HostMetrics(collected_at=moment, net_rx_bytes=rx, net_tx_bytes=tx),
    )
    persist_host_reports(
        DailyReport(
            generated_at=moment,
            reports=[report],
            subject_prefix="test",
        ),
        db_path,
    )


def _net(points):
    return [(point["net_rx"], point["net_tx"]) for point in points]


def test_history_derives_rates_from_counters(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    _save(START, 1000, 500, db_path)
    _save(START + timedelta(seconds=60), 1000 + 600000, 500 + 120000, db_path)

    points = fetch_host_history(db_path, "a100-zyc", range_key="24h", now=START + timedelta(minutes=5))
    assert len(points) == 2
    # 第一个点没有前序样本，速率未知。
    assert _net(points)[0] == (None, None)
    assert _net(points)[1] == (10000.0, 2000.0)


def test_counter_reset_reports_unknown_rate(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    _save(START, 5000, 5000, db_path)
    _save(START + timedelta(seconds=60), 1000, 900, db_path)

    points = fetch_host_history(db_path, "a100-zyc", range_key="24h", now=START + timedelta(minutes=5))
    assert _net(points)[1] == (None, None)


def test_missing_counters_skip_rate(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    _save(START, 1000, 500, db_path)
    _save(START + timedelta(seconds=60), None, None, db_path)
    _save(START + timedelta(seconds=120), 2000, 800, db_path)

    points = fetch_host_history(db_path, "a100-zyc", range_key="24h", now=START + timedelta(minutes=5))
    rates = _net(points)
    assert rates[1] == (None, None)
    # 前一个样本计数器缺失，第三个点也无法比较。
    assert rates[2] == (None, None)


def test_daily_range_keeps_keys_without_network(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    _save(START, 1000, 500, db_path)
    points = fetch_host_history(db_path, "a100-zyc", range_key="7d", now=START + timedelta(days=1))
    for point in points:
        assert "net_rx" in point and "net_tx" in point
        assert point["net_rx"] is None


def test_template_has_network_trend_block():
    html = (TEMPLATES / "host.html").read_text(encoding="utf-8")
    assert 'data-trend="net_rx"' in html
    assert 'data-trend-latest="net_rx"' in html
    assert "网络下行" in html


def test_script_formats_network_rate():
    js = (STATIC / "host-detail.js").read_text(encoding="utf-8")
    assert "function formatRate(bytesPerSecond)" in js
    assert "'B/s', 'KB/s', 'MB/s', 'GB/s'" in js
    assert "if (key === 'net_rx') { return formatRate(num); }" in js
    assert "net_rx: '#0891b2'" in js
    assert "net_rx: '网络下行'" in js
