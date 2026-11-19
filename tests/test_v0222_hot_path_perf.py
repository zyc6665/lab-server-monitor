"""v0.1.222：看板 30 秒轮询热路径的性能优化。

- ``init_storage`` 开启 WAL 并去掉每次写库前的重复 DDL；
- ``get_all_host_snapshots`` / ``get_all_disk_health`` 批量读取，
  取代逐主机 N+1 连接；
- 概览的活跃告警计数改为一条分组聚合；
- ``database_integrity`` 缓存只看 TTL（采集 constantly 写库，
  mtime 缓存键永远不命中，导致每 30 秒全库 quick_check）。
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from servermanage import storage
from servermanage.disk_health import (
    AlertEvent,
    DiskControllerInfo,
    DiskHealthReport,
    PhysicalDriveInfo,
    VirtualDriveInfo,
)
from servermanage.models import HostCheckResult

NOW = datetime(2026, 11, 19, 12, 0, tzinfo=timezone.utc)


def _connect_calls(monkeypatch, target: Path):
    calls = {"count": 0}
    real_connect = sqlite3.connect

    def counting_connect(*args, **kwargs):
        if args and Path(args[0]) == target:
            calls["count"] += 1
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(storage.sqlite3, "connect", counting_connect)
    return calls


def _seed_snapshot(db_path: Path, host_name: str, cpu: float) -> None:
    raw = json.dumps(
        {"metrics": {"cpu_usage_percent": cpu}, "errors": []},
        ensure_ascii=False,
    )
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO host_latest_snapshot (host_name, collected_at, success, raw_json)"
            " VALUES (?, ?, 1, ?)",
            (host_name, "2026-11-19T00:00:00+00:00", raw),
        )


# ---------------------------------------------------------------------------
# init_storage：WAL + 跳过重复 DDL
# ---------------------------------------------------------------------------


def test_init_storage_enables_wal(tmp_path: Path) -> None:
    db = tmp_path / "monitor.db"
    storage.init_storage(db)
    with sqlite3.connect(db) as conn:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode == "wal"


def test_init_storage_skips_repeat_ddl(tmp_path: Path) -> None:
    db = tmp_path / "monitor.db"
    storage.init_storage(db)
    with sqlite3.connect(db) as conn:
        conn.execute("DROP TABLE host_latest_snapshot")
        conn.commit()
    # 第二次调用应直接跳过：被删掉的表不会被重建。
    storage.init_storage(db)
    with sqlite3.connect(db) as conn:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
    assert "host_latest_snapshot" not in tables


def test_init_storage_recreates_deleted_database(tmp_path: Path) -> None:
    db = tmp_path / "monitor.db"
    storage.init_storage(db)
    db.unlink()
    storage.init_storage(db)
    with sqlite3.connect(db) as conn:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
    assert "host_latest_snapshot" in tables


def test_init_storage_force_rebuilds_schema(tmp_path: Path) -> None:
    db = tmp_path / "monitor.db"
    storage.init_storage(db)
    with sqlite3.connect(db) as conn:
        conn.execute("DROP TABLE host_latest_snapshot")
        conn.commit()
    storage.init_storage(db, force=True)
    with sqlite3.connect(db) as conn:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
    assert "host_latest_snapshot" in tables


# ---------------------------------------------------------------------------
# 批量快照 / 检查结果 / 告警计数
# ---------------------------------------------------------------------------


def test_get_all_host_snapshots_uses_one_connection(tmp_path: Path, monkeypatch) -> None:
    db = tmp_path / "monitor.db"
    storage.init_storage(db)
    for index in range(6):
        _seed_snapshot(db, f"host-{index}", 10.0 + index)
    calls = _connect_calls(monkeypatch, db)
    snapshots = storage.get_all_host_snapshots(db)
    assert [item["host_name"] for item in snapshots] == [f"host-{i}" for i in range(6)]
    assert calls["count"] == 1


def test_get_all_host_snapshots_matches_single_host_reader(tmp_path: Path) -> None:
    db = tmp_path / "monitor.db"
    storage.init_storage(db)
    _seed_snapshot(db, "alpha", 12.5)
    _seed_snapshot(db, "beta", 45.0)
    batch = {item["host_name"]: item for item in storage.get_all_host_snapshots(db)}
    for name in ("alpha", "beta"):
        assert batch[name] == storage.get_host_snapshot(name, db)


def test_get_all_host_check_results_groups_by_host(tmp_path: Path) -> None:
    db = tmp_path / "monitor.db"
    storage.init_storage(db)
    storage.save_host_check_results(
        "alpha",
        [
            HostCheckResult("ssh", "tcp", "22", "ok", "", latency_ms=5.0),
            HostCheckResult("web", "http", "http://a", "fail", "timeout"),
        ],
        db,
    )
    storage.save_host_check_results(
        "beta",
        [HostCheckResult("ssh", "tcp", "22", "ok", "")],
        db,
    )
    grouped = storage.get_all_host_check_results(db)
    assert set(grouped) == {"alpha", "beta"}
    assert [row["check_name"] for row in grouped["alpha"]] == ["ssh", "web"]
    assert grouped["alpha"] == storage.get_host_check_results("alpha", db)
    assert grouped["beta"] == storage.get_host_check_results("beta", db)


def test_count_active_alerts_by_host(tmp_path: Path) -> None:
    db = tmp_path / "monitor.db"
    storage.init_storage(db)
    storage.insert_alert(
        AlertEvent("alpha", "cpu", "warning", "CPU 高", "95%", "fp-a"), db
    )
    storage.insert_alert(
        AlertEvent("alpha", "memory", "critical", "内存高", "97%", "fp-a2"), db
    )
    storage.insert_alert(
        AlertEvent("beta", "disk", "warning", "磁盘高", "96%", "fp-b"), db
    )
    with sqlite3.connect(db) as conn:
        conn.execute(
            "UPDATE alerts SET status = 'resolved' WHERE host_name = 'beta'"
        )
        conn.commit()
    counts = storage.count_active_alerts_by_host(db)
    assert counts == {"alpha": 2}


def test_get_all_disk_health_batch_matches_per_host_reader(tmp_path: Path) -> None:
    db = tmp_path / "monitor.db"
    storage.init_storage(db)
    for name in ("alpha", "beta"):
        for stamp, state in ((NOW, "ok"), (datetime(2026, 11, 20, tzinfo=timezone.utc), "warning")):
            storage.save_disk_health(
                DiskHealthReport(
                    host_name=name,
                    collected_at=stamp,
                    status=state,
                    message="",
                    controllers=[
                        DiskControllerInfo(controller=0, model="LSI 9361", health=state)
                    ],
                    virtual_drives=[
                        VirtualDriveInfo(controller=0, vd_id=0, state=state, health=state)
                    ],
                    physical_drives=[
                        PhysicalDriveInfo(
                            controller=0,
                            slot=1,
                            model="ST12000NM001G",
                            state="online",
                            media_errors=1 if state == "warning" else 0,
                            temperature_c=38,
                            health=state,
                        )
                    ],
                ),
                db,
            )
    batch = {item["host_name"]: item for item in storage.get_all_disk_health(db)}
    assert set(batch) == {"alpha", "beta"}
    for name in ("alpha", "beta"):
        expected = storage.get_disk_health(name, db)
        assert batch[name] == expected
        assert batch[name]["status"] == "warning"  # 最新一批
        assert batch[name]["physical_drives"][0]["media_errors"] == 1


def test_get_all_disk_health_uses_one_connection(tmp_path: Path, monkeypatch) -> None:
    db = tmp_path / "monitor.db"
    storage.init_storage(db)
    storage.save_disk_health(
        DiskHealthReport(host_name="alpha", collected_at=NOW, status="ok"), db
    )
    calls = _connect_calls(monkeypatch, db)
    storage.get_all_disk_health(db)
    assert calls["count"] == 1


# ---------------------------------------------------------------------------
# database_integrity：TTL 缓存不再被 mtime 击穿
# ---------------------------------------------------------------------------


def test_database_integrity_cache_survives_mtime_change(
    tmp_path: Path, monkeypatch
) -> None:
    db = tmp_path / "monitor.db"
    storage.init_storage(db)
    calls = _connect_calls(monkeypatch, db)
    first = storage.database_integrity(db, cache_seconds=300)
    # 模拟采集线程不断写库导致 mtime/大小变化。
    import os
    import time as time_mod

    stat = db.stat()
    future = stat.st_atime + 5, stat.st_mtime + 5
    os.utime(db, ns=(int(future[0] * 1e9), int(future[1] * 1e9)))
    del stat
    time_mod.sleep(0.01)
    second = storage.database_integrity(db, cache_seconds=300)
    assert first == second == (True, "完整性检查通过")
    assert calls["count"] == 1


def test_database_integrity_cache_expires_after_ttl(
    tmp_path: Path, monkeypatch
) -> None:
    db = tmp_path / "monitor.db"
    storage.init_storage(db)
    calls = _connect_calls(monkeypatch, db)
    storage.database_integrity(db, cache_seconds=1)
    # 直接快进单调时钟，模拟 TTL 过期。
    real_monotonic = storage._time.monotonic
    monkeypatch.setattr(storage._time, "monotonic", lambda: real_monotonic() + 3600)
    storage.database_integrity(db, cache_seconds=1)
    assert calls["count"] == 2
