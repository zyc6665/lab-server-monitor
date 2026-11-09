"""Task 3 tests: remote user scan command construction, parsing and collection."""

from __future__ import annotations

import inspect
import shlex
from datetime import datetime, timezone

import pytest

from servermanage.models import AuthConfig, CommandResult, HostConfig
from servermanage.ssh_client import SudoAuthError, SudoUnavailable
from servermanage.user_scan import (
    USERNAME_RE,
    build_scan_command,
    build_usage_command,
    collect_host_users,
    parse_group,
    parse_passwd,
    parse_usage,
    validate_username,
)

NOW = datetime(2026, 11, 9, 12, 0, tzinfo=timezone.utc)


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
    """Runner double that never touches SSH."""

    def __init__(
        self,
        scan_stdout: str = "",
        *,
        scan_exit: int = 0,
        scan_error: Exception | None = None,
        usage_stdout: str = "",
        usage_exit: int = 0,
        usage_error: Exception | None = None,
    ) -> None:
        self.scan_stdout = scan_stdout
        self.scan_exit = scan_exit
        self.scan_error = scan_error
        self.usage_stdout = usage_stdout
        self.usage_exit = usage_exit
        self.usage_error = usage_error
        self.run_calls: list[tuple[str, int]] = []
        self.sudo_calls: list[tuple[str, int]] = []

    def run(self, command: str, timeout: int) -> CommandResult:
        self.run_calls.append((command, timeout))
        if self.scan_error is not None:
            raise self.scan_error
        return CommandResult(
            stdout=self.scan_stdout, stderr="", exit_status=self.scan_exit
        )

    def run_sudo(self, command: str, timeout: int) -> CommandResult:
        self.sudo_calls.append((command, timeout))
        if self.usage_error is not None:
            raise self.usage_error
        return CommandResult(
            stdout=self.usage_stdout, stderr="", exit_status=self.usage_exit
        )


def collect(
    runner: FakeRunner,
    *,
    usage_due: bool = False,
    command_timeout: int = 120,
    host: HostConfig | None = None,
):
    return collect_host_users(
        host or make_host(),
        runner,
        now=NOW,
        usage_due=usage_due,
        command_timeout=command_timeout,
    )


# --------------------------------------------------------------------------
# Username validation
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    ["alice", "a.b_c-d", "A1", "123", "x" * 64, "-ok"],
)
def test_validate_username_accepts_allowed_names(name):
    assert USERNAME_RE.fullmatch(name) is not None
    assert validate_username(name) is True


@pytest.mark.parametrize(
    "name",
    [
        "",
        "x" * 65,
        "a b",
        "a/b",
        "a;id",
        "a$(id)",
        "a`id`",
        "üser",
        "a\nb",
        "a\tb",
        "a|b",
        "a'b",
        'a"b',
    ],
)
def test_validate_username_rejects_unsafe_names(name):
    assert validate_username(name) is False


# --------------------------------------------------------------------------
# /etc/passwd and /etc/group parsing
# --------------------------------------------------------------------------


PASSWD_TEXT = (
    "root:x:0:0:root:/root:/bin/bash\n"
    "sys:x:999:999:System:/home/sys:/bin/bash\n"
    "alice:x:1000:1000:Alice Smith:/home/alice:/bin/bash\n"
    "svc:x:1001:1001:Service:/home/svc:/usr/sbin/nologin\n"
    "ftp:x:1002:1002:Ftp:/home/ftp:/usr/sbin/false\n"
    "bad:x:not-an-int:1000:Bad:/home/bad:/bin/bash\n"
    "short:x:1003\n"
    "nofields\n"
    "\n"
)


def test_parse_passwd_keeps_only_interactive_lab_accounts():
    users = parse_passwd(PASSWD_TEXT)

    assert users == [
        {
            "username": "alice",
            "uid": 1000,
            "gid": 1000,
            "home": "/home/alice",
            "shell": "/bin/bash",
            "gecos": "Alice Smith",
        }
    ]


def test_parse_passwd_uid_999_excluded_uid_1000_included():
    users = parse_passwd(
        "low:x:999:999:Low:/home/low:/bin/bash\n"
        "boundary:x:1000:1000:High:/home/boundary:/bin/bash\n"
    )

    assert [user["uid"] for user in users] == [1000]


