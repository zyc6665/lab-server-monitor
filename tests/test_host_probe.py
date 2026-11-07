from __future__ import annotations

import socket
from dataclasses import dataclass

import paramiko

from servermanage import host_probe
from servermanage.models import CommandResult
from servermanage.host_probe import probe_host

STORCLI_PATH = "/usr/bin/storcli"
SUDO_STORCLI = f"sudo -n {STORCLI_PATH} -v"


@dataclass(frozen=True)
class Candidate:
    """The connection fields the probe receives from the add-host wizard.

    Mirrors the brief: host/port/username/auth_type/password/
    private_key/key_passphrase.  It is deliberately *not* a HostConfig so the
    probe also proves it can accept a transient, unpersisted candidate.
    """

    host: str = "10.0.0.5"
    port: int = 22
    username: str = "root"
    auth_type: str = "password"
    password: str | None = "secret"
    private_key: str | None = None
    key_passphrase: str | None = None


def _ok(stdout: str) -> CommandResult:
    return CommandResult(stdout=stdout, stderr="", exit_status=0)


def _fail(stderr: str = "", status: int = 1) -> CommandResult:
    return CommandResult(stdout="", stderr=stderr, exit_status=status)


class FakeRunner:
    """Records commands and replays canned ``CommandResult`` objects.

    Unmapped commands return a non-zero empty result, exactly like a missing
    binary on a real host.
    """

    def __init__(self, outputs=None, errors=None):
        self.outputs = dict(outputs or {})
        self.errors = dict(errors or {})
        self.commands: list[str] = []
        self.timeouts: list[int] = []
        self.closed = False

    def run(self, command: str, timeout: int) -> CommandResult:
        self.commands.append(command)
        self.timeouts.append(timeout)
        if command in self.errors:
            raise self.errors[command]
        if command in self.outputs:
            return self.outputs[command]
        return _fail(f"command not found: {command}", 127)

    def close(self) -> None:
        self.closed = True


def _happy_outputs() -> dict[str, CommandResult]:
    return {
        "hostname": _ok("gpu-01\n"),
        "cat /etc/os-release": _ok(
            'NAME="Ubuntu"\nVERSION="22.04.3 LTS (Jammy Jellyfish)"\n'
            'PRETTY_NAME="Ubuntu 22.04.3 LTS"\nID=ubuntu\n'
        ),
        "uname -r": _ok("5.15.0-91-generic\n"),
        "nproc": _ok("64\n"),
        "free -m": _ok(
            "              total        used        free      shared  buff/cache   available\n"
            "Mem:         257000       12000      240000         100        5000      245000\n"
            "Swap:          8192           0        8192\n"
        ),
        "df -hP": _ok(
            "Filesystem      Size  Used Avail Use% Mounted on\n"
            "/dev/sda1       200G   50G  140G  25% /\n"
            "/dev/sdb1       1.0T  200G  800G  20% /data\n"
        ),
        "command -v storcli": _ok(STORCLI_PATH + "\n"),
        SUDO_STORCLI: _ok("CLI Version = 007.1711.0000.0000 Apr 2023\n"),
    }


def _probe(runner: FakeRunner, **kwargs):
    return probe_host(Candidate(), ssh_factory=lambda _candidate: runner, **kwargs)


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_probe_host_collects_identity_resources_and_tools():
    runner = FakeRunner(_happy_outputs())

    result = _probe(runner, timeout=8)

    assert result.ok is True
    assert result.status == "ok"
    assert "成功" in result.message
    assert result.hostname == "gpu-01"
    assert result.os_release == "Ubuntu 22.04.3 LTS"
    assert result.kernel == "5.15.0-91-generic"
    assert result.cpu_cores == 64
    assert result.memory_total_mb == 257000
    assert result.storcli_available is True
    assert result.storcli_path == STORCLI_PATH
    assert result.sudo_available is True
    assert result.warnings == []
    assert runner.closed is True

    # Every probe command was bounded by the caller's timeout.
    assert runner.timeouts == [8] * len(runner.commands)
    assert "command -v storcli" in runner.commands
    assert SUDO_STORCLI in runner.commands
    # Read-only identity commands must never be wrapped in sudo.
    assert "hostname" in runner.commands
    assert "cat /etc/os-release" in runner.commands


