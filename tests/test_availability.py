"""Task 4 tests: availability check command construction, parsing and execution."""

from __future__ import annotations

import shlex
from datetime import timezone

import pytest

from servermanage.availability import (
    build_check_command,
    parse_check_result,
    run_host_checks,
)
from servermanage.models import (
    AuthConfig,
    CommandResult,
    HostCheckConfig,
    HostConfig,
)


def make_host(**overrides) -> HostConfig:
    data = {
        "name": "gpu-01",
        "host": "10.0.0.1",
        "port": 22,
        "username": "u",
        "auth": AuthConfig(type="password", password="pw"),
    }
    data.update(overrides)
    return HostConfig(**data)


class FakeRunner:
    """A CommandRunner double keyed by a substring of the command."""

    def __init__(self, mapping):
        self.mapping = mapping
        self.calls = []

    def run(self, command: str, timeout: int) -> CommandResult:
        self.calls.append((command, timeout))
        for key, result in self.mapping.items():
            if key in command:
                if isinstance(result, Exception):
                    raise result
                return result
        raise AssertionError(f"unexpected command: {command}")


def _ok(stdout: str) -> CommandResult:
    return CommandResult(stdout=stdout, stderr="", exit_status=0)


# --------------------------------------------------------------------------
# Command construction / validation
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "target",
    [
        "http://x/$(id)",
        "http://x/;id",
        "http://x/a|b",
        "http://x/a&b",
        "http://x/`id`",
        "http://x/a b",
        "http://x/a\tb",
        "http://x/health?token=abc",
        "http://x/health#frag",
        "http://user:pw@x/health",
        "ftp://x/health",
        "http:///no-host",
    ],
)
def test_http_url_with_shell_metacharacters_is_rejected(target):
    with pytest.raises(ValueError):
        build_check_command(HostCheckConfig(name="bad", type="http", target=target))


@pytest.mark.parametrize(
    "timeout",
    ["5; rm -rf /", "abc", True, False, None, 0, 31, -1],
)
def test_timeout_seconds_injection_is_rejected(timeout):
    with pytest.raises(ValueError):
        build_check_command(
            HostCheckConfig(
                name="bad",
                type="http",
                target="http://127.0.0.1:8000/health",
                timeout_seconds=timeout,
            )
        )


@pytest.mark.parametrize(
    "target",
    [
        "22'; id; '",
        "1.2.3.4:22'; id; '",
        "host name:22",
        "1.2.3.4:notaport",
        "1.2.3.4:0",
        "1.2.3.4:70000",
        "bad_host!:22",
        ":22",
        "1.2.3.4:",
    ],
)
def test_tcp_target_rejects_unsafe_or_invalid(target):
    with pytest.raises(ValueError):
        build_check_command(HostCheckConfig(name="bad", type="tcp", target=target))


def test_timeout_is_rendered_as_integer():
    cmd = build_check_command(
        HostCheckConfig(name="p", type="tcp", target="22", timeout_seconds="5")
    )
    assert cmd.startswith("timeout 5 bash -c ")

    http_cmd = build_check_command(
        HostCheckConfig(
            name="h",
            type="http",
            target="http://127.0.0.1:8000/health",
            timeout_seconds=7,
        )
    )
    assert "--max-time 7" in http_cmd


def test_http_command_quotes_url():
    cmd = build_check_command(
        HostCheckConfig(name="api", type="http", target="http://127.0.0.1:8000/health")
    )
    assert "curl -sS" in cmd
    assert "http://127.0.0.1:8000/health" in cmd
    assert "-w" in cmd


def test_http_command_shell_quotes_url_that_needs_quoting():
    target = "http://127.0.0.1:8000/health~x"
    cmd = build_check_command(HostCheckConfig(name="api", type="http", target=target))
    assert shlex.quote(target) in cmd
    assert target in shlex.split(cmd) or shlex.quote(target) in cmd


def test_tcp_command_uses_dev_tcp_and_defaults_localhost():
    cmd = build_check_command(HostCheckConfig(name="ssh", type="tcp", target="22"))
    assert cmd.startswith("timeout 5 bash -c ")
    assert "/dev/tcp/127.0.0.1/22" in cmd


def test_tcp_command_accepts_host_and_port():
    cmd = build_check_command(
        HostCheckConfig(name="ssh", type="tcp", target="10.0.0.5:2222")
    )
    assert "/dev/tcp/10.0.0.5/2222" in cmd


def test_tcp_command_wraps_ipv6_host_in_brackets():
    cmd = build_check_command(
        HostCheckConfig(name="ssh", type="tcp", target="[::1]:22")
    )
    assert "/dev/tcp/[::1]/22" in cmd


def test_process_command_is_safe_and_exact():
    cmd = build_check_command(HostCheckConfig(name="p", type="process", target="nginx"))
    assert "pgrep -x --" in cmd
    assert shlex.quote("nginx") in cmd


@pytest.mark.parametrize("target", ["nginx; id", "foo bar", "a`id`", "x" * 65, "", "$(id)"])
def test_process_target_rejects_invalid(target):
    with pytest.raises(ValueError):
        build_check_command(HostCheckConfig(name="p", type="process", target=target))


def test_service_command_is_safe():
    cmd = build_check_command(
        HostCheckConfig(name="s", type="service", target="nginx.service")
    )
    assert "systemctl is-active --" in cmd
    assert shlex.quote("nginx.service") in cmd


