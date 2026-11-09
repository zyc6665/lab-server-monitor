"""Tests for the sudo password channel (Task 3).

Covers three layers:

* :class:`servermanage.ssh_client.SSHClientWrapper` ``run_sudo`` — password only
  on stdin, read-before-exit ordering, and error mapping.
* :func:`servermanage.disk_health.collect_disk_health` — sudo failures become
  ``permission_denied`` instead of being swallowed by the generic handler.
* :func:`servermanage.host_probe.probe_host` — privileged detection goes through
  ``run_sudo`` when the runner provides it, with a legacy ``sudo -n`` fallback.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from servermanage import host_probe
from servermanage.disk_health import collect_disk_health
from servermanage.models import (
    AuthConfig,
    CommandResult,
    DiskHealthConfig,
    HostConfig,
)
from servermanage.ssh_client import (
    SSHClientWrapper,
    SudoAuthError,
    SudoUnavailable,
)


# ---------------------------------------------------------------------------
# fakes for the SSH layer
# ---------------------------------------------------------------------------


class FakeChannel:
    def __init__(self, events: list[str], exit_status: int, stdout: str, stderr: str):
        self.events = events
        self.exit_status = exit_status
        self.stdout = _FakeStream("stdout", events, stdout, self)
        self.stderr = _FakeStream("stderr", events, stderr, self)

    def recv_exit_status(self) -> int:
        self.events.append("recv_exit_status")
        return self.exit_status

    def shutdown_write(self) -> None:
        self.events.append("shutdown_write")


class _FakeStream:
    def __init__(self, name: str, events: list[str], data: str, channel: FakeChannel):
        self.name = name
        self.events = events
        self.data = data
        self.channel = channel

    def read(self) -> bytes:
        self.events.append(f"{self.name}.read")
        return self.data.encode("utf-8")


class FakeStdin:
    def __init__(self, client: "FakeClient", channel: FakeChannel, events: list[str]):
        self.client = client
        self.channel = channel
        self.events = events

    def write(self, data: str) -> None:
        self.client.stdin_written += data
        self.events.append("stdin.write")

    def flush(self) -> None:
        self.events.append("stdin.flush")


class FakeClient:
    def __init__(self, exit_status: int = 0, stdout: str = "", stderr: str = ""):
        self.exit_status = exit_status
        self.stdout = stdout
        self.stderr = stderr
        self.events: list[str] = []
        self.exec_command_calls: list[tuple[str, int | None]] = []
        self.stdin_written = ""

    def connect(self, **kwargs) -> None:
        pass

    def close(self) -> None:
        pass

    def exec_command(self, command: str, timeout: int | None = None):
        self.exec_command_calls.append((command, timeout))
        channel = FakeChannel(self.events, self.exit_status, self.stdout, self.stderr)
        stdin = FakeStdin(self, channel, self.events)
        return stdin, channel.stdout, channel.stderr


def make_host(sudo_password: str | None = None) -> HostConfig:
    return HostConfig(
        name="h100",
        host="10.0.0.10",
        port=22,
        username="zhouyc",
        auth=AuthConfig(type="password", password="x"),
        sudo_password=sudo_password,
    )


def make_ssh_wrapper(*, host: HostConfig, fake_client: FakeClient) -> SSHClientWrapper:
    return SSHClientWrapper(
        host=host,
        connect_timeout=5,
        client_factory=lambda: fake_client,
    )


# ---------------------------------------------------------------------------
# ssh_client.run_sudo
# ---------------------------------------------------------------------------


def test_run_sudo_writes_password_to_stdin_not_command():
    fake_client = FakeClient(exit_status=0, stdout="ok\n")
    wrapper = make_ssh_wrapper(host=make_host(sudo_password="pw"), fake_client=fake_client)

    result = wrapper.run_sudo("storcli /c0 show all", 30)

    command = fake_client.exec_command_calls[0][0]
    assert "pw" not in command
    assert command == "sudo -S -p '' storcli /c0 show all"
    assert fake_client.stdin_written == "pw\n"
    assert result.exit_status == 0
    assert result.stdout == "ok\n"


def test_run_sudo_reads_output_before_exit_status():
    fake_client = FakeClient(exit_status=0, stdout="out", stderr="err")
    wrapper = make_ssh_wrapper(host=make_host(sudo_password="pw"), fake_client=fake_client)

    wrapper.run_sudo("uptime", 10)

    events = fake_client.events
    assert "stdout.read" in events
    assert "stderr.read" in events
    assert "recv_exit_status" in events
    assert events.index("stdout.read") < events.index("recv_exit_status")
    assert events.index("stderr.read") < events.index("recv_exit_status")


def test_run_reads_output_before_exit_status():
    fake_client = FakeClient(exit_status=0, stdout="out", stderr="err")
    wrapper = make_ssh_wrapper(host=make_host(), fake_client=fake_client)

    wrapper.run("uptime", 10)

    events = fake_client.events
    assert events.index("stdout.read") < events.index("recv_exit_status")
    assert events.index("stderr.read") < events.index("recv_exit_status")


@pytest.mark.parametrize(
    "stderr",
    [
        "Sorry, try again.\nsudo: 1 incorrect password attempt\n",
        "sudo: incorrect password attempt\n",
    ],
)
def test_run_sudo_wrong_password_maps_to_sudo_auth_error(stderr):
    fake_client = FakeClient(exit_status=1, stderr=stderr)
    wrapper = make_ssh_wrapper(host=make_host(sudo_password="pw"), fake_client=fake_client)

    with pytest.raises(SudoAuthError) as excinfo:
        wrapper.run_sudo("storcli -v", 10)

    assert "密码" in str(excinfo.value)


def test_run_sudo_error_does_not_leak_password():
    secret = "s3cr3t-pw"
    fake_client = FakeClient(exit_status=1, stderr="Sorry, try again.\n")
    wrapper = make_ssh_wrapper(host=make_host(sudo_password=secret), fake_client=fake_client)

    with pytest.raises(SudoAuthError) as excinfo:
        wrapper.run_sudo("storcli -v", 10)

    assert secret not in str(excinfo.value)
    assert secret not in repr(excinfo.value)
    # Exception chain must not carry the original context either.
    assert excinfo.value.__cause__ is None
    assert excinfo.value.__suppress_context__ is True


def test_run_sudo_without_password_uses_sudo_n():
    fake_client = FakeClient(exit_status=0, stdout="CLI Version\n")
    wrapper = make_ssh_wrapper(host=make_host(sudo_password=None), fake_client=fake_client)

    result = wrapper.run_sudo("storcli -v", 10)

    assert fake_client.exec_command_calls[0][0] == "sudo -n storcli -v"
    assert fake_client.stdin_written == ""
    assert result.exit_status == 0


def test_run_sudo_without_password_and_no_passwordless_maps_to_unavailable():
    fake_client = FakeClient(
        exit_status=1, stderr="sudo: a password is required\n"
    )
    wrapper = make_ssh_wrapper(host=make_host(sudo_password=None), fake_client=fake_client)

    with pytest.raises(SudoUnavailable) as excinfo:
        wrapper.run_sudo("storcli -v", 10)

    assert "免密" in str(excinfo.value)
    assert excinfo.value.__cause__ is None


# ---------------------------------------------------------------------------
# disk_health integration
# ---------------------------------------------------------------------------


class SudoQueueRunner:
    """Fake runner exposing ``run_sudo``; queues canned results/effects."""

    def __init__(self, effects: list[object]):
        self._effects = list(effects)
        self.commands: list[str] = []
        self.sudo_commands: list[str] = []
        self.timeouts: list[int] = []

    def run(self, command: str, timeout: int) -> CommandResult:
        self.commands.append(command)
        raise AssertionError(f"run() should not be used when run_sudo exists: {command}")

    def run_sudo(self, command: str, timeout: int) -> CommandResult:
        self.sudo_commands.append(command)
        self.timeouts.append(timeout)
        effect = self._effects.pop(0)
        if isinstance(effect, Exception):
            raise effect
        return effect


def _this_host(disk_health=None) -> HostConfig:
    return HostConfig(
        name="h100",
        host="10.0.0.10",
        port=22,
        username="zhouyc",
        auth=AuthConfig(type="password", password="x"),
        disk_health=disk_health,
    )


def test_collect_disk_health_maps_bad_sudo_password_to_permission_denied():
    runner = SudoQueueRunner([SudoAuthError("sudo 密码错误")])

    report = collect_disk_health(
        _this_host(), runner, config=DiskHealthConfig(), command_timeout=30
    )

    assert report.status == "permission_denied"
    assert "sudo 密码错误" in (report.message or "")


def test_collect_disk_health_maps_unavailable_sudo_to_permission_denied():
    runner = SudoQueueRunner(
        [SudoUnavailable("未配置 sudo 密码且免密 sudo 不可用")]
    )

    report = collect_disk_health(
        _this_host(), runner, config=DiskHealthConfig(), command_timeout=30
    )

    assert report.status == "permission_denied"
    assert "免密" in (report.message or "")


def test_collect_disk_health_prefers_run_sudo_over_sudo_n_prefix():
    runner = SudoQueueRunner(
        [
            CommandResult(stdout="storcli ver 007", stderr="", exit_status=0),
            CommandResult(stdout='{"Controllers": []}', stderr="", exit_status=0),
        ]
    )

    report = collect_disk_health(
        _this_host(), runner, config=DiskHealthConfig(), command_timeout=25
    )

    assert report.status == "no_controller"
    assert runner.commands == []
    assert runner.sudo_commands[0] == "storcli -v"
    assert all(not cmd.startswith("sudo ") for cmd in runner.sudo_commands)
    assert set(runner.timeouts) == {25}


# ---------------------------------------------------------------------------
# host_probe integration
# ---------------------------------------------------------------------------


class SudoProbeRunner:
    def __init__(
        self,
        *,
        sudo_result: object = None,
        sudo_effect: Exception | None = None,
    ):
        self.sudo_result = sudo_result
        self.sudo_effect = sudo_effect
        self.commands: list[str] = []
        self.sudo_commands: list[str] = []
        self.closed = False

    def run(self, command: str, timeout: int) -> CommandResult:
        self.commands.append(command)
        if command == "command -v storcli":
            return CommandResult(stdout="/usr/bin/storcli\n", stderr="", exit_status=0)
        if command == "hostname":
            return CommandResult(stdout="gpu-01\n", stderr="", exit_status=0)
        return CommandResult(stdout="", stderr="", exit_status=0)

    def run_sudo(self, command: str, timeout: int) -> CommandResult:
        self.sudo_commands.append(command)
        if self.sudo_effect is not None:
            raise self.sudo_effect
        return self.sudo_result or CommandResult(stdout="CLI Version\n", stderr="", exit_status=0)

    def close(self) -> None:
        self.closed = True


@dataclass(frozen=True)
class SudoCandidate:
    host: str = "10.0.0.5"
    port: int = 22
    username: str = "root"
    auth_type: str = "password"
    password: str | None = "secret"
    sudo_password: str | None = "pw"


def test_probe_uses_run_sudo_when_available():
    runner = SudoProbeRunner()

    result = host_probe.probe_host(
        SudoCandidate(), ssh_factory=lambda _c: runner, timeout=8
    )

    assert result.ok is True
    assert result.sudo_available is True
    assert runner.sudo_commands == ["/usr/bin/storcli -v"]
    assert "sudo -n" not in runner.commands


def test_probe_maps_sudo_auth_error_to_unavailable_warning():
    runner = SudoProbeRunner(sudo_effect=SudoAuthError("sudo 密码错误"))

    result = host_probe.probe_host(
        SudoCandidate(sudo_password="bad"), ssh_factory=lambda _c: runner, timeout=8
    )

    assert result.ok is True
    assert result.sudo_available is False
    assert any("sudo" in warning for warning in result.warnings)


def test_probe_legacy_runner_without_run_sudo_falls_back_to_sudo_n():
    class LegacyRunner:
        def __init__(self):
            self.commands: list[str] = []
            self.closed = False

        def run(self, command: str, timeout: int) -> CommandResult:
            self.commands.append(command)
            if command == "command -v storcli":
                return CommandResult(stdout="/usr/bin/storcli\n", stderr="", exit_status=0)
            if command == "sudo -n /usr/bin/storcli -v":
                return CommandResult(stdout="CLI Version\n", stderr="", exit_status=0)
            return CommandResult(stdout="", stderr="", exit_status=0)

        def close(self) -> None:
            self.closed = True

    runner = LegacyRunner()

    result = host_probe.probe_host(
        SudoCandidate(sudo_password=None), ssh_factory=lambda _c: runner, timeout=8
    )

    assert result.sudo_available is True
    assert "sudo -n /usr/bin/storcli -v" in runner.commands


def test_build_host_config_carries_sudo_password_in_memory_only():
    cfg = host_probe._build_host_config(SudoCandidate(sudo_password="pw"))

    assert cfg.sudo_password == "pw"
    # The password is sensitive: it must not appear in repr().
    assert "pw" not in repr(cfg)