def test_probe_host_parses_df_mounts_into_dicts():
    runner = FakeRunner(_happy_outputs())

    result = _probe(runner)

    assert result.mounts == [
        {
            "fs": "/dev/sda1",
            "total": "200G",
            "used": "50G",
            "available": "140G",
            "percent": 25,
            "mountpoint": "/",
        },
        {
            "fs": "/dev/sdb1",
            "total": "1.0T",
            "used": "200G",
            "available": "800G",
            "percent": 20,
            "mountpoint": "/data",
        },
    ]


# ---------------------------------------------------------------------------
# Failure wrapping
# ---------------------------------------------------------------------------


def test_probe_host_wraps_authentication_failure():
    runner = FakeRunner(
        errors={"hostname": paramiko.AuthenticationException("Authentication failed.")}
    )

    result = _probe(runner)

    assert result.ok is False
    assert result.status == "auth_failed"
    assert "认证" in result.message
    assert runner.closed is True


def test_probe_host_wraps_connection_timeout():
    runner = FakeRunner(errors={"hostname": socket.timeout("timed out")})

    result = _probe(runner)

    assert result.ok is False
    assert result.status == "timeout"
    assert "超时" in result.message
    assert runner.closed is True


def test_probe_host_wraps_connection_refused():
    runner = FakeRunner(
        errors={"hostname": ConnectionRefusedError(111, "Connection refused")}
    )

    result = _probe(runner)

    assert result.ok is False
    assert result.status == "connection_failed"
    assert result.message
    assert runner.closed is True


def test_probe_host_never_echoes_secret_values():
    secret = "TOP-SECRET-PW-42"
    runner = FakeRunner(
        errors={"hostname": paramiko.AuthenticationException("Auth failed for user")}
    )
    candidate = Candidate(**{"password": secret})

    result = probe_host(candidate, ssh_factory=lambda _c: runner)

    assert secret not in result.message
    assert secret not in repr(result)


# ---------------------------------------------------------------------------
# Non-fatal tooling detection
# ---------------------------------------------------------------------------


def test_probe_host_storcli_missing_is_non_fatal_with_warning():
    outputs = _happy_outputs()
    del outputs["command -v storcli"]
    del outputs[SUDO_STORCLI]
    runner = FakeRunner(outputs)

    result = _probe(runner)

    assert result.ok is True
    assert result.status == "ok"
    assert result.hostname == "gpu-01"
    assert result.storcli_available is False
    assert result.storcli_path is None
    assert result.sudo_available is False
    assert any("storcli" in warning for warning in result.warnings)


def test_probe_host_without_sudo_passwordless_reports_warning():
    outputs = _happy_outputs()
    outputs[SUDO_STORCLI] = _fail("sudo: a password is required", 1)
    runner = FakeRunner(outputs)

    result = _probe(runner)

    assert result.ok is True
    assert result.storcli_available is True
    assert result.storcli_path == STORCLI_PATH
    assert result.sudo_available is False
    assert any("sudo" in warning for warning in result.warnings)


def test_probe_host_tolerates_unparseable_output():
    runner = FakeRunner(
        {
            "hostname": _ok("gpu-02\n"),
            "cat /etc/os-release": _ok("not a valid os-release\n"),
            "uname -r": _ok("\n"),
            "nproc": _ok("not-a-number\n"),
            "free -m": _ok("garbage\n"),
            "df -hP": _ok("garbage\n"),
        }
    )

    result = _probe(runner)

    assert result.ok is True
    assert result.hostname == "gpu-02"
    assert result.os_release is None
    assert result.kernel is None
    assert result.cpu_cores is None
    assert result.memory_total_mb is None
    assert result.mounts == []
    assert result.storcli_available is False


# ---------------------------------------------------------------------------
# Default factory: transient candidate -> HostConfig (no persistence)
# ---------------------------------------------------------------------------


def test_default_factory_maps_candidate_secrets_into_host_config(monkeypatch):
    captured: dict[str, object] = {}

    class FakeWrapper:
        def __init__(self, *, host, connect_timeout):
            captured["host"] = host
            captured["connect_timeout"] = connect_timeout
            self._runner = FakeRunner(_happy_outputs())

        def run(self, command, timeout):
            return self._runner.run(command, timeout)

        def close(self):
            return None

    monkeypatch.setattr(host_probe, "SSHClientWrapper", FakeWrapper)
    candidate = Candidate(**{"password": "TOP-SECRET-PW-42"})

    result = probe_host(candidate, timeout=8)

    assert result.ok is True
    host = captured["host"]
    assert captured["connect_timeout"] == 8
    assert host.host == "10.0.0.5"
    assert host.port == 22
    assert host.username == "root"
    assert host.auth.type == "password"
    assert host.auth.password == "TOP-SECRET-PW-42"