def test_parse_passwd_excludes_nologin_and_false_shells():
    users = parse_passwd(
        "a:x:1000:1000:A:/home/a:/usr/sbin/nologin\n"
        "b:x:1001:1001:B:/home/b:/bin/false\n"
        "c:x:1002:1002:C:/home/c:/bin/bash\n"
    )

    assert [user["username"] for user in users] == ["c"]


def test_parse_passwd_skips_malformed_lines():
    assert parse_passwd("broken\nx:x:x:x:x:x:x\nmissing:fields:1000\n") == []


GROUP_TEXT = (
    "root:x:0:\n"
    "lab:x:1000:\n"
    "docker:x:999:alice,bob\n"
    "bad:x:not-an-int:alice\n"
    "short:x:5\n"
    "wheel:x:10:alice\n"
    "\n"
)


def test_parse_group_returns_members_and_gid_map():
    groups, gid_map = parse_group(GROUP_TEXT)

    assert groups == {
        "root": [],
        "lab": [],
        "docker": ["alice", "bob"],
        "wheel": ["alice"],
    }
    assert gid_map == {0: "root", 1000: "lab", 999: "docker", 10: "wheel"}


def test_parse_group_skips_malformed_lines():
    groups, gid_map = parse_group("bad:x:nan:a\nshort:x\nok:x:7:a,b\n")

    assert groups == {"ok": ["a", "b"]}
    assert gid_map == {7: "ok"}


# --------------------------------------------------------------------------
# Scan / usage command construction
# --------------------------------------------------------------------------


def test_build_scan_command_is_a_fixed_constant_script():
    assert inspect.signature(build_scan_command).parameters == {}
    first = build_scan_command()
    second = build_scan_command()

    assert first == second
    assert "alice" not in first
    assert build_scan_command.__code__.co_argcount == 0


def test_build_scan_command_uses_only_whitelisted_tools():
    command = build_scan_command()

    assert "export LC_ALL=C" in command
    assert "/etc/passwd" in command
    assert "/etc/group" in command
    assert "getent" not in command
    assert "stat -c" in command
    assert '-- "$home"' in command
    assert "2>/dev/null || true" in command
    assert "test -d /data" in command
    assert "P\\t" in command
    assert "U\\t" in command
    assert "G\\t" in command
    assert "H\\t" in command
    assert "D\\t" in command


def test_build_usage_command_quotes_paths_with_spaces_and_quotes():
    command = build_usage_command(["/home/al ice", "/data/o'brien", '/data/a"b'])

    assert command.startswith("du -sx --block-size=1 -- ")
    assert shlex.split(command) == [
        "du",
        "-sx",
        "--block-size=1",
        "--",
        "/home/al ice",
        "/data/o'brien",
        '/data/a"b',
    ]


@pytest.mark.parametrize(
    "path",
    [
        "/etc/passwd",
        "/root",
        "/home",
        "/homex/alice",
        "home/alice",
        "relative",
        "/home/alice\nid",
        "/home/alice\x00id",
    ],
)
def test_build_usage_command_rejects_paths_outside_home_and_data(path):
    with pytest.raises(ValueError):
        build_usage_command([path])


def test_build_usage_command_accepts_home_and_data_prefixes():
    command = build_usage_command(["/home/alice", "/data/alice"])

    assert shlex.split(command)[-2:] == ["/home/alice", "/data/alice"]


# --------------------------------------------------------------------------
# du parsing
# --------------------------------------------------------------------------


def test_parse_usage_reads_bytes_and_paths():
    text = "4096\t/home/alice\n8192\t/data/alice\n"

    assert parse_usage(text) == {"/home/alice": 4096, "/data/alice": 8192}


def test_parse_usage_keeps_paths_with_spaces():
    assert parse_usage("1024\t/home/al ice\n") == {"/home/al ice": 1024}


def test_parse_usage_ignores_malformed_lines():
    text = (
        "4096\t/home/alice\n"
        "not-a-number\t/home/bob\n"
        "123\n"
        "-5\t/home/neg\n"
        "2048\t\n"
        "\n"
    )

    assert parse_usage(text) == {"/home/alice": 4096}


# --------------------------------------------------------------------------
# collect_host_users
# --------------------------------------------------------------------------


