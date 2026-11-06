"""Unit tests for the alert rule functions in ``servermanage.alerts``.

OS-agnostic: no SSH, no network, no filesystem.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from servermanage.alerts import (
    evaluate_disk_alerts,
    evaluate_system_alerts,
    fingerprint_for,
    offline_alert,
    recovery_event,
)
from servermanage.disk_health import (
    DiskHealthReport,
    PhysicalDriveInfo,
    VirtualDriveInfo,
)
from servermanage.models import (
    AlertThresholds,
    GPUSummaryRow,
    HostMetrics,
    MemorySummary,
)

NOW = datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc)


def _memory(total_mb: int, used_mb: int) -> MemorySummary:
    return MemorySummary(
        total_mb=total_mb,
        used_mb=used_mb,
        free_mb=total_mb - used_mb,
        shared_mb=0,
        buff_cache_mb=0,
        available_mb=total_mb - used_mb,
        swap_total_mb=0,
        swap_used_mb=0,
        swap_free_mb=0,
    )


def _gpu(used_mb: int, total_mb: int) -> GPUSummaryRow:
    return GPUSummaryRow(
        index=0,
        name="A100",
        utilization_percent=0,
        temperature_c=None,
        memory_used_mb=used_mb,
        memory_total_mb=total_mb,
    )


# ---------------------------------------------------------------------------
# fingerprint_for
# ---------------------------------------------------------------------------

def test_fingerprint_for_is_colon_joined_and_lowercased():
    assert fingerprint_for("System", "GPU-01", "CPU") == "system:gpu-01:cpu"


# ---------------------------------------------------------------------------
# evaluate_system_alerts
# ---------------------------------------------------------------------------

def test_cpu_memory_gpu_thresholds():
    metrics = HostMetrics(
        cpu_usage_percent=95.0,
        memory=_memory(100, 90),  # 90% -> at threshold
        gpu_summary=[_gpu(95, 100)],  # 95%
    )
    thresholds = AlertThresholds(
        cpu_percent=90,
        memory_percent=90,
        disk_percent=90,
        gpu_memory_percent=90,
    )

    events = evaluate_system_alerts("gpu-01", metrics, thresholds)

    assert len(events) == 3
    assert all(event.severity == "warning" for event in events)
    assert all(event.category == "system" for event in events)
    fingerprints = [event.fingerprint for event in events]
    assert len(set(fingerprints)) == 3
    assert "system:gpu-01:cpu" in fingerprints
    assert "system:gpu-01:memory" in fingerprints
    assert "system:gpu-01:gpu_memory" in fingerprints
    titles = {event.title for event in events}
    assert {"CPU 使用率过高", "内存使用率过高", "GPU 显存占用过高"} <= titles


def test_disk_percent_supplied_separately():
    metrics = HostMetrics(cpu_usage_percent=10.0, memory=_memory(100, 10))
    thresholds = AlertThresholds()

    events = evaluate_system_alerts(
        "gpu-01", metrics, thresholds, disk_percent=95.0
    )

    assert len(events) == 1
    assert events[0].category == "system"
    assert events[0].severity == "warning"
    assert events[0].fingerprint == "system:gpu-01:disk"
    assert events[0].title == "磁盘使用率过高"


def test_below_threshold_produces_no_alert():
    metrics = HostMetrics(
        cpu_usage_percent=50.0,
        memory=_memory(100, 40),
        gpu_summary=[_gpu(30, 100)],
    )
    thresholds = AlertThresholds()

    assert evaluate_system_alerts("gpu-01", metrics, thresholds, disk_percent=20.0) == []


def test_missing_metrics_never_false_alerts():
    # No cpu, no memory, no gpu, no disk_percent -> nothing to evaluate.
    assert evaluate_system_alerts("gpu-01", HostMetrics(), AlertThresholds()) == []


def test_memory_with_zero_total_is_skipped():
    metrics = HostMetrics(memory=_memory(0, 0))
    assert evaluate_system_alerts("gpu-01", metrics, AlertThresholds()) == []


# ---------------------------------------------------------------------------
# evaluate_disk_alerts
# ---------------------------------------------------------------------------

def test_disk_alert_from_warning_drive():
    report = DiskHealthReport(
        host_name="gpu-01",
        collected_at=NOW,
        status="ok",
        physical_drives=[
            PhysicalDriveInfo(
                controller=0,
                enclosure=252,
                slot=3,
                state="Onln",
                model="ST4000NM0035",
                serial="Z1F00ABC",
                health="warning",
                reasons=["media_errors"],
            )
        ],
    )

    events = evaluate_disk_alerts(report)

    assert len(events) == 1
    event = events[0]
    assert event.category == "disk"
    assert event.severity == "warning"
    assert event.host_name == "gpu-01"
    assert "c0:e252:s3" in event.fingerprint
    assert event.fingerprint.startswith("disk:gpu-01:")
    assert "media_errors" in event.message


def test_no_alert_when_healthy():
    report = DiskHealthReport(
        host_name="gpu-01",
        collected_at=NOW,
        physical_drives=[
            PhysicalDriveInfo(
                controller=0, enclosure=252, slot=0, state="Onln", health="healthy"
            )
        ],
    )
    assert evaluate_disk_alerts(report) == []


def test_critical_drive_keeps_critical_severity():
    report = DiskHealthReport(
        host_name="gpu-01",
        collected_at=NOW,
        physical_drives=[
            PhysicalDriveInfo(
                controller=1,
                enclosure=252,
                slot=9,
                state="Failed",
                health="critical",
                reasons=["state_failed"],
            )
        ],
    )
    events = evaluate_disk_alerts(report)
    assert len(events) == 1
    assert events[0].severity == "critical"
    assert "c1:e252:s9" in events[0].fingerprint


def test_drive_without_slot_uses_did_in_fingerprint():
    report = DiskHealthReport(
        host_name="gpu-01",
        collected_at=NOW,
        physical_drives=[
            PhysicalDriveInfo(
                controller=0,
                did=7,
                health="warning",
                reasons=["smart_flag"],
            )
        ],
    )
    events = evaluate_disk_alerts(report)
    assert len(events) == 1
    assert "did7" in events[0].fingerprint


def test_multiple_drives_have_distinct_fingerprints():
    report = DiskHealthReport(
        host_name="gpu-01",
        collected_at=NOW,
        physical_drives=[
            PhysicalDriveInfo(
                controller=0, enclosure=252, slot=1, health="warning",
                reasons=["media_errors"],
            ),
            PhysicalDriveInfo(
                controller=0, enclosure=252, slot=2, health="critical",
                reasons=["state_failed"],
            ),
        ],
    )
    events = evaluate_disk_alerts(report)
    assert len(events) == 2
    assert len({event.fingerprint for event in events}) == 2


def test_virtual_drive_alert():
    report = DiskHealthReport(
        host_name="gpu-01",
        collected_at=NOW,
        virtual_drives=[
            VirtualDriveInfo(
                controller=0,
                vd_id=1,
                raid_level="RAID1",
                state="Degraded",
                health="warning",
                reasons=["state_degraded"],
            )
        ],
    )
    events = evaluate_disk_alerts(report)
    assert len(events) == 1
    assert events[0].category == "disk"
    assert events[0].severity == "warning"
    assert "vd1" in events[0].fingerprint


@pytest.mark.parametrize(
    "status",
    ["permission_denied", "no_storcli", "no_controller", "error", "degraded"],
)
def test_non_ok_report_status_emits_alert(status: str):
    report = DiskHealthReport(
        host_name="gpu-01",
        collected_at=NOW,
        status=status,
        message=f"无法检查磁盘健康：{status}",
    )
    events = evaluate_disk_alerts(report)
    assert len(events) == 1
    event = events[0]
    assert event.category == "disk"
    assert event.severity == "warning"
    assert status in event.fingerprint
    assert event.fingerprint.startswith("disk:gpu-01:")


def test_ok_status_with_healthy_drives_no_alert():
    report = DiskHealthReport(host_name="gpu-01", collected_at=NOW, status="ok")
    assert evaluate_disk_alerts(report) == []


# ---------------------------------------------------------------------------
# offline_alert / recovery_event
# ---------------------------------------------------------------------------

def test_offline_alert():
    event = offline_alert("gpu-01", failures=3)
    assert event.host_name == "gpu-01"
    assert event.category == "offline"
    assert event.severity == "critical"
    assert event.fingerprint == "offline:gpu-01"
    assert "3" in event.message


def test_recovery_event():
    event = recovery_event("gpu-01", "disk")
    assert event.host_name == "gpu-01"
    assert event.category == "disk"
    assert event.severity == "info"
    assert event.fingerprint == "recovery:gpu-01:disk"


# ---------------------------------------------------------------------------
# Stability
# ---------------------------------------------------------------------------

def test_fingerprints_stable_across_runs():
    metrics = HostMetrics(cpu_usage_percent=99.0)
    first = evaluate_system_alerts("gpu-01", metrics, AlertThresholds())
    second = evaluate_system_alerts("gpu-01", metrics, AlertThresholds())
    assert [e.fingerprint for e in first] == [e.fingerprint for e in second]
