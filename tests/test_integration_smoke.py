"""End-to-end integration smoke test for the PC polling monitor (Task 14).

This test wires the *real* application stack together with only the two
network-bound boundaries faked:

* ``collect_status`` is injected to return four successful :class:`HostReport`
  objects (one per configured host) instead of opening SSH connections.
* ``collect_disk`` is a thin wrapper that builds a per-host :class:`FakeRunner`
  over the Task 3 storcli fixtures and then calls the **real**
  :func:`servermanage.disk_health.collect_disk_health`.

Everything else is production code: :class:`MonitorService.run_once`, real
SQLite storage, the real :class:`AlertEngine` (with a recording notifier), the
real Flask dashboard via :func:`servermanage.web.create_app`, and the real
:func:`servermanage.storage.purge_old_data`.

The fixture physical-drive counts are a100=6, v100=2, 4090=8 (c0=6 + c1=2),
h100=5, totalling 21 drives across 4 hosts.  No real SSH, SMTP or network access
is performed and the database lives under ``tmp_path``.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from servermanage.app import MonitorService
from servermanage.disk_health import collect_disk_health
from servermanage.models import (
    AppConfig,
    AppRuntimeConfig,
    AuthConfig,
    CommandResult,
    DashboardAuthConfig,
    DashboardConfig,
    DiskUsageRow,
    GPUSummaryRow,
    HostConfig,
    HostMetrics,
    HostReport,
    MemorySummary,
    ReportConfig,
    SSHRuntimeConfig,
    StorageConfig,
)
from servermanage.storage import (
    get_all_disk_health,
    get_all_host_snapshots,
    get_disk_health,
    get_host_snapshot,
    purge_old_data,
)
from servermanage.web import create_app

FIX = Path(__file__).parent / "fixtures" / "storcli"

# host name -> list of controller ids storcli reports for that host
HOST_CONTROLLERS: dict[str, list[int]] = {
    "a100": [0],
    "v100": [0],
    "4090": [0, 1],
    "h100": [0],
}

# host name -> number of physical drives carried by its fixtures
EXPECTED_PD_COUNTS: dict[str, int] = {
    "a100": 6,
    "v100": 2,
    "4090": 8,
    "h100": 5,
}
EXPECTED_TOTAL_DRIVES = 21


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


def _result(stdout: str = "", stderr: str = "", code: int = 0) -> CommandResult:
    return CommandResult(stdout=stdout, stderr=stderr, exit_status=code)


class FakeRunner:
    """Canned command results matched by substring, in insertion order.

    Mirrors the runner used by ``tests/test_disk_health.py`` so the real
    ``collect_disk_health`` can be exercised without SSH.
    """

    def __init__(self, responses: list[tuple[str, object]]):
        self._responses = responses
        self.commands: list[str] = []
        self.timeouts: list[int] = []

    def run(self, command: str, timeout: int) -> CommandResult:
        self.commands.append(command)
        self.timeouts.append(timeout)
        for needle, result in self._responses:
            if needle in command:
                if isinstance(result, Exception):
                    raise result
                return result
        return _result(stderr=f"unexpected command: {command}", code=1)


class FakeNotifier:
    """Records dispatched alert events instead of touching OS/SMTP/webhook."""

    def __init__(self) -> None:
        self.events = []

    def dispatch(self, event, config):
        self.events.append(event)
        return ["fake"]


# ---------------------------------------------------------------------------
# Fixtures / helper builders
# ---------------------------------------------------------------------------


def _fixture(name: str) -> str:
    return (FIX / name).read_text(encoding="utf-8")


def _responses_for(host_name: str) -> list[tuple[str, object]]:
    """Build the ordered FakeRunner responses for one host's storcli session."""
    responses: list[tuple[str, object]] = [
        # First candidate probe succeeds (``sudo -n storcli -v``).
        ("storcli -v", _result()),
        ("/cALL show J", _result(stdout=_fixture(f"{host_name}_cALL_show_J.json"))),
    ]
    for cid in HOST_CONTROLLERS[host_name]:
        responses.append(
            (
                f"/c{cid}/vall show J",
                _result(stdout=_fixture(f"{host_name}__c{cid}_vall_show_J.json")),
            )
        )
        responses.append(
            (
                f"/c{cid}/eall/sall show all J",
                _result(
                    stdout=_fixture(
                        f"{host_name}__c{cid}_eall_sall_show_all_J.json"
                    )
                ),
            )
        )
    return responses


def _make_config(db_path: Path) -> AppConfig:
    servers = [
        HostConfig(
            name=name,
            host=f"10.0.0.{idx + 1}",
            port=22,
            username="monitor",
            auth=AuthConfig(type="password", password="secret"),
        )
        for idx, name in enumerate(EXPECTED_PD_COUNTS)
    ]
    return AppConfig(
        smtp=None,
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        report=ReportConfig(subject_prefix="[IT Smoke]"),
        servers=servers,
        storage=StorageConfig(enabled=True, db_path=db_path),
        app=AppRuntimeConfig(
            poll_interval_seconds=600,
            disk_poll_interval_seconds=86400,
            retention_days=90,
            timezone="Asia/Shanghai",
        ),
        dashboard=DashboardConfig(
            host="127.0.0.1",
            port=8080,
            auth=DashboardAuthConfig(
                enabled=True,
                username="admin",
                password_env=None,
                password="pw",
            ),
            session_secret="integration-smoke-secret",
        ),
    )