SCAN_TEXT = (
    "P\t1\n"
    "U\troot\t0\t0\t/root\t/bin/bash\troot\n"
    "U\talice\t1000\t1000\t/home/alice\t/bin/bash\tAlice Smith\n"
    "U\tsvc\t1001\t1001\t/home/svc\t/usr/sbin/nologin\tService\n"
    "G\troot\t0\t\n"
    "G\tlab\t1000\t\n"
    "G\tdocker\t999\talice\n"
    "G\tsudo\t27\talice\n"
    "H\talice\t1\talice\tlab\t700\n"
    "D\talice\t1\talice\tlab\t755\n"
)


def test_collect_host_users_builds_accounts_from_scan_output():
    runner = FakeRunner(SCAN_TEXT)

    accounts, usage_readable, usage_refreshed = collect(runner)

    assert len(accounts) == 1
    account = accounts[0]
    assert account.host_name == "gpu-01"
    assert account.username == "alice"
    assert account.uid == 1000
    assert account.gid == 1000
    assert account.primary_group == "lab"
    assert account.gecos == "Alice Smith"
    assert account.home == "/home/alice"
    assert account.shell == "/bin/bash"
    assert account.groups == ["lab", "docker", "sudo"]
    assert account.in_docker is True
    assert account.in_sudo is True
    assert account.home_exists is True
    assert account.home_owner == "alice"
    assert account.home_group == "lab"
    assert account.home_mode == "700"
    assert account.data_exists is True
    assert account.data_owner == "alice"
    assert account.data_group == "lab"
    assert account.data_mode == "755"
    assert account.data_supported is True
    assert account.usage_readable is True
    assert account.usage_stale is False
    assert account.collected_at == NOW
    assert account.state == "present"
    assert usage_readable is True
    assert usage_refreshed is False


def test_collect_host_users_runs_scan_with_command_timeout():
    runner = FakeRunner(SCAN_TEXT)

    collect(runner, command_timeout=300)

    assert runner.run_calls == [(build_scan_command(), 300)]


def test_collect_host_users_primary_group_is_first_then_supplemental_sorted():
    scan = (
        "P\t0\n"
        "U\tbob\t1002\t1002\t/home/bob\t/bin/zsh\tBob\n"
        "G\tzzz\t1002\t\n"
        "G\tdocker\t999\tbob\n"
        "G\tubuntu\t1001\tbob\n"
        "G\twheel\t10\tbob\n"
        "H\tbob\t1\tbob\tzzz\t755\n"
    )

    accounts, _, _ = collect(FakeRunner(scan))

    assert accounts[0].primary_group == "zzz"
    assert accounts[0].groups == ["zzz", "docker", "ubuntu", "wheel"]
    assert accounts[0].in_docker is True
    assert accounts[0].in_sudo is True


def test_collect_host_users_detects_wheel_as_sudo_group():
    scan = (
        "P\t0\n"
        "U\tbob\t1002\t1002\t/home/bob\t/bin/zsh\tBob\n"
        "G\tbobgrp\t1002\tbob\n"
        "G\twheel\t10\tbob\n"
        "H\tbob\t1\tbob\tbobgrp\t755\n"
    )

    accounts, _, _ = collect(FakeRunner(scan))

    assert accounts[0].groups == ["bobgrp", "wheel"]
    assert accounts[0].in_sudo is True
    assert accounts[0].in_docker is False


def test_collect_host_users_deduplicates_group_memberships():
    scan = (
        "P\t0\n"
        "U\talice\t1000\t1000\t/home/alice\t/bin/bash\tAlice\n"
        "G\tlab\t1000\t\n"
        "G\tdocker\t999\talice,alice\n"
        "H\talice\t1\talice\tlab\t700\n"
    )

    accounts, _, _ = collect(FakeRunner(scan))

    assert accounts[0].groups == ["lab", "docker"]


def test_collect_host_users_marks_missing_home_and_data():
    scan = (
        "P\t1\n"
        "U\talice\t1000\t1000\t/home/alice\t/bin/bash\tAlice\n"
        "G\tlab\t1000\t\n"
        "H\talice\t0\t-\t-\t-\n"
        "D\talice\t0\t-\t-\t-\n"
    )
    runner = FakeRunner(scan)

    accounts, usage_readable, usage_refreshed = collect(runner, usage_due=True)

    account = accounts[0]
    assert account.home_exists is False
    assert account.home_owner is None
    assert account.data_exists is False
    assert account.data_owner is None
    assert account.home_size_bytes is None
    assert account.data_size_bytes is None
    assert runner.sudo_calls == []
    assert usage_readable is True
    assert usage_refreshed is False


