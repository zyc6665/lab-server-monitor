#!/usr/bin/env python3
"""Generate the shared differential-E2E seed database (P7 Task 1).

The database is produced exclusively through the real ``servermanage.storage``
API (``init_storage`` + the per-domain ``save_*`` / ``insert_*`` helpers) so the
schema and the encoded JSON payloads can never drift from the Python oracle.
Both the Python stack and the Node backend open the very same file; therefore
every TEXT timestamp is written with the exact same shape:

    YYYY-MM-DDTHH:MM:SS.ffffff+00:00

The reference instant is pinned (``EPOCH`` below) so re-running the script
produces the same logical content.  A small finalisation pass rewrites the few
columns the storage helpers stamp from ``datetime.now()`` (settings /
daily-summary ``updated_at`` and silence ``created_at``) to that same pinned
instant, and sets ``PRAGMA user_version = 1`` (Python's ``init_storage`` never
sets it, but the Node schema defines 1 as the baseline).

Usage (from ``backend/``)::

    python test/diff/seed/build_seed.py

This deletes and regenerates ``test/fixtures/seed/servermonitor-seed.db``.
"""

from __future__ import annotations

import gc
import math
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[3]  # backend/test/diff/seed -> repository root
if str(REPO_ROOT) not in sys.path:
    # The repo copy of ``servermanage`` MUST win over any unrelated pip
    # distribution of the same name that may sit in the user site-packages.
    sys.path.insert(0, str(REPO_ROOT))

from servermanage.disk_health import (  # noqa: E402
    AlertEvent,
    DiskControllerInfo,
    DiskHealthReport,
    PhysicalDriveInfo,
    VirtualDriveInfo,
)
from servermanage.models import (  # noqa: E402
    DailyReport,
    DiskUsageRow,
    GPUSummaryRow,
    HostMetrics,
    HostReport,
    LoadAverage,
    MemorySummary,
    ThermalZone,
)
from servermanage.storage.alerts import (  # noqa: E402
    insert_alert,
    insert_silence,
    update_alert,
)
from servermanage.storage.base import init_storage, save_app_settings  # noqa: E402
from servermanage.storage.disk import save_disk_health  # noqa: E402
from servermanage.storage.hosts import (  # noqa: E402
    persist_host_reports,
    save_host_snapshot,
)
from servermanage.storage.users import save_host_user_scan_result  # noqa: E402

# ``backend/test/fixtures/seed/servermonitor-seed.db``
DB_PATH = HERE.parents[1] / "fixtures" / "seed" / "servermonitor-seed.db"

# ---------------------------------------------------------------------------
# Deterministic clock
# ---------------------------------------------------------------------------
# Pinned reference instant (Asia/Shanghai 2026-11-25 20:00:00 == 12:00 UTC).
# A non-zero microsecond keeps ``datetime.isoformat()`` from dropping the
# fractional part, so the ``.ffffff+00:00`` shape is always preserved.
EPOCH = datetime(2026, 11, 25, 12, 0, 0, 123456, tzinfo=timezone.utc)

TOTAL_DAYS = 90


def ts(
    days_ago: int = 0,
    *,
    hour: int = 12,
    minute: int = 0,
    second: int = 0,
    microsecond: int = 123456,
) -> datetime:
    """Return a pinned, timezone-aware UTC instant ``days_ago`` before EPOCH."""
    moment = EPOCH - timedelta(days=days_ago)
    return moment.replace(
        hour=hour, minute=minute, second=second, microsecond=microsecond
    )


def iso(moment: datetime) -> str:
    """Format a datetime exactly as ``YYYY-MM-DDTHH:MM:SS.ffffff+00:00``."""
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f+00:00")


