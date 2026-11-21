"""v0.1.233：巡检报告的批量读取。

``GET /api/overview/report`` 此前对每台主机跑约 10 次查询（快照/磁盘/告警/
服务检查/检查历史/网络速率/采样计数/心跳条/账号行），20 台主机一次点击就是
200 次查询。现在 storage 层新增全队批量读（告警分组、检查历史分组、网络
速率分组、心跳条分组），``_build_fleet_report`` 一次读齐后按主机分发给
``_build_host_detail`` 的 ``precomputed`` 通道；单主机路径不变。
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage import storage
from servermanage.disk_health import AlertEvent
from servermanage.models import (
    AuthConfig,
    HostCheckResult,
    HostConfig,
    HostMetrics,
    HostReport,
    ReportConfig,
    SSHRuntimeConfig,
)
from servermanage.web.routes import _build_fleet_report, _build_host_detail

# 时间窗口按真实时钟计算，种子必须相对真实时钟铺开（避免日期炸弹）。
NOW = datetime.now(timezone.utc)
SHANGHAI = __import__("zoneinfo").ZoneInfo("Asia/Shanghai")

HOSTS = ("alpha", "beta", "gamma")


def _seed(tmp_path: Path) -> Path:
    db_path = tmp_path / "monitor.db"
    storage.init_storage(db_path)
    for index, name in enumerate(HOSTS):
        host = HostConfig(
            name=name,
            host=f"10.0.0.{index + 1}",
            port=22,
            username="root",
            auth=AuthConfig(type="password", password="pw"),
            checks=[
                {
                    "name": "SSH 22",
                    "type": "tcp",
                    "target": "22",
                    "timeout_seconds": 3,
                }
            ],
        )
        config_hosts = list(HOSTS)  # noqa: F841 - readability
        report = HostReport(
            host_name=name,
            host=f"10.0.0.{index + 1}",
            success=True,
            metrics=HostMetrics(
                hostname=name,
                os_pretty_name="Ubuntu 22.04",
                collected_at=NOW - timedelta(minutes=index + 1),
                cpu_usage_percent=10.0 + index,
                net_rx_bytes=1_000_000 + index * 500,
                net_tx_bytes=500_000 + index * 300,
            ),
        )
        storage.save_host_snapshot(report, db_path)
        storage.save_host_check_results(
            name,
            [HostCheckResult("SSH 22", "tcp", "22", "ok", "", latency_ms=5.0, checked_at=NOW)],
            db_path,
        )
        for step in range(4):
            storage.append_host_check_history(
                name,
                [
                    HostCheckResult(
                        "SSH 22",
                        "tcp",
                        "22",
                        "ok" if step < 3 else "fail",
                        "",
                        latency_ms=5.0,
                        checked_at=NOW - timedelta(minutes=10 * (4 - step)),
                    )
                ],
                db_path,
                keep=40,
            )
        storage.insert_alert(
            AlertEvent(
                name,
                "cpu",
                "warning",
                "CPU 偏高",
                f"{10 + index}%",
                f"{name}:cpu",
            ),
            db_path,
            created_at=NOW - timedelta(hours=1),
        )
        # 心跳条与网络速率需要历史采样
        for step in range(3):
            moment = NOW - timedelta(minutes=30 - step * 10)
            sample = HostReport(
                host_name=name,
                host=f"10.0.0.{index + 1}",
                success=True,
                metrics=HostMetrics(
                    hostname=name,
                    collected_at=moment,
                    cpu_usage_percent=10.0,
                    net_rx_bytes=1_000_000 + step * 1000 + index * 500,
                    net_tx_bytes=500_000 + step * 800 + index * 300,
                ),
            )
            storage.persist_host_reports(
                __import__("servermanage.models", fromlist=["DailyReport"]).DailyReport(
                    generated_at=moment, reports=[sample], subject_prefix="[t]"
                ),
                db_path,
                tz=SHANGHAI,
            )
    return db_path


def _config(db_path: Path):
    from servermanage.config import load_config_from_mapping

    return load_config_from_mapping(
        {
            "app": {"timezone": "Asia/Shanghai"},
            "report": {"daily_enabled": False, "weekly": {"enabled": False}},
            "dashboard": {"auth": {"password": "secret"}},
            "servers": [
                {
                    "name": name,
                    "host": f"10.0.0.{index + 1}",
                    "username": "root",
                    "auth": {"type": "key", "key_data": "PEM"},
                    "checks": [
                        {
                            "name": "SSH 22",
                            "type": "tcp",
                            "target": "22",
                            "timeout_seconds": 3,
                        }
                    ],
                }
                for index, name in enumerate(HOSTS)
            ],
        },
        allow_missing_secrets=True,
    )


# ---------------------------------------------------------------------------
# 新批量 API 与逐主机版本等价
# ---------------------------------------------------------------------------


def test_grouped_alerts_match_per_host_reader(tmp_path: Path):
    db_path = _seed(tmp_path)
    grouped = storage.list_recent_alerts_grouped(db_path, per_host=20)
    assert set(grouped) == set(HOSTS)
    for name in HOSTS:
        expected = storage.list_alerts_for_host(name, db_path, limit=20)
        assert grouped[name] == expected


def test_grouped_check_history_matches_per_host_reader(tmp_path: Path):
    db_path = _seed(tmp_path)
    grouped = storage.get_all_host_check_history(db_path)
    assert set(grouped) == set(HOSTS)
    for name in HOSTS:
        assert grouped[name] == storage.get_host_check_history(name, db_path)
    assert grouped["alpha"]["SSH 22"][-1] == "fail"  # 最新一条是人工注入的失败


def test_grouped_network_rates_match_per_host_reader(tmp_path: Path):
    db_path = _seed(tmp_path)
    grouped = storage.fetch_all_host_network_rates(db_path)
    for name in HOSTS:
        expected = storage.fetch_host_network_rates(db_path, name)
        assert grouped[name] == expected, name
    # 有三个采样点：速率应为正数
    assert grouped["alpha"]["rx_bytes_per_second"] > 0


def test_grouped_uptime_strips_match_per_host_reader(tmp_path: Path):
    db_path = _seed(tmp_path)
    grouped = storage.fetch_all_host_uptime_strips(
        db_path, hours=24, bucket_minutes=15, now=NOW
    )
    assert set(grouped) == set(HOSTS)
    for name in HOSTS:
        expected = storage.fetch_host_uptime_strip(
            db_path, name, hours=24, bucket_minutes=15, now=NOW
        )
        assert grouped[name] == expected, name
    assert grouped["alpha"]["samples"] == 3


# ---------------------------------------------------------------------------
# 巡检报告走批量通道
# ---------------------------------------------------------------------------


def test_fleet_report_uses_bounded_connections(tmp_path: Path, monkeypatch):
    db_path = _seed(tmp_path)
    config = _config(db_path)
    calls = {"count": 0}
    real_connect = sqlite3.connect

    def counting_connect(*args, **kwargs):
        if args and Path(args[0]) == db_path:
            calls["count"] += 1
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(storage.sqlite3, "connect", counting_connect)

    text = _build_fleet_report(config, db_path, NOW)
    assert "全网巡检报告" in text
    # 逐主机路径是 10 查询 × 3 台 ≈ 30+；批量通道应恒定在十几次以内。
    assert calls["count"] <= 16, calls["count"]
    # 报告内容仍然覆盖全部主机
    for name in HOSTS:
        assert name in text


def test_fleet_detail_matches_per_host_path(tmp_path: Path):
    db_path = _seed(tmp_path)
    config = _config(db_path)
    # 批量路径
    tz = config and __import__("zoneinfo").ZoneInfo("Asia/Shanghai")
    fleet_calls: list[dict] = []
    detail_batch = _build_host_detail(
        "alpha", config, db_path, precomputed=_precomputed(db_path, config, fleet_calls)
    )
    detail_single = _build_host_detail("alpha", config, db_path)
    # 两条路径的字段内容一致（采集类时间戳来自同一批种子数据）
    for key in ("name", "success", "metrics", "alerts", "checks", "check_history", "network"):
        assert detail_batch[key] == detail_single[key], key
    assert detail_batch["collection_uptime"]["samples"] == detail_single["collection_uptime"]["samples"]
    assert detail_batch["uptime_strip"]["samples"] == detail_single["uptime_strip"]["samples"]
    assert len(fleet_calls) == 0  # 批量路径不应再触发逐主机查询


def _precomputed(db_path, config, calls: list):
    """构建与 _build_fleet_report 相同的批量预取（用于等价性断言）。"""
    from servermanage.web.routes import _gpu_usage_from_metrics, _localize_alerts

    tz = __import__("zoneinfo").ZoneInfo("Asia/Shanghai")
    latest_raw = {
        item["host_name"]: item for item in storage.get_all_host_snapshots(db_path)
    }
    real_connect = sqlite3.connect

    def counting_connect(*args, **kwargs):
        if args and Path(args[0]) == db_path:
            calls.append(1)
        return real_connect(*args, **kwargs)

    monkey = sqlite3
    # 等价性测试不关心连接数，这里不做拦截。
    del monkey, real_connect, counting_connect
    return {
        "snapshots": latest_raw,
        "disks": {
            item["host_name"]: item for item in storage.get_all_disk_health(db_path)
        },
        "alerts": {
            host: _localize_alerts(items, tz)
            for host, items in storage.list_recent_alerts_grouped(db_path, per_host=20).items()
        },
        "checks": storage.get_all_host_check_results(db_path),
        "check_history": storage.get_all_host_check_history(db_path),
        "network": storage.fetch_all_host_network_rates(db_path),
        "sample_counts": storage.count_recent_samples_by_host(db_path, hours=24),
        "uptime_strips": storage.fetch_all_host_uptime_strips(
            db_path, hours=24, bucket_minutes=15, now=NOW
        ),
        "users": {
            "snapshots": storage.get_all_host_user_snapshots(db_path),
            "baselines": storage.get_all_user_baselines(db_path),
            "deltas": storage.get_all_user_usage_deltas(db_path, days=7),
            "gpu_usage": {
                name: _gpu_usage_from_metrics((item or {}).get("metrics") or {})
                for name, item in latest_raw.items()
            },
        },
    }