def test_collect_host_users_data_supported_false_skips_data_checks():
    scan = (
        "P\t0\n"
        "U\talice\t1000\t1000\t/home/alice\t/bin/bash\tAlice\n"
        "G\tlab\t1000\t\n"
        "H\talice\t1\talice\tlab\t700\n"
    )
    runner = FakeRunner(
        scan,
        usage_stdout="4096\t/home/alice\n",
    )

    accounts, _, usage_refreshed = collect(runner, usage_due=True)

    account = accounts[0]
    assert account.data_supported is False
    assert account.data_exists is False
    assert account.data_size_bytes is None
    assert account.home_size_bytes == 4096
    assert usage_refreshed is True
    assert shlex.split(runner.sudo_calls[0][0]) == [
        "du",
        "-sx",
        "--block-size=1",
        "--",
        "/home/alice",
    ]


def test_collect_host_users_usage_success_fills_sizes():
    runner = FakeRunner(
        SCAN_TEXT,
        usage_stdout="4096\t/home/alice\n8192\t/data/alice\n",
    )

    accounts, usage_readable, usage_refreshed = collect(runner, usage_due=True)

    account = accounts[0]
    assert account.home_size_bytes == 4096
    assert account.data_size_bytes == 8192
    assert account.usage_readable is True
    assert account.usage_collected_at == NOW
    assert usage_readable is True
    assert usage_refreshed is True
    assert shlex.split(runner.sudo_calls[0][0]) == [
        "du",
        "-sx",
        "--block-size=1",
        "--",
        "/home/alice",
        "/data/alice",
    ]
    assert runner.sudo_calls[0][1] == 120


@pytest.mark.parametrize(
    "error",
    [SudoAuthError("sudo 密码错误"), SudoUnavailable("无 sudo")],
)
def test_collect_host_users_sudo_errors_are_reported_not_raised(error):
    runner = FakeRunner(SCAN_TEXT, usage_error=error)

    accounts, usage_readable, usage_refreshed = collect(runner, usage_due=True)

    assert usage_readable is False
    assert usage_refreshed is False
    assert accounts[0].usage_readable is False
    assert accounts[0].home_size_bytes is None
    assert accounts[0].data_size_bytes is None


def test_collect_host_users_partial_du_failure_keeps_available_sizes():
    runner = FakeRunner(
        SCAN_TEXT,
        usage_stdout="4096\t/home/alice\n",
        usage_exit=1,
    )

    accounts, usage_readable, usage_refreshed = collect(runner, usage_due=True)

    assert accounts[0].home_size_bytes == 4096
    assert accounts[0].data_size_bytes is None
    assert usage_readable is True
    assert usage_refreshed is True


def test_collect_host_users_without_due_usage_skips_sudo():
    runner = FakeRunner(SCAN_TEXT)

    accounts, usage_readable, usage_refreshed = collect(runner, usage_due=False)

    assert runner.sudo_calls == []
    assert accounts[0].home_size_bytes is None
    assert accounts[0].data_size_bytes is None
    assert accounts[0].usage_collected_at is None
    assert usage_readable is True
    assert usage_refreshed is False


def test_collect_host_users_ignores_malformed_scan_lines():
    scan = (
        "P\t1\n"
        "bogus\n"
        "U\tbad/name\t1000\t1000\t/home/bad\t/bin/bash\tBad\n"
        "U\talice\tnot-an-int\t1000\t/home/alice\t/bin/bash\tAlice\n"
        "U\tbob\t1001\t1001\t/home/bob\t/bin/bash\tBob\n"
        "G\tdocker\t999\tbob\n"
        "H\tbob\t1\tbob\tdocker\t755\n"
    )

    accounts, _, _ = collect(FakeRunner(scan))

    assert [account.username for account in accounts] == ["bob"]


def test_collect_host_users_raises_when_scan_command_fails():
    runner = FakeRunner("", scan_exit=255)

    with pytest.raises(RuntimeError):
        collect(runner)