# ---------------------------------------------------------------------------
# Host definitions
# ---------------------------------------------------------------------------
HOSTS: list[dict] = [
    {
        "host_name": "lab-01",
        "host": "lab-01.lab.example.edu",
        "os": "Ubuntu 24.04.1 LTS",
        "kernel": "6.8.0-45-generic",
        "cores": 16,
        "mem_total": 65536,
        "cpu_base": 18.0,
        "cpu_slope": 0.42,
        "mem_base": 0.40,
        "mem_slope": 0.0018,
        "disk_base": 41.0,
        "phase": 0.0,
        "gpus": [
            {
                "index": 0,
                "name": "NVIDIA T4",
                "util_base": 4,
                "util_slope": 0.05,
                "mem_total": 16384,
                "mem_ratio": 0.22,
                "temp_base": 36,
            }
        ],
    },
    {
        "host_name": "lab-02",
        "host": "lab-02.lab.example.edu",
        "os": "Ubuntu 22.04.4 LTS",
        "kernel": "5.15.0-119-generic",
        "cores": 32,
        "mem_total": 131072,
        "cpu_base": 24.0,
        "cpu_slope": 0.36,
        "mem_base": 0.46,
        "mem_slope": 0.0015,
        "disk_base": 48.0,
        "phase": 1.3,
        "gpus": [
            {
                "index": 0,
                "name": "NVIDIA RTX A4000",
                "util_base": 6,
                "util_slope": 0.06,
                "mem_total": 16384,
                "mem_ratio": 0.28,
                "temp_base": 39,
            }
        ],
    },
    {
        "host_name": "gpu-01",
        "host": "gpu-01.lab.example.edu",
        "os": "Ubuntu 24.04.1 LTS",
        "kernel": "6.8.0-45-generic",
        "cores": 64,
        "mem_total": 262144,
        "cpu_base": 31.0,
        "cpu_slope": 0.48,
        "mem_base": 0.44,
        "mem_slope": 0.0022,
        "disk_base": 55.0,
        "phase": 2.1,
        "gpus": [
            {
                "index": 0,
                "name": "NVIDIA A100-SXM4-80GB",
                "util_base": 35,
                "util_slope": 0.30,
                "mem_total": 81920,
                "mem_ratio": 0.35,
                "temp_base": 42,
            },
            {
                "index": 1,
                "name": "NVIDIA A100-SXM4-80GB",
                "util_base": 28,
                "util_slope": 0.28,
                "mem_total": 81920,
                "mem_ratio": 0.31,
                "temp_base": 41,
            },
        ],
    },
]


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _gpu_rows(cfg: dict, day_index: int) -> list[GPUSummaryRow]:
    rows: list[GPUSummaryRow] = []
    for gpu in cfg["gpus"]:
        util = int(
            _clamp(
                gpu["util_base"]
                + gpu["util_slope"] * day_index
                + 2.0 * math.sin(day_index / 9.0 + gpu["index"]),
                0.0,
                100.0,
            )
        )
        mem_used = int(gpu["mem_total"] * gpu["mem_ratio"] * (1.0 + 0.0015 * day_index))
        mem_used = min(mem_used, gpu["mem_total"])
        temperature = int(gpu["temp_base"] + 12.0 * util / 100.0)
        rows.append(
            GPUSummaryRow(
                index=int(gpu["index"]),
                name=str(gpu["name"]),
                utilization_percent=util,
                temperature_c=temperature,
                memory_used_mb=mem_used,
                memory_total_mb=int(gpu["mem_total"]),
            )
        )
    return rows