def _success_report(name: str, idx: int) -> HostReport:
    now = datetime.now(timezone.utc)
    return HostReport(
        host_name=name,
        host=f"10.0.0.{idx + 1}",
        success=True,
        metrics=HostMetrics(
            hostname=name,
            os_pretty_name="Ubuntu 22.04",
            collected_at=now,
            cpu_core_count=64,
            cpu_usage_percent=12.5 + idx,
            memory=MemorySummary(
                total_mb=131072,
                used_mb=32768,
                free_mb=98304,
                shared_mb=512,
                buff_cache_mb=4096,
                available_mb=98304,
                swap_total_mb=8192,
                swap_used_mb=0,
                swap_free_mb=8192,
            ),
            disk_usage=[
                DiskUsageRow(
                    filesystem="/dev/sda1",
                    size="1000G",
                    used="450G",
                    available="550G",
                    percent="45%",
                    mountpoint="/",
                )
            ],
            gpu_summary=[
                GPUSummaryRow(
                    index=0,
                    name="NVIDIA A100",
                    utilization_percent=30,
                    temperature_c=45,
                    memory_used_mb=20480,
                    memory_total_mb=81920,
                )
            ],
        ),
    )


def _fake_collect_disk(host, runner, **kwargs):
    """Wrap the real collector with a per-host fixture-backed FakeRunner.

    The ``runner`` argument passed by ``run_disk_once`` (a lazy
    ``SSHClientWrapper`` that never connects in tests) is intentionally ignored.
    """
    fake_runner = FakeRunner(_responses_for(host.name))
    return collect_disk_health(host, fake_runner, **kwargs)


def _count_rows(db_path: Path, table: str) -> int:
    with sqlite3.connect(db_path) as conn:
        return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


def _pd_counts_by_host(db_path: Path) -> dict[str, int]:
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(
            "SELECT host_name, COUNT(*) FROM disk_pd_snapshot GROUP BY host_name"
        ).fetchall()
    return {name: int(count) for name, count in rows}


# ---------------------------------------------------------------------------
# The end-to-end smoke test
# ---------------------------------------------------------------------------


def test_full_cycle_with_mock_ssh(tmp_path: Path):
    db_path = tmp_path / "integration.db"
    config = _make_config(db_path)
    notifier = FakeNotifier()

    reports = [_success_report(name, idx) for idx, name in enumerate(EXPECTED_PD_COUNTS)]
    service = MonitorService(
        config,
        db_path=db_path,
        collect_status=lambda cfg: list(reports),
        collect_disk=_fake_collect_disk,
        notifier=notifier,
    )

    # --- run one full status + disk cycle ---------------------------------
    result = service.run_once()

    assert result["hosts"] == 4
    assert result["disk_reports"] == 4

    # --- host snapshots ----------------------------------------------------
    snapshots = get_all_host_snapshots(db_path)
    assert len(snapshots) == 4
    assert {item["host_name"] for item in snapshots} == set(EXPECTED_PD_COUNTS)
    for name in EXPECTED_PD_COUNTS:
        record = get_host_snapshot(name, db_path)
        assert record is not None
        assert record["success"] is True
        assert record["metrics"]["cpu_usage_percent"] is not None

    # host_metrics_history gets one row per successful host this cycle
    assert _count_rows(db_path, "host_metrics_history") == 4

    # --- disk health: 4 batches, all status "ok" --------------------------
    disk_reports = get_all_disk_health(db_path)
    assert len(disk_reports) == 4
    for name in EXPECTED_PD_COUNTS:
        health = get_disk_health(name, db_path)
        assert health is not None
        assert health["status"] == "ok", health["message"]

    # --- physical drive snapshot rows: 21 total, per-host 6/2/8/5 --------
    pd_counts = _pd_counts_by_host(db_path)
    assert pd_counts == EXPECTED_PD_COUNTS
    assert _count_rows(db_path, "disk_pd_snapshot") == EXPECTED_TOTAL_DRIVES == 21

    # --- dashboard API -----------------------------------------------------
    app = create_app(config=config, db_path=db_path)
    app.config.update(TESTING=True)
    client = app.test_client()

    # unauthenticated call must be rejected
    assert client.get("/api/overview").status_code == 401

    login = client.post("/login", data={"username": "admin", "password": "pw"})
    assert login.status_code == 302

    overview = client.get("/api/overview")
    assert overview.status_code == 200
    payload = overview.get_json()
    assert len(payload["hosts"]) == 4
    assert {row["name"] for row in payload["hosts"]} == set(EXPECTED_PD_COUNTS)
    assert payload["summary"]["online"] == 4

    # per-host disk detail is readable and carries the fixture drives
    detail = client.get("/api/host/a100")
    assert detail.status_code == 200
    body = detail.get_json()
    assert body["disk"] is not None
    assert body["disk"]["status"] == "ok"
    assert len(body["disk"]["physical_drives"]) == 6

    # --- retention purge must not touch today's data ----------------------
    tables = (
        "host_metrics_history",
        "disk_health_snapshot",
        "disk_controller_snapshot",
        "disk_vd_snapshot",
        "disk_pd_snapshot",
    )
    before = {table: _count_rows(db_path, table) for table in tables}

    counts = purge_old_data(db_path, retention_days=90)

    # Nothing today is older than 90 days, so every table deletes zero rows.
    assert counts["alerts"] == 0
    for table in tables:
        assert counts[table] == 0
        assert _count_rows(db_path, table) == before[table]

    # Today's data is still fully queryable after the purge.
    assert len(get_all_host_snapshots(db_path)) == 4
    assert len(get_all_disk_health(db_path)) == 4
    assert _count_rows(db_path, "disk_pd_snapshot") == EXPECTED_TOTAL_DRIVES
