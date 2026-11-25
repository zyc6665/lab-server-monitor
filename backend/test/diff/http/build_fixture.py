#!/usr/bin/env python
"""Build a deterministic SQLite fixture for the cross-stack HTTP golden diff.

The fixture is generated with the *pure Python* ``servermanage.storage`` API so
that the Python Flask oracle and the Node/Express composition root are fed the
exact same rows.  The Node side copies this file and opens the copy read/write
(only to create its own DPAPI-encrypted admin secret), so the two stacks never
fight over a shared handle.

Determinism
-----------
Every value in the database is fixed except the *timestamps*, which are pinned
to fixed offsets from the generation instant (``now``).  Using now-relative
anchors keeps the time-windowed endpoints (``/api/overview/history``,
``/api/overview/capacity``, ``/api/host/<h>/history``) meaningfully populated
while still being deterministic *for both stacks* — they read the same rows and
therefore observe identical windows.  Cache/derived "current time" values are
masked by the HTTP diff, never compared.

Secrets: this builder deliberately does NOT create (or rotate) the admin
credential or the session secret.  Each stack writes its own DPAPI blob on its
own copy, so the diff does not depend on cross-implementation DPAPI interop.

Output: prints a single JSON object to stdout::

    {"db_path": "...", "config_path": "...", "servers_path": "...",
     "admin": {"username": "admin", "password": "..."} }
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Allow running this helper directly (``python .../build_fixture.py``): ensure the
# repository root is importable even when PYTHONPATH has not been set up.
_REPO_ROOT = next(
    (p for p in Path(__file__).resolve().parents if (p / "servermanage").is_dir()),
    None,
)
if _REPO_ROOT is not None and str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from servermanage import storage
from servermanage.disk_health import AlertEvent
from servermanage.models import (
    DailyReport,
    DiskUsageRow,
    GPUSummaryRow,
    HostCheckResult,
    HostMetrics,
    HostReport,
    LoadAverage,
    LoggedInUser,
    MemorySummary,
)

ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "Diff-Test-Passw0rd!"


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat()


def _metrics(
    *,
    hostname: str,
    collected_at: datetime,
    cpu: float,
    mem_used_mb: int,
    mem_total_mb: int,
    disk_percent: int,
    gpu_util: int,
    gpu_used_mb: int,
    gpu_total_mb: int,
    processes: int,
    users: int,
    load: tuple[float, float, float],
    rx: int,
    tx: int,
) -> HostMetrics:
    return HostMetrics(
        hostname=hostname,
        os_pretty_name="Ubuntu 22.04.4 LTS",
        kernel_version="5.15.0-105-generic",
        uptime="12 days, 3:04:05",
        collected_at=collected_at,
        load_average=LoadAverage(load_1=load[0], load_5=load[1], load_15=load[2]),
        cpu_core_count=32,
        cpu_usage_percent=cpu,
        memory=MemorySummary(
            total_mb=mem_total_mb,
            used_mb=mem_used_mb,
            free_mb=mem_total_mb - mem_used_mb - 2048,
            shared_mb=512,
            buff_cache_mb=2048,
            available_mb=mem_total_mb - mem_used_mb,
            swap_total_mb=16384,
            swap_used_mb=1024,
            swap_free_mb=15360,
        ),
        disk_usage=[
            DiskUsageRow(
                filesystem="/dev/sda1",
                size="1.8T",
                used="720G",
                available="1.0T",
                percent=f"{disk_percent}%",
                mountpoint="/",
            ),
            DiskUsageRow(
                filesystem="/dev/sdb1",
                size="3.6T",
                used="1.1T",
                available="2.5T",
                percent="31%",
                mountpoint="/data",
            ),
        ],
        logged_in_users=[
            LoggedInUser(username="alice", terminal="pts/0", login_at="2026-01-15 08:11", remote_host="10.0.0.5")
        ][:users],
        total_processes=processes,
        gpu_summary=[
            GPUSummaryRow(
                index=0,
                name="NVIDIA A100-SXM4-80GB",
                utilization_percent=gpu_util,
                temperature_c=63,
                memory_used_mb=gpu_used_mb,
                memory_total_mb=gpu_total_mb,
            )
        ],
        net_rx_bytes=rx,
        net_tx_bytes=tx,
    )


def _host_report_a(collected_at: datetime) -> HostReport:
    return HostReport(
        host_name="host-a",
        host="10.0.0.11",
        success=True,
        metrics=_metrics(
            hostname="host-a",
            collected_at=collected_at,
            cpu=41.5,
            mem_used_mb=20480,
            mem_total_mb=65536,
            disk_percent=58,
            gpu_util=37,
            gpu_used_mb=20480,
            gpu_total_mb=81920,
            processes=312,
            users=1,
            load=(1.25, 1.10, 0.98),
            rx=123456789,
            tx=98765432,
        ),
    )


def _host_report_b(collected_at: datetime) -> HostReport:
    return HostReport(
        host_name="host-b",
        host="10.0.0.12",
        success=True,
        metrics=_metrics(
            hostname="host-b",
            collected_at=collected_at,
            cpu=12.0,
            mem_used_mb=8192,
            mem_total_mb=32768,
            disk_percent=22,
            gpu_util=5,
            gpu_used_mb=2048,
            gpu_total_mb=40960,
            processes=180,
            users=0,
            load=(0.30, 0.25, 0.20),
            rx=22222222,
            tx=11111111,
        ),
    )


def _server_configs() -> list[dict]:
    return [
        {
            "name": "host-a",
            "host": "10.0.0.11",
            "port": 22,
            "username": "monitor",
            "auth": {"type": "key", "key_path": "/home/monitor/.ssh/id_rsa"},
            "tags": ["lab", "gpu"],
            "disk_mounts": ["/", "/data"],
            "group": "GPU 集群",
            "owner": "alice",
            "location": "机房 A",
            "notes": "primary gpu node",
            "checks": [
                {"name": "gateway", "type": "ping", "target": "10.0.0.1", "timeout_seconds": 5, "enabled": True}
            ],
            "allow_user_write": False,
        },
        {
            "name": "host-b",
            "host": "10.0.0.12",
            "port": 22,
            "username": "monitor",
            "auth": {"type": "key", "key_path": "/home/monitor/.ssh/id_rsa"},
            "tags": ["lab"],
            "disk_mounts": ["/"],
            "group": "CPU 集群",
            "owner": "bob",
            "location": "机房 B",
            "notes": "",
            "checks": [],
            "allow_user_write": False,
        },
    ]


def build(out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    db_path = out_dir / "fixture.db"
    if db_path.exists():
        db_path.unlink()
    for sibling in (db_path.with_suffix(db_path.suffix + "-wal"), db_path.with_suffix(db_path.suffix + "-shm")):
        if sibling.exists():
            sibling.unlink()

    storage.init_storage(db_path)

    now = datetime.now(timezone.utc).replace(microsecond=0)
    history_offsets = [1, 2, 6, 12, 20, 48, 120, 240, 480, 960]

    reports_a = []
    for hours in history_offsets:
        reports_a.append(_host_report_a(now - timedelta(hours=hours)))
    # Persist historical metrics + daily summaries for host-a.
    storage.persist_host_reports(
        DailyReport(generated_at=now, reports=reports_a, subject_prefix=""),
        db_path,
        tz=timezone.utc,
    )

    # Latest snapshot per host: host-a fresh success, host-b a failed probe.
    storage.save_host_snapshot(reports_a[0], db_path)
    storage.save_host_snapshot(
        HostReport(host_name="host-b", host="10.0.0.12", success=False, metrics=HostMetrics(collected_at=now - timedelta(minutes=5))),
        db_path,
    )

    # One availability check result for host-a.
    storage.save_host_check_results(
        "host-a",
        [
            HostCheckResult(
                name="gateway",
                type="ping",
                target="10.0.0.1",
                status="ok",
                message="1 packets transmitted, 1 received",
                latency_ms=0.42,
                checked_at=now - timedelta(minutes=4),
            )
        ],
        db_path,
    )

    # Alerts across severities, one acknowledged, one resolved.
    alert_specs = [
        ("host-a", "cpu", "warning", "CPU 使用率偏高", "CPU 使用率连续 2 个周期超过 80%", "fp-cpu-1", "active", 1),
        ("host-a", "gpu", "critical", "GPU 显存紧张", "GPU0 显存使用率超过 90%", "fp-gpu-1", "active", 2),
        ("host-b", "offline", "critical", "主机离线", "连续 2 次采集失败", "fp-off-1", "acknowledged", 5),
        ("host-a", "disk", "warning", "磁盘空间不足", "挂载点 / 使用率 88%", "fp-disk-1", "resolved", 30),
    ]
    for host, category, severity, title, message, fingerprint, status, hours in alert_specs:
        created = now - timedelta(hours=hours)
        alert_id = storage.insert_alert(
            AlertEvent(
                host_name=host,
                category=category,
                severity=severity,
                title=title,
                message=message,
                fingerprint=fingerprint,
            ),
            db_path,
            created_at=created,
        )
        if status != "active":
            storage.update_alert(
                alert_id,
                db_path,
                status=status,
                ack_at=_iso(created + timedelta(minutes=10)),
            )

    # Task state rows surfaced by /api/system/health.
    storage.set_task_state("poll", db_path, last_run_at=_iso(now - timedelta(minutes=10)), last_result="ok")
    storage.set_task_state("disk", db_path, last_run_at=_iso(now - timedelta(hours=3)), last_result="ok")

    # User snapshots for /api/users.
    collected = _iso(now - timedelta(minutes=30))
    storage.save_host_user_snapshot(
        "host-a",
        [
            {
                "username": "alice",
                "uid": 1001,
                "gid": 1001,
                "primary_group": "alice",
                "gecos": "Alice Zhang",
                "home": "/home/alice",
                "shell": "/bin/bash",
                "groups": ["alice", "docker", "sudo"],
                "in_docker": True,
                "in_sudo": True,
                "home_exists": True,
                "home_owner": "alice",
                "home_group": "alice",
                "home_mode": "700",
                "home_size_bytes": 5368709120,
                "data_exists": True,
                "data_owner": "alice",
                "data_group": "alice",
                "data_mode": "755",
                "data_size_bytes": 107374182400,
                "data_supported": True,
                "usage_readable": True,
                "usage_stale": False,
                "usage_collected_at": collected,
                "collected_at": collected,
            },
            {
                "username": "bob",
                "uid": 1002,
                "gid": 1002,
                "primary_group": "bob",
                "gecos": "Bob Li",
                "home": "/home/bob",
                "shell": "/bin/bash",
                "groups": ["bob"],
                "in_docker": False,
                "in_sudo": False,
                "home_exists": True,
                "home_owner": "bob",
                "home_group": "bob",
                "home_mode": "700",
                "home_size_bytes": 2147483648,
                "data_exists": False,
                "data_supported": True,
                "usage_readable": True,
                "usage_stale": False,
                "usage_collected_at": collected,
                "collected_at": collected,
            },
        ],
        db_path,
    )
    storage.save_host_user_snapshot("host-b", [], db_path)
    storage.save_user_scan_state(
        "host-a",
        db_path=db_path,
        last_scan_at=now - timedelta(minutes=30),
        last_usage_at=now - timedelta(hours=6),
        last_error="",
    )
    storage.save_user_scan_state(
        "host-b",
        db_path=db_path,
        last_scan_at=now - timedelta(minutes=30),
        last_usage_at=now - timedelta(hours=6),
        last_error="",
    )

    # Effective settings overrides (validated keys only; loaded as-is by both
    # stacks and merged over their respective defaults).
    storage.save_app_settings(
        "monitoring",
        {
            "timezone": "UTC",
            "poll_interval_seconds": 300,
            "concurrency": 4,
            "retention_days": 60,
        },
        db_path,
    )
    storage.save_app_settings(
        "alerts",
        {
            "thresholds": {
                "cpu_percent": 85,
                "memory_percent": 80,
                "disk_percent": 85,
                "gpu_memory_percent": 80,
                "disk_temperature_c": 60,
            },
            "cooldown_minutes": 30,
            "consecutive_periods": 3,
        },
        db_path,
    )
    storage.save_app_settings(
        "user_monitoring",
        {"enabled": True, "write_enabled": False, "scan_interval_seconds": 1800},
        db_path,
    )
    storage.save_app_settings("disk_health", {"enabled": True}, db_path)

    servers = _server_configs()
    config = {
        "storage": {"db_path": str(db_path)},
        "app": {"timezone": "UTC"},
        "servers": servers,
    }
    config_path = out_dir / "config.yaml"
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    servers_path = out_dir / "servers.json"
    servers_path.write_text(json.dumps(servers, ensure_ascii=False, indent=2), encoding="utf-8")

    # Fold WAL back into the main file so a plain file copy of fixture.db is
    # self-contained (the -wal file is truncated to zero after this).
    conn = sqlite3.connect(db_path, timeout=30.0, isolation_level=None)
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        conn.close()

    return {
        "db_path": str(db_path),
        "config_path": str(config_path),
        "servers_path": str(servers_path),
        "admin": {"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD},
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="Output directory for the fixture files")
    args = parser.parse_args(argv)
    result = build(Path(args.out))
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