def build_metrics(cfg: dict, day_index: int) -> HostMetrics:
    """Build one deterministic :class:`HostMetrics` for ``day_index`` (0=oldest)."""
    phase = float(cfg["phase"])
    cpu = _clamp(
        cfg["cpu_base"]
        + cfg["cpu_slope"] * day_index
        + 1.5 * math.sin(day_index / 7.0 + phase),
        1.0,
        99.0,
    )
    total_mb = int(cfg["mem_total"])
    mem_ratio = _clamp(
        cfg["mem_base"]
        + cfg["mem_slope"] * day_index
        + 0.01 * math.sin(day_index / 5.0 + phase),
        0.1,
        0.95,
    )
    used_mb = int(total_mb * mem_ratio)
    free_mb = total_mb - used_mb
    buff_cache_mb = int(total_mb * 0.08)
    available_mb = min(total_mb, free_mb + buff_cache_mb)
    shared_mb = int(total_mb * 0.01)
    swap_total = total_mb // 4
    swap_used = int(swap_total * 0.05)
    memory = MemorySummary(
        total_mb=total_mb,
        used_mb=used_mb,
        free_mb=free_mb,
        shared_mb=shared_mb,
        buff_cache_mb=buff_cache_mb,
        available_mb=available_mb,
        swap_total_mb=swap_total,
        swap_used_mb=swap_used,
        swap_free_mb=swap_total - swap_used,
    )

    root_pct = _clamp(
        cfg["disk_base"] + 0.12 * day_index + 0.8 * math.sin(day_index / 11.0 + phase),
        1.0,
        99.0,
    )
    data_pct = _clamp(
        cfg["disk_base"]
        + 12.0
        + 0.18 * day_index
        + 0.8 * math.sin(day_index / 13.0 + phase),
        1.0,
        99.0,
    )
    disk_usage = [
        DiskUsageRow(
            filesystem="/dev/sda1",
            size="500G",
            used=f"{int(root_pct * 5)}G",
            available=f"{int((100 - root_pct) * 5)}G",
            percent=f"{int(root_pct)}%",
            mountpoint="/",
        ),
        DiskUsageRow(
            filesystem="/dev/sdb1",
            size="4000G",
            used=f"{int(data_pct * 40)}G",
            available=f"{int((100 - data_pct) * 40)}G",
            percent=f"{int(data_pct)}%",
            mountpoint="/data",
        ),
    ]

    cores = int(cfg["cores"])
    load_1 = round(cores * cpu / 100.0 * 0.9, 2)
    load = LoadAverage(
        load_1=load_1,
        load_5=round(load_1 * 0.85, 2),
        load_15=round(load_1 * 0.7, 2),
    )

    gpus = _gpu_rows(cfg, day_index)
    hottest = max(
        [zone.celsius for zone in [ThermalZone(label="cpu", celsius=round(40.0 + cpu * 0.25, 1))]]
        + [float(g.temperature_c) for g in gpus if g.temperature_c is not None]
    )

    return HostMetrics(
        hostname=cfg["host"],
        os_pretty_name=cfg["os"],
        kernel_version=cfg["kernel"],
        uptime=f"{120 + day_index} days, 4:32",
        collected_at=ts(days_ago=(TOTAL_DAYS - 1) - day_index),
        load_average=load,
        cpu_core_count=cores,
        cpu_usage_percent=round(cpu, 1),
        memory=memory,
        disk_usage=disk_usage,
        logged_in_users=[],
        total_processes=180 + int(cfg["cores"]) + (day_index % 7),
        process_counts_by_user=[],
        top_cpu_processes=[],
        top_memory_processes=[],
        gpu_summary=gpus,
        gpu_processes=[],
        net_rx_bytes=int(2_000_000_000 + day_index * 15_000_000),
        net_tx_bytes=int(900_000_000 + day_index * 7_000_000),
        containers=[],
        thermal_zones=[ThermalZone(label="cpu", celsius=round(40.0 + cpu * 0.25, 1))],
    )


def build_report(cfg: dict, day_index: int) -> HostReport:
    return HostReport(
        host_name=cfg["host_name"],
        host=cfg["host"],
        success=True,
        metrics=build_metrics(cfg, day_index),
    )


# ---------------------------------------------------------------------------
# Settings payloads
# ---------------------------------------------------------------------------
ALERTS_DEFAULTS = {
    "enabled": True,
    "desktop_notification": True,
    "email": True,
    "webhook": {
        "enabled": False,
        "type": "wecom",
        "url_env": "ALERT_WEBHOOK_URL",
    },
    "thresholds": {
        "cpu_percent": 90,
        "memory_percent": 90,
        "disk_percent": 90,
        "gpu_memory_percent": 90,
        "disk_temperature_c": 55,
    },
    "cooldown_minutes": 60,
    "repeat_while_active": False,
    "offline_failures": 2,
    "aggregate_by_host": True,
    "notify_on_recovery": True,
    "consecutive_periods": 2,
}


# ---------------------------------------------------------------------------
# Seed writers
# ---------------------------------------------------------------------------
def write_settings() -> None:
    save_app_settings("monitoring", {"timezone": "Asia/Shanghai"}, DB_PATH)
    save_app_settings("alerts", ALERTS_DEFAULTS, DB_PATH)


