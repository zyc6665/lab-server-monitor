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

import re
import socket
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from servermanage import alerts as alerts_module
from servermanage import runtime
from servermanage.alerts import AlertEngine, Notifier, SilenceRegistry
from servermanage.app import MonitorService
from servermanage.disk_health import AlertEvent
from servermanage.models import AlertsConfig, SMTPConfig, WebhookConfig
from servermanage.storage import list_alerts
from servermanage.config import load_config_from_mapping
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
from servermanage.settings import SettingsService
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


def test_web_settings_end_to_end(tmp_path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text("servers: []\n", encoding="utf-8")
    base = load_config_from_mapping({}, allow_empty_servers=True)
    settings = SettingsService(
        config_path=config_path,
        db_path=tmp_path / "m.db",
        base_config=base,
    )
    app = create_app(
        config=settings.load(),
        db_path=tmp_path / "m.db",
        settings_service=settings,
        on_config_changed=lambda cfg: None,
    )
    client = app.test_client()

    page = client.get("/setup").get_data(as_text=True)
    token = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
    assert client.post(
        "/setup",
        data={
            "username": "admin",
            "password": "AdminPass!23",
            "confirm": "AdminPass!23",
            "csrf_token": token,
        },
    ).status_code == 302
    assert client.post(
        "/login",
        data={"username": "admin", "password": "AdminPass!23"},
    ).status_code == 302

    # A rendered page seeds the session CSRF token used by subsequent writes.
    client.get("/settings")
    with client.session_transaction() as sess:
        token = sess["csrf_token"]
    headers = {"X-CSRF-Token": token}

    assert client.put(
        "/api/settings/hosts/a100",
        headers=headers,
        json={
            "host": "202.119.189.245",
            "username": "zhouyc",
            "auth_type": "password",
            "password": "topsecret-pw",
            "disk_mounts": ["/", "/data"],
        },
    ).status_code == 200
    assert client.put(
        "/api/settings/report", headers=headers, json={"daily_enabled": False}
    ).status_code == 200
    assert client.put(
        "/api/settings/monitoring",
        headers=headers,
        json={"poll_interval_seconds": 300},
    ).status_code == 200

    saved = settings.load()
    assert saved.servers[0].name == "a100"
    assert saved.servers[0].disk_mounts == ["/", "/data"]
    assert saved.servers[0].auth.type == "password"
    assert saved.report.daily_enabled is False
    assert saved.app.poll_interval_seconds == 300

    # The settings page exposes the six editable sections.
    page = client.get("/settings").get_data(as_text=True)
    assert page.count("data-section=") >= 6

    # Overview still exposes the live dashboard fields after the settings save.
    overview = client.get("/api/overview").get_json()
    assert overview is not None
    assert "logged_in_user_count" in overview["hosts"][0]


# ===========================================================================
# Task 13: v1.2 end-to-end integration (setup/import, silence, aggregation,
# recovery and runtime).  These tests only use temp databases/directories and
# never open a real SSH, SMTP or webhook connection.
# ===========================================================================

ADMIN_PASSWORD = "Integration-Admin-Pass-2026"

YAML_TWO_HOSTS = """hosts:
  - name: lab-a
    host: 10.10.0.11
    port: 22
    username: ubuntu
    auth_type: key
    key_path: /home/ubuntu/.ssh/id_rsa
    group: 实验室
    owner: 张三
    location: A栋
  - name: lab-b
    host: 10.10.0.12
    username: ubuntu
    auth_type: key
    key_path: /home/ubuntu/.ssh/id_rsa
    group: 机房
"""

CSV_ONE_HOST = (
    "name,host,port,username,auth_type,key_path,group,owner\n"
    "lab-c,10.10.0.13,22,ubuntu,key,/home/ubuntu/.ssh/id_rsa,机房,李四\n"
)


def _settings_app(tmp_path: Path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db_path = tmp_path / "settings.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    service = SettingsService(config_path=cfg_path, db_path=db_path, base_config=base)
    changed: list[AppConfig] = []
    app = create_app(
        config=service.load(),
        db_path=db_path,
        settings_service=service,
        on_config_changed=changed.append,
    )
    return app, service, db_path, changed


def _setup_and_login(client) -> str:
    """Run first-run /setup, log in and return the session CSRF token."""
    page = client.get("/setup").get_data(as_text=True)
    token = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
    setup = client.post(
        "/setup",
        data={
            "username": "admin",
            "password": ADMIN_PASSWORD,
            "confirm": ADMIN_PASSWORD,
            "csrf_token": token,
        },
    )
    assert setup.status_code == 302
    login = client.post(
        "/login", data={"username": "admin", "password": ADMIN_PASSWORD}
    )
    assert login.status_code == 302
    client.get("/settings")
    with client.session_transaction() as sess:
        return sess["csrf_token"]


def test_setup_login_import_preview_confirm_then_settings(tmp_path: Path):
    """Scenario 1: /setup → login → import previews/confirms YAML+CSV → settings."""
    app, service, _db, changed = _settings_app(tmp_path)
    client = app.test_client()
    headers = {"X-CSRF-Token": _setup_and_login(client)}

    # Preview parses both hosts but must not write anything.
    preview = client.post(
        "/api/settings/hosts/import/preview",
        headers=headers,
        json={"format": "yaml", "content": YAML_TWO_HOSTS},
    )
    assert preview.status_code == 200
    assert [c["name"] for c in preview.get_json()["candidates"]] == ["lab-a", "lab-b"]
    assert service.load().servers == []

    # Confirming the same YAML creates both hosts.
    imported = client.post(
        "/api/settings/hosts/import",
        headers=headers,
        json={"format": "yaml", "content": YAML_TWO_HOSTS},
    )
    assert imported.status_code == 200
    assert sorted(imported.get_json()["created"]) == ["lab-a", "lab-b"]

    # A second import path uses CSV text.
    csv_preview = client.post(
        "/api/settings/hosts/import/preview",
        headers=headers,
        json={"format": "csv", "content": CSV_ONE_HOST},
    )
    assert csv_preview.status_code == 200
    assert [c["name"] for c in csv_preview.get_json()["candidates"]] == ["lab-c"]
    csv_import = client.post(
        "/api/settings/hosts/import",
        headers=headers,
        json={"format": "csv", "content": CSV_ONE_HOST},
    )
    assert csv_import.get_json()["created"] == ["lab-c"]

    # /api/settings exposes the imported hosts together with their groups.
    settings = client.get("/api/settings").get_json()
    by_name = {host["name"]: host for host in settings["hosts"]}
    assert set(by_name) == {"lab-a", "lab-b", "lab-c"}
    assert by_name["lab-a"]["group"] == "实验室"
    assert by_name["lab-b"]["group"] == "机房"
    assert by_name["lab-c"]["group"] == "机房"
    assert by_name["lab-a"]["owner"] == "张三"
    assert {"实验室", "机房"} <= {host["group"] for host in settings["hosts"]}

    # The running monitor config was refreshed with the same inventory.
    assert {server.name for server in service.load().servers} == {
        "lab-a",
        "lab-b",
        "lab-c",
    }
    assert changed, "import must trigger an on_config_changed refresh"


def test_global_silence_suppresses_then_delete_realerts(tmp_path: Path):
    """Scenario 2: a global silence mutes the engine; deleting it re-alerts."""
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db_path = tmp_path / "silence.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    service = SettingsService(config_path=cfg_path, db_path=db_path, base_config=base)
    service.load()  # initialise the SQLite schema

    now = datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc)
    silence_id = service.add_silence(
        "all",
        None,
        "计划维护",
        now - timedelta(hours=1),
        now + timedelta(hours=1),
        created_by="admin",
    )

    class RecordingNotifier:
        def __init__(self) -> None:
            self.events: list[AlertEvent] = []

        def dispatch(self, event: AlertEvent, config: AlertsConfig) -> list[str]:
            self.events.append(event)
            return ["desktop"]

        def dispatch_batch(
            self, events: list[AlertEvent], config: AlertsConfig
        ) -> list[str]:
            self.events.extend(events)
            return ["desktop"]

    notifier = RecordingNotifier()
    engine = AlertEngine(
        db_path,
        AlertsConfig(enabled=True, aggregate_by_host=False),
        notifier,
        clock=lambda: now,
        silence_checker=SilenceRegistry(db_path, clock=lambda: now),
    )
    event = AlertEvent(
        host_name="gpu-01",
        category="system",
        severity="warning",
        title="CPU 使用率过高",
        message="CPU 使用率 95% 超过阈值",
        fingerprint="system:gpu-01:cpu",
    )

    # While the global silence is active: no DB row, no notification.
    assert engine.process([event]) == []
    assert list_alerts(db_path) == []
    assert notifier.events == []

    # Deleting the silence lets the next identical cycle alert again.
    assert service.delete_silence(silence_id) is True
    assert engine.process([event]) == [event]
    rows = list_alerts(db_path)
    assert [row["fingerprint"] for row in rows] == ["system:gpu-01:cpu"]
    assert len(notifier.events) == 1


def test_three_system_events_one_batch_all_channels_and_single_recovery(
    tmp_path: Path, monkeypatch
):
    """Scenario 3: same-host batch fan-out + exactly one recovery notification."""
    db_path = tmp_path / "batch.db"
    calls: dict[str, list] = {"desktop": [], "email": [], "webhook": []}

    def fake_desktop(title: str, message: str) -> bool:
        calls["desktop"].append((title, message))
        return True

    def fake_email(smtp, report) -> bool:
        calls["email"].append(report)
        return True

    def fake_webhook(webhook, event, **kwargs) -> bool:
        calls["webhook"].append(event)
        return True

    monkeypatch.setattr(alerts_module, "send_desktop_notification", fake_desktop)
    monkeypatch.setattr(alerts_module, "send_report", fake_email)
    monkeypatch.setattr(alerts_module, "send_webhook", fake_webhook)

    smtp = SMTPConfig(
        host="smtp.example.com",
        port=25,
        username="u",
        password="p",
        use_ssl=False,
        from_addr="alerts@example.com",
        to_addrs=["ops@example.com"],
    )
    config = AlertsConfig(
        enabled=True,
        desktop_notification=True,
        email=True,
        webhook=WebhookConfig(
            enabled=True, type="wecom", url="https://example.invalid/hook", url_env=None
        ),
        aggregate_by_host=True,
        notify_on_recovery=True,
        cooldown_minutes=60,
    )
    notifier = Notifier(smtp=smtp)
    engine = AlertEngine(
        db_path,
        config,
        notifier,
        clock=lambda: datetime(2026, 11, 6, 2, 0, tzinfo=timezone.utc),
    )

    events = [
        AlertEvent("gpu-01", "system", "warning", "CPU 使用率过高", "cpu 95%", "system:gpu-01:cpu"),
        AlertEvent("gpu-01", "system", "critical", "内存不足", "mem 98%", "system:gpu-01:memory"),
        AlertEvent("gpu-01", "system", "warning", "负载过高", "load 40", "system:gpu-01:load"),
    ]
    assert engine.process(events) == events

    # One merged batch per channel, even though three alerts fired.
    assert len(calls["desktop"]) == 1
    assert len(calls["email"]) == 1
    assert len(calls["webhook"]) == 1
    assert "3 项告警" in calls["desktop"][0][0]

    rows = list_alerts(db_path)
    assert len(rows) == 3
    assert all(row["notified_channels"] == "desktop,email,webhook" for row in rows)

    # Recovery: only one event, dispatched once per channel.
    for bucket in calls.values():
        bucket.clear()
    recovery = engine.resolve_missing("gpu-01", set(), category="system")
    assert len(recovery) == 1
    assert recovery[0].fingerprint == "recovery:gpu-01:system"
    assert len(calls["desktop"]) == 1
    assert len(calls["email"]) == 1
    assert len(calls["webhook"]) == 1

    # A second sweep must not emit another recovery notice.
    assert engine.resolve_missing("gpu-01", set(), category="system") == []


def test_runtime_lock_port_fallback_and_state_file(tmp_path: Path):
    """Scenario 4: single-instance lock, port fallback and readable runtime.json."""
    lock_path = tmp_path / "runtime" / "servermonitor.lock"

    first = runtime.acquire_single_instance(lock_path)
    try:
        assert first.acquired is True
        assert lock_path.parent.is_dir()
        second = runtime.acquire_single_instance(lock_path)
        try:
            assert second.acquired is False
        finally:
            second.release()
    finally:
        first.release()

    holder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        holder.bind(("127.0.0.1", 0))
        holder.listen(1)
        occupied = holder.getsockname()[1]

        chosen = runtime.find_available_port("127.0.0.1", occupied, span=10)
        assert chosen != occupied
        assert occupied < chosen < occupied + 10
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", chosen))
    finally:
        holder.close()

    state_path = tmp_path / "runtime" / "runtime.json"
    runtime.write_runtime_state(
        state_path, url=f"http://127.0.0.1:{chosen}", port=chosen, pid=4321
    )
    assert runtime.read_runtime_state(state_path) == {
        "url": f"http://127.0.0.1:{chosen}",
        "port": chosen,
        "pid": 4321,
    }