@pytest.mark.parametrize("target", ["nginx;rm", "a b", "x" * 129, "", "$(id)"])
def test_service_target_rejects_invalid(target):
    with pytest.raises(ValueError):
        build_check_command(HostCheckConfig(name="s", type="service", target=target))


def test_unknown_type_is_rejected():
    with pytest.raises(ValueError):
        build_check_command(HostCheckConfig(name="x", type="dns", target="1.1.1.1"))


# --------------------------------------------------------------------------
# Result parsing
# --------------------------------------------------------------------------


def test_http_500_is_failed_and_000_is_error():
    http_check = HostCheckConfig(name="api", type="http", target="http://x/health")
    failed = parse_check_result(http_check, CommandResult("500 0.12", "", 0))
    error = parse_check_result(http_check, CommandResult("000 0.00", "", 0))
    assert failed.status == "failed"
    assert error.status == "error"


def test_http_expected_range_is_honoured():
    check = HostCheckConfig(
        name="api", type="http", target="http://x/health", expected="200-299"
    )
    assert parse_check_result(check, _ok("204 0.01")).status == "ok"
    assert parse_check_result(check, _ok("300 0.01")).status == "failed"


def test_http_single_expected_code():
    check = HostCheckConfig(
        name="api", type="http", target="http://x/health", expected="201"
    )
    assert parse_check_result(check, _ok("201 0.01")).status == "ok"
    assert parse_check_result(check, _ok("200 0.01")).status == "failed"


def test_http_curl_missing_exit_127_is_error():
    check = HostCheckConfig(name="api", type="http", target="http://x/health")
    result = parse_check_result(check, CommandResult("", "curl: not found", 127))
    assert result.status == "error"


def test_http_latency_is_reported_in_milliseconds():
    check = HostCheckConfig(name="api", type="http", target="http://x/health")
    result = parse_check_result(check, _ok("200 0.25"))
    assert result.latency_ms == pytest.approx(250.0)


def test_tcp_parse_statuses():
    check = HostCheckConfig(name="ssh", type="tcp", target="22")
    assert parse_check_result(check, CommandResult("", "", 0)).status == "ok"
    assert parse_check_result(check, CommandResult("", "", 1)).status == "failed"
    assert parse_check_result(check, CommandResult("", "", 127)).status == "error"


def test_process_parse_statuses():
    check = HostCheckConfig(name="p", type="process", target="nginx")
    assert parse_check_result(check, _ok("1234\n")).status == "ok"
    assert parse_check_result(check, CommandResult("", "", 1)).status == "failed"
    assert parse_check_result(check, _ok("")).status == "error"
    assert parse_check_result(check, CommandResult("", "", 2)).status == "error"


def test_service_parse_statuses():
    check = HostCheckConfig(name="s", type="service", target="nginx.service")
    assert parse_check_result(check, _ok("active\n")).status == "ok"
    assert parse_check_result(check, _ok("inactive\n")).status == "failed"
    assert parse_check_result(check, _ok("failed\n")).status == "failed"
    assert parse_check_result(check, _ok("unknown\n")).status == "error"
    assert parse_check_result(check, _ok("not-found\n")).status == "error"


def test_result_carries_requested_fields_and_utc_timestamp():
    check = HostCheckConfig(name="api", type="http", target="http://x/health")
    result = parse_check_result(check, _ok("200 0.01"))
    assert result.name == "api"
    assert result.type == "http"
    assert result.target == "http://x/health"
    assert result.checked_at is not None
    assert result.checked_at.tzinfo is not None
    assert result.checked_at.utcoffset() == timezone.utc.utcoffset(None)


# --------------------------------------------------------------------------
# Runner loop
# --------------------------------------------------------------------------


def test_one_check_failure_does_not_abort_others():
    bad = HostCheckConfig(name="bad", type="http", target="http://x/bad")
    good = HostCheckConfig(name="good", type="http", target="http://x/good")
    runner = FakeRunner(
        {
            "/bad": CommandResult("500 0.10", "", 0),
            "/good": CommandResult("200 0.05", "", 0),
        }
    )
    results = run_host_checks(make_host(), runner, [bad, good], 10)
    assert [r.status for r in results] == ["failed", "ok"]


def test_check_exception_is_isolated_as_error():
    broken = HostCheckConfig(name="broken", type="tcp", target="22'; id; '")
    good = HostCheckConfig(name="good", type="http", target="http://x/good")
    runner = FakeRunner({"/good": CommandResult("200 0.05", "", 0)})
    results = run_host_checks(make_host(), runner, [broken, good], 10)
    assert [r.status for r in results] == ["error", "ok"]
    assert results[1].name == "good"


def test_disabled_checks_are_skipped():
    disabled = HostCheckConfig(
        name="off", type="http", target="http://x/off", enabled=False
    )
    enabled = HostCheckConfig(name="on", type="http", target="http://x/on")
    runner = FakeRunner({"/on": CommandResult("200 0.05", "", 0)})
    results = run_host_checks(make_host(), runner, [disabled, enabled], 10)
    assert [r.name for r in results] == ["on"]
    assert len(runner.calls) == 1


def test_timeout_is_min_of_check_and_command_timeout():
    check = HostCheckConfig(
        name="api", type="http", target="http://x/health", timeout_seconds=10
    )
    runner = FakeRunner({"/health": CommandResult("200 0.05", "", 0)})
    run_host_checks(make_host(), runner, [check], 3)
    assert runner.calls[0][1] == 3