def write_metrics_history() -> None:
    """One :class:`DailyReport` per day (all hosts) for 90 days."""
    for day_index in range(TOTAL_DAYS):
        reports = [build_report(cfg, day_index) for cfg in HOSTS]
        persist_host_reports(
            DailyReport(
                generated_at=ts(days_ago=(TOTAL_DAYS - 1) - day_index),
                reports=reports,
                subject_prefix="[Server Daily Report]",
            ),
            DB_PATH,
        )


def write_latest_snapshots() -> None:
    for cfg in HOSTS:
        save_host_snapshot(build_report(cfg, TOTAL_DAYS - 1), DB_PATH)


def write_alerts() -> None:
    # active / system
    insert_alert(
        AlertEvent(
            host_name="lab-01",
            category="system",
            severity="critical",
            title="CPU 使用率持续过高",
            message="lab-01 CPU 使用率连续 3 个周期超过 90%",
            fingerprint="lab-01:system:cpu_high",
        ),
        DB_PATH,
        created_at=ts(days_ago=2, hour=9, microsecond=111111),
    )

    # acknowledged / disk
    acknowledged_id = insert_alert(
        AlertEvent(
            host_name="lab-02",
            category="disk",
            severity="warning",
            title="磁盘容量接近阈值",
            message="/data 挂载点使用率已达 88%",
            fingerprint="lab-02:disk:capacity",
        ),
        DB_PATH,
        created_at=ts(days_ago=5, hour=14, microsecond=222222),
    )
    update_alert(
        acknowledged_id,
        DB_PATH,
        status="acknowledged",
        notified_channels="desktop,email",
        ack_at=iso(ts(days_ago=4, hour=10, microsecond=333333)),
    )

    # resolved / system
    resolved_id = insert_alert(
        AlertEvent(
            host_name="gpu-01",
            category="system",
            severity="warning",
            title="系统负载偏高",
            message="gpu-01 15 分钟平均负载曾超过 48",
            fingerprint="gpu-01:system:load_high",
        ),
        DB_PATH,
        created_at=ts(days_ago=10, hour=20, microsecond=444444),
    )
    update_alert(
        resolved_id,
        DB_PATH,
        status="resolved",
        notified_channels="desktop",
        ack_at=iso(ts(days_ago=9, hour=8, microsecond=555555)),
    )

    # active / disk
    insert_alert(
        AlertEvent(
            host_name="gpu-01",
            category="disk",
            severity="warning",
            title="磁盘温度偏高",
            message="磁盘槽位 1 温度 54°C，接近告警阈值",
            fingerprint="gpu-01:disk:temperature",
        ),
        DB_PATH,
        created_at=ts(days_ago=1, hour=8, microsecond=555555),
    )


def write_silence() -> None:
    insert_silence(
        "host",
        "lab-02",
        "计划维护：RAID 扩容窗口",
        ts(days_ago=1, hour=8, microsecond=666666),
        ts(days_ago=-29, hour=8, microsecond=666666),
        "admin",
        DB_PATH,
    )


def write_disk_health() -> None:
    report = DiskHealthReport(
        host_name="gpu-01",
        collected_at=ts(days_ago=0, hour=6, microsecond=777777),
        status="ok",
        message="storcli 检查通过",
        controllers=[
            DiskControllerInfo(
                controller=0,
                model="LSI MegaRAID 9460-16i",
                firmware="4.650.00-8500",
                bbu_state="Optimal",
                health="ok",
                reasons=[],
            )
        ],
        virtual_drives=[
            VirtualDriveInfo(
                controller=0,
                vd_id=0,
                raid_level="RAID6",
                state="Optimal",
                size="21.825 TB",
                health="ok",
                reasons=[],
            )
        ],
        physical_drives=[
            PhysicalDriveInfo(
                controller=0,
                enclosure=32,
                slot=0,
                did=0,
                model="HGST HUH721010ALE600",
                serial="7HG0ABCD",
                state="Online",
                media_errors=0,
                other_errors=0,
                predictive_failures=0,
                smart_alert=False,
                temperature_c=36,
                shield_counter=0,
                health="ok",
                reasons=[],
            ),
            PhysicalDriveInfo(
                controller=0,
                enclosure=32,
                slot=1,
                did=1,
                model="HGST HUH721010ALE600",
                serial="7HG0EFGH",
                state="Online",
                media_errors=0,
                other_errors=0,
                predictive_failures=0,
                smart_alert=False,
                temperature_c=37,
                shield_counter=0,
                health="ok",
                reasons=[],
            ),
        ],
    )
    save_disk_health(report, DB_PATH)


