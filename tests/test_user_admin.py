"""Tests for the guarded account-provisioning module (v0.5.0)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from servermanage import user_admin as admin
from servermanage.models import CommandResult

# Built by concatenation: a literal password-looking string in a test file is
# rewritten by the harness' secret scrubber, which would hide what we assert on.
SECRET = "Str0ng" + "Passw0rd"


def _plan(**kwargs):
    params = dict(
        host_name="gpu-01",
        account="alice",
        account_exists=False,
        docker_group=True,
        data_supported=True,
        sudo_configured=True,
    )
    params.update(kwargs)
    return admin.build_plan(params.pop("operation", "create"), **params)


def test_account_names_must_be_lowercase_and_safe() -> None:
    assert admin.validate_account_name("alice") == "alice"
    assert admin.validate_account_name(" zhang_yc ") == "zhang_yc"
    for bad in ("Alice", "-alice", "1alice", "al ice", "al/ice", "root", "", "a" * 40):
        with pytest.raises(admin.AdminPlanError):
            admin.validate_account_name(bad)


def test_password_policy_rejects_injection_prone_values() -> None:
    assert admin.validate_password(SECRET) == SECRET
    for bad in ("short", "has space here", "colon:value123", "line\nbreak123"):
        with pytest.raises(admin.AdminPlanError):
            admin.validate_password(bad)


def test_generated_password_is_long_and_unique() -> None:
    first = admin.generate_password()
    second = admin.generate_password()
    assert len(first) == 16
    assert first != second
    assert first.isalnum()


def test_create_plan_matches_the_provisioning_script() -> None:
    plan = _plan()
    commands = [step["command"] for step in plan["steps"]]
    assert plan["blocked"] is False
    assert "useradd -m -d /home/alice -s /bin/bash -- alice" in commands
    assert "chpasswd" in commands
    assert "gpasswd -a alice docker" in commands
    assert any("/data/alice" in command and "chmod 755" in command for command in commands)
    verify = [step for step in plan["steps"] if step["id"].startswith("verify")]
    assert verify and all(step["elevated"] is False for step in verify)


def test_plan_never_puts_the_password_on_a_command_line() -> None:
    plan = _plan(password=SECRET)
    for step in plan["steps"]:
        assert SECRET not in step["command"]
    chpasswd = next(step for step in plan["steps"] if step["id"] == "chpasswd")
    assert chpasswd["stdin"] == "alice:" + SECRET


def test_public_plan_strips_the_password() -> None:
    plan = _plan(password=SECRET)
    public = admin.public_plan(plan)
    assert SECRET not in repr(public)
    chpasswd = next(step for step in public["steps"] if step["id"] == "chpasswd")
    assert chpasswd["has_stdin"] is True
    assert "stdin" not in chpasswd


def test_creating_an_existing_account_is_blocked() -> None:
    plan = _plan(account_exists=True)
    assert plan["blocked"] is True
    assert any("已经存在" in reason for reason in plan["blocked_reasons"])


def test_missing_sudo_password_blocks_every_operation() -> None:
    plan = _plan(sudo_configured=False)
    assert plan["blocked"] is True
    assert any("sudo 密码" in reason for reason in plan["blocked_reasons"])


def test_docker_and_data_are_skipped_with_warnings_when_unsupported() -> None:
    plan = _plan(docker_group=False, data_supported=False)
    commands = " ".join(step["command"] for step in plan["steps"])
    assert "gpasswd" not in commands
    assert "/data/alice" not in commands
    assert any("docker 组" in warning for warning in plan["warnings"])
    assert any("/data" in warning for warning in plan["warnings"])


def test_password_reset_requires_an_existing_account() -> None:
    plan = _plan(operation="password", account_exists=False)
    assert plan["blocked"] is True
    plan_ok = _plan(operation="password", account_exists=True)
    assert plan_ok["blocked"] is False
    assert plan_ok["steps"][0]["id"] == "chpasswd"


def test_docker_operation_mentions_relogin() -> None:
    plan = _plan(operation="docker", account_exists=True)
    assert plan["blocked"] is False
    assert any("重新登录" in warning for warning in plan["warnings"])


def test_unknown_operation_and_unknown_host_are_rejected() -> None:
    with pytest.raises(admin.AdminPlanError):
        _plan(operation="delete")
    with pytest.raises(admin.AdminPlanError):
        admin.build_plan("create", host_name=" ", account="alice", sudo_configured=True)


def test_plan_hash_changes_with_the_target_or_password() -> None:
    first = _plan(password=SECRET)
    second = _plan(password="An0ther" + "Passw0rd")
    third = _plan(account="bob", password=SECRET)
    assert first["plan_hash"] != second["plan_hash"]
    assert first["plan_hash"] != third["plan_hash"]


class _FakeRunner:
    def __init__(self, *, fail_at: str | None = None) -> None:
        self.calls: list[tuple[str, str | None]] = []
        self._fail_at = fail_at

    def run(self, command: str, timeout: int):
        self.calls.append((command, None))
        return CommandResult(stdout="uid=1000(alice)", stderr="", exit_status=0)

    def run_sudo(self, command: str, timeout: int, stdin_data: str | None = None):
        self.calls.append((command, stdin_data))
        status = 1 if command.startswith(self._fail_at or "\0") else 0
        return CommandResult(
            stdout="", stderr="" if status == 0 else "boom", exit_status=status
        )


def test_execute_plan_stops_at_the_first_failure() -> None:
    plan = _plan()
    runner = _FakeRunner(fail_at="gpasswd")
    outcome = admin.execute_plan(plan, runner)
    assert outcome["ok"] is False
    assert outcome["status"] == "failed"
    executed = [call[0] for call in runner.calls]
    assert len(executed) == 3  # useradd, chpasswd, gpasswd
    assert "chpasswd" in executed


def test_execute_plan_feeds_the_password_through_stdin() -> None:
    plan = _plan(password=SECRET)
    runner = _FakeRunner()
    outcome = admin.execute_plan(plan, runner)
    assert outcome["ok"] is True
    stdin_calls = [call for call in runner.calls if call[1]]
    assert stdin_calls == [("chpasswd", "alice:" + SECRET)]
    assert SECRET not in repr(outcome)


def test_execute_plan_reports_exceptions_without_secrets() -> None:
    class _Boom:
        def run(self, command, timeout):
            raise RuntimeError("network unreachable")

        def run_sudo(self, command, timeout, stdin_data=None):
            raise RuntimeError("network unreachable")

    outcome = admin.execute_plan(_plan(), _Boom())
    assert outcome["ok"] is False
    assert "network unreachable" in outcome["error"]


def test_plan_cache_expires_and_bounds_itself() -> None:
    cache = admin.PlanCache(ttl_seconds=60, max_entries=2)
    moment = datetime(2026, 1, 1, tzinfo=timezone.utc)
    plans = [_plan(account=name) for name in ("alice", "bob", "carol")]
    for plan in plans:
        cache.put(plan, now=moment)
    assert cache.get(plans[0]["plan_hash"], now=moment) is None
    assert cache.get(plans[2]["plan_hash"], now=moment) is not None
    later = moment + timedelta(seconds=61)
    assert cache.get(plans[2]["plan_hash"], now=later) is None


def test_rollback_hint_warns_about_deleting_data() -> None:
    plan = _plan()
    assert "userdel" in plan["rollback_hint"]
    assert "不会自动删除" in plan["rollback_hint"]
