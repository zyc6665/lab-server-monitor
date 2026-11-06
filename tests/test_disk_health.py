"""Tests for disk health evaluation and SSH-based storcli collection (Task 4).

All tests use an injected fake SSH runner; no network access is performed.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

from servermanage.disk_health import (
    DiskHealthReport,
    PhysicalDriveInfo,
    VirtualDriveInfo,
    collect_disk_health,
    evaluate_drive_health,
    evaluate_virtual_drive_health,
)
from servermanage.models import (
    AuthConfig,
    CommandResult,
    DiskHealthConfig,
    DiskHealthRuleConfig,
    HostConfig,
    HostDiskHealthOverride,
)

FIX = Path(__file__).parent / "fixtures" / "storcli"

RULES = DiskHealthRuleConfig()


def _result(stdout: str = "", stderr: str = "", code: int = 0) -> CommandResult:
    return CommandResult(stdout=stdout, stderr=stderr, exit_status=code)


class FakeRunner:
    """Return canned command results matched by substring, in insertion order."""

    def __init__(self, responses: list[tuple[str, CommandResult]]):
        self._responses = responses
        self.commands: list[str] = []
        self.timeouts: list[int] = []

    def run(self, command: str, timeout: int) -> CommandResult:
        self.commands.append(command)
        self.timeouts.append(timeout)
        for needle, result in self._responses:
            if needle in command:
                return result
        return _result(stderr=f"unexpected command: {command}", code=1)


def _host(name: str = "h100", disk_health: HostDiskHealthOverride | None = None) -> HostConfig:
    return HostConfig(
        name=name,
        host="10.0.0.10",
        port=22,
        username="zhouyc",
        auth=AuthConfig(type="password", password="x"),
        disk_health=disk_health,
    )


def _fixture(name: str) -> str:
    return (FIX / name).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# evaluate_drive_health
# ---------------------------------------------------------------------------

def test_evaluate_states():
    failed = evaluate_drive_health(
        PhysicalDriveInfo(controller=0, enclosure=252, slot=0, state="Failed"),
        rules=RULES,
    )
    assert failed.health == "critical"
    assert "state_failed" in failed.reasons

    rebuild = evaluate_drive_health(
        PhysicalDriveInfo(controller=0, enclosure=252, slot=1, state="Rebuild"),
        rules=RULES,
    )
    assert rebuild.health == "warning"
    assert "state_degraded" in rebuild.reasons

    healthy = evaluate_drive_health(
        PhysicalDriveInfo(controller=0, enclosure=252, slot=2, state="Onln"),
        rules=RULES,
    )
    assert healthy.health == "healthy"
    assert healthy.reasons == []


def test_evaluate_offline_missing_variants():
    for state in ("Offline", "Offln", "Missing"):
        result = evaluate_drive_health(
            PhysicalDriveInfo(controller=0, enclosure=252, slot=0, state=state),
            rules=RULES,
        )
        assert result.health == "critical", state
        assert "state_failed" in result.reasons, state


def test_evaluate_errors_and_smart():
    media = evaluate_drive_health(
        PhysicalDriveInfo(controller=0, state="Onln", media_errors=2), rules=RULES
    )
    assert media.health == "warning" and "media_errors" in media.reasons

    other = evaluate_drive_health(
        PhysicalDriveInfo(controller=0, state="Onln", other_errors=3), rules=RULES
    )
    assert other.health == "warning" and "other_errors" in other.reasons

    smart = evaluate_drive_health(
        PhysicalDriveInfo(controller=0, state="Onln", smart_alert=True), rules=RULES
    )
    assert smart.health == "warning" and "smart_flag" in smart.reasons

    predictive = evaluate_drive_health(
        PhysicalDriveInfo(controller=0, state="Onln", predictive_failures=1), rules=RULES
    )
    assert predictive.health == "warning" and "predictive_failure" in predictive.reasons


def test_evaluate_does_not_mutate_input():
    drive = PhysicalDriveInfo(controller=0, state="Failed", media_errors=1)
    result = evaluate_drive_health(drive, rules=RULES)
    assert drive.health == "unknown"
    assert result is not drive
    assert result.media_errors == 1


def test_error_increase():
    previous = PhysicalDriveInfo(
        controller=0, enclosure=252, slot=3, state="Onln", media_errors=0, other_errors=0
    )
    current = PhysicalDriveInfo(
        controller=0, enclosure=252, slot=3, state="Onln", media_errors=2, other_errors=0
    )
    result = evaluate_drive_health(current, rules=RULES, previous=previous)
    assert result.health == "warning"
    assert "error_increase" in result.reasons

    # No increase -> no error_increase reason.
    steady = evaluate_drive_health(
        PhysicalDriveInfo(controller=0, state="Onln", media_errors=2),
        rules=RULES,
        previous=PhysicalDriveInfo(controller=0, state="Onln", media_errors=2),
    )
    assert "error_increase" not in steady.reasons


def test_unknown_previous_values_do_not_count_as_zero():
    previous = PhysicalDriveInfo(controller=0, state="Onln", media_errors=None)
    current = PhysicalDriveInfo(controller=0, state="Onln", media_errors=2)
    result = evaluate_drive_health(current, rules=RULES, previous=previous)
    assert "error_increase" not in result.reasons
    # media > 0 still independently warns.
    assert "media_errors" in result.reasons


def test_temperature_threshold():
    hot = evaluate_drive_health(
        PhysicalDriveInfo(controller=0, state="Onln", temperature_c=56), rules=RULES
    )
    assert hot.health == "warning" and "temperature" in hot.reasons

    boundary = evaluate_drive_health(
        PhysicalDriveInfo(controller=0, state="Onln", temperature_c=55), rules=RULES
    )
    assert "temperature" not in boundary.reasons
    assert boundary.health == "healthy"

    # Threshold is configurable, not hard-coded.
    cool_for_custom = evaluate_drive_health(
        PhysicalDriveInfo(controller=0, state="Onln", temperature_c=56),
        rules=RULES,
        temperature_threshold_c=60.0,
    )
    assert "temperature" not in cool_for_custom.reasons


def test_missing_numeric_values_are_not_false_positives():
    result = evaluate_drive_health(
        PhysicalDriveInfo(controller=0, state="Onln"), rules=RULES
    )
    assert result.health == "healthy"
    assert result.reasons == []


def test_rule_flags_disable_checks():
    rules = DiskHealthRuleConfig(
        alert_on_media_errors=False,
        alert_on_other_errors=False,
        alert_on_predictive_failure=False,
        alert_on_smart_flag=False,
        alert_on_error_increase=False,
    )
    result = evaluate_drive_health(
        PhysicalDriveInfo(
            controller=0,
            state="Onln",
            media_errors=5,
            other_errors=5,
            predictive_failures=2,
            smart_alert=True,
        ),
        rules=rules,
    )
    assert result.health == "healthy"
    assert result.reasons == []


def test_state_rule_can_be_disabled():
    rules = DiskHealthRuleConfig(alert_on_state_not_optimal=False)
    result = evaluate_drive_health(
        PhysicalDriveInfo(controller=0, state="Failed"), rules=rules
    )
    assert result.health == "healthy"


# ---------------------------------------------------------------------------
# evaluate_virtual_drive_health
# ---------------------------------------------------------------------------

def test_evaluate_virtual_drive_health():
    optimal = evaluate_virtual_drive_health(
        VirtualDriveInfo(controller=0, vd_id=0, state="Optl")
    )
    assert optimal.health == "healthy"

    degraded = evaluate_virtual_drive_health(
        VirtualDriveInfo(controller=0, vd_id=1, state="Degraded")
    )
    assert degraded.health == "warning"
    assert "state_degraded" in degraded.reasons

    offline = evaluate_virtual_drive_health(
        VirtualDriveInfo(controller=0, vd_id=2, state="Offline")
    )
    assert offline.health == "critical"
    assert "state_failed" in offline.reasons


# ---------------------------------------------------------------------------
# collect_disk_health
# ---------------------------------------------------------------------------

def _multi_controller_runner() -> FakeRunner:
    return FakeRunner(
        [
            ("-v", _result("storcli ver 007.2705")),
            ("/cALL show J", _result(_fixture("4090_cALL_show_J.json"))),
            ("/c0/vall show J", _result(_fixture("4090__c0_vall_show_J.json"))),
            ("/c1/vall show J", _result(_fixture("4090__c1_vall_show_J.json"))),
            ("/c0/eall/sall show all J", _result(_fixture("4090__c0_eall_sall_show_all_J.json"))),
            ("/c1/eall/sall show all J", _result(_fixture("4090__c1_eall_sall_show_all_J.json"))),
        ]
    )


def test_collect_permission_denied():
    runner = FakeRunner(
        [("-v", _result(stderr="sudo: a password is required", code=1))]
    )
    report = collect_disk_health(
        _host(),
        runner,
        config=DiskHealthConfig(),
        command_timeout=30,
    )
    assert report.status == "permission_denied"
    assert report.physical_drives == []
    assert report.controllers == []
    assert "sudo" in (report.message or "").lower()


def test_collect_not_in_sudoers_is_permission_denied():
    runner = FakeRunner(
        [("-v", _result(stderr="zhouyc is not in the sudoers file", code=1))]
    )
    report = collect_disk_health(
        _host(), runner, config=DiskHealthConfig(), command_timeout=30
    )
    assert report.status == "permission_denied"


def test_collect_no_storcli():
    runner = FakeRunner(
        [("-v", _result(stderr="storcli: command not found", code=127))]
    )
    report = collect_disk_health(
        _host(), runner, config=DiskHealthConfig(), command_timeout=30
    )
    assert report.status == "no_storcli"
    assert report.physical_drives == []


def test_collect_no_controller():
    runner = FakeRunner(
        [
            ("-v", _result("storcli ver")),
            ("/cALL show J", _result('{"Controllers": []}')),
        ]
    )
    report = collect_disk_health(
        _host(), runner, config=DiskHealthConfig(), command_timeout=30
    )
    assert report.status == "no_controller"
    assert report.controllers == []
    assert report.physical_drives == []


def test_collect_ok_multi_controller():
    runner = _multi_controller_runner()
    now = datetime(2026, 11, 6, 3, 0, tzinfo=timezone.utc)
    report = collect_disk_health(
        _host(),
        runner,
        config=DiskHealthConfig(),
        command_timeout=45,
        now=now,
    )
    assert report.status == "ok"
    assert report.collected_at == now
    assert len(report.controllers) == 2
    assert len(report.virtual_drives) == 2
    assert len(report.physical_drives) == 8
    assert all(d.health == "healthy" for d in report.physical_drives)
    assert all(v.health == "healthy" for v in report.virtual_drives)
    # Every storcli invocation must be non-interactive root escalation.
    assert runner.commands
    assert all(cmd.startswith("sudo -n ") for cmd in runner.commands)
    # command_timeout is propagated.
    assert set(runner.timeouts) == {45}


def test_collect_override_path_and_sudo_disabled():
    runner = FakeRunner(
        [
            ("-v", _result("storcli ver")),
            ("/cALL show J", _result(_fixture("a100_cALL_show_J.json"))),
            ("/c0/vall show J", _result(_fixture("a100__c0_vall_show_J.json"))),
            ("/c0/eall/sall show all J", _result(_fixture("a100__c0_eall_sall_show_all_J.json"))),
        ]
    )
    override = HostDiskHealthOverride(
        storcli_path="/usr/local/bin/storcli", use_sudo=False
    )
    report = collect_disk_health(
        _host(disk_health=override),
        runner,
        config=DiskHealthConfig(),
        command_timeout=20,
    )
    assert report.status == "ok"
    assert len(report.physical_drives) == 6
    assert runner.commands[0] == "/usr/local/bin/storcli -v"
    assert all(not cmd.startswith("sudo") for cmd in runner.commands)
    assert all(cmd.startswith("/usr/local/bin/storcli ") for cmd in runner.commands)


def test_collect_uses_config_candidates_in_order_and_picks_first_success():
    config = DiskHealthConfig(storcli_candidates=("storcliX", "storcliY"))
    runner = FakeRunner(
        [
            ("storcliX -v", _result(stderr="not found", code=127)),
            ("storcliY -v", _result("storcli ver")),
            ("/cALL show J", _result('{"Controllers": []}')),
        ]
    )
    collect_disk_health(_host(), runner, config=config, command_timeout=10)
    assert runner.commands[0] == "sudo -n storcliX -v"
    assert runner.commands[1] == "sudo -n storcliY -v"


def test_collect_previous_drive_triggers_error_increase():
    previous = DiskHealthReport(
        host_name="h100",
        collected_at=datetime(2026, 11, 5, tzinfo=timezone.utc),
        physical_drives=[
            PhysicalDriveInfo(
                controller=0, enclosure=252, slot=0, state="Onln", media_errors=0
            )
        ],
    )
    # a100 fixture has media_errors == 0, so patch the parsed result via a custom
    # PD JSON that reports a media error increase on c0/e252/s0.
    pd_json = _fixture("a100__c0_eall_sall_show_all_J.json").replace(
        '"Media Error Count" : 0', '"Media Error Count" : 4', 1
    )
    runner = FakeRunner(
        [
            ("-v", _result("storcli ver")),
            ("/cALL show J", _result(_fixture("a100_cALL_show_J.json"))),
            ("/c0/vall show J", _result(_fixture("a100__c0_vall_show_J.json"))),
            ("/c0/eall/sall show all J", _result(pd_json)),
        ]
    )
    report = collect_disk_health(
        _host(),
        runner,
        config=DiskHealthConfig(),
        command_timeout=20,
        previous=previous,
    )
    drive = next(
        d
        for d in report.physical_drives
        if (d.controller, d.enclosure, d.slot) == (0, 252, 0)
    )
    assert drive.health == "warning"
    assert "error_increase" in drive.reasons


def test_collect_generic_command_failure_is_reported():
    runner = FakeRunner(
        [
            ("-v", _result("storcli ver")),
            ("/cALL show J", _result(stderr="storcli: failed to open driver", code=2)),
        ]
    )
    report = collect_disk_health(
        _host(), runner, config=DiskHealthConfig(), command_timeout=30
    )
    assert report.status == "error"
    assert report.physical_drives == []
    assert report.message


def test_collect_partial_controller_failure_degrades_without_faking_drives():
    runner = FakeRunner(
        [
            ("-v", _result("storcli ver")),
            ("/cALL show J", _result(_fixture("4090_cALL_show_J.json"))),
            ("/c0/vall show J", _result(_fixture("4090__c0_vall_show_J.json"))),
            ("/c1/vall show J", _result(_fixture("4090__c1_vall_show_J.json"))),
            ("/c0/eall/sall show all J", _result(_fixture("4090__c0_eall_sall_show_all_J.json"))),
            # c1 physical-drive query fails -> must not fabricate drives.
            ("/c1/eall/sall show all J", _result(stderr="timeout", code=1)),
        ]
    )
    report = collect_disk_health(
        _host(), runner, config=DiskHealthConfig(), command_timeout=30
    )
    assert report.status == "degraded"
    assert report.message
    assert len(report.physical_drives) == 6
    assert {d.controller for d in report.physical_drives} == {0}