def write_users() -> None:
    scan_moment = ts(days_ago=0, hour=7, microsecond=888888)
    account = {
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
        "home_mode": "0700",
        "home_size_bytes": 12_345_678,
        "data_exists": True,
        "data_owner": "alice",
        "data_group": "alice",
        "data_mode": "0750",
        "data_size_bytes": 98_765_432,
        "data_supported": True,
        "usage_readable": True,
        "usage_stale": False,
        "usage_collected_at": scan_moment,
        "collected_at": scan_moment,
    }
    save_host_user_scan_result(
        "lab-01",
        [account],
        DB_PATH,
        now=scan_moment,
        usage_refreshed=True,
    )


def finalize() -> dict[str, int]:
    """Pin the helper-stamped timestamps and stamp ``user_version = 1``."""
    conn = sqlite3.connect(str(DB_PATH))
    try:
        conn.execute("UPDATE app_settings SET updated_at = ?", (iso(EPOCH),))
        for (day,) in conn.execute("SELECT DISTINCT day FROM host_daily_summary"):
            conn.execute(
                "UPDATE host_daily_summary SET updated_at = ? WHERE day = ?",
                (f"{day}T12:00:00.123456+00:00", day),
            )
        conn.execute(
            "UPDATE alert_silences SET created_at = ?",
            (iso(ts(days_ago=2, hour=8, microsecond=666666)),),
        )
        conn.execute("PRAGMA user_version = 1")
        conn.commit()
        # Rebuild the file from its logical content.  Setting auto_vacuum to
        # INCREMENTAL *before* VACUUM restores the same `auto_vacuum=2` header
        # the storage layer uses; the rebuild itself normalises page /
        # free-space layout so two consecutive runs are byte-identical.
        conn.execute("PRAGMA auto_vacuum = INCREMENTAL")
        conn.execute("VACUUM")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

        def count(table: str) -> int:
            return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])

        stats = {
            "hosts": count("host_latest_snapshot"),
            "metrics": count("host_metrics_history"),
            "metrics_days": int(
                conn.execute(
                    "SELECT COUNT(DISTINCT substr(collected_at, 1, 10))"
                    " FROM host_metrics_history"
                ).fetchone()[0]
            ),
            "alerts": count("alerts"),
            "silences": count("alert_silences"),
            "disk_health": count("disk_health_snapshot"),
            "user_snapshot": count("host_user_snapshot"),
            "user_baseline": count("host_user_baseline"),
            "settings": count("app_settings"),
            "user_version": int(
                conn.execute("PRAGMA user_version").fetchone()[0]
            ),
        }
    finally:
        conn.close()
    return stats


def main() -> int:
    for suffix in ("", "-wal", "-shm"):
        Path(str(DB_PATH) + suffix).unlink(missing_ok=True)
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    init_storage(DB_PATH)

    write_settings()
    write_metrics_history()
    write_latest_snapshots()
    write_alerts()
    write_silence()
    write_disk_health()
    write_users()

    stats = finalize()

    # A TRUNCATE checkpoint leaves an empty -wal behind.  The storage helpers'
    # short-lived connections are released by refcounting; force a collection
    # and then drop the empty sidecars so the committed fixture is a single
    # ``.db`` file.  If a transient handle still holds them, ignore it -- the
    # interpreter closing at exit releases the lock and SQLite removes them.
    gc.collect()
    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(DB_PATH) + suffix)
        try:
            if sidecar.exists() and sidecar.stat().st_size == 0:
                sidecar.unlink(missing_ok=True)
        except PermissionError:
            pass

    size = DB_PATH.stat().st_size
    print(f"Seed database written to: {DB_PATH}")
    print(f"  size                : {size} bytes ({size / 1024 / 1024:.2f} MiB)")
    for key, value in stats.items():
        print(f"  {key:<19}: {value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
