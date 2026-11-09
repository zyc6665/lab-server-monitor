"""Host connection probe.

Verify that a candidate SSH host can be reached and authenticated, then
auto-detect the basic facts the add-host wizard needs (hostname, OS release,
kernel, CPU cores, memory, filesystem mounts and storcli/sudo availability).

The probe is intentionally read-only: every identity command is sudo-free and
the only privileged call is ``<storcli> -v`` through ``run_sudo`` (a
non-interactive ``sudo -n`` when no password is supplied) used to detect sudo
availability.  Secret values from the candidate are never stored, serialised or
logged; the returned :class:`ProbeResult` contains no credentials.
"""

from __future__ import annotations

import re
import socket
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

import paramiko

from servermanage.models import AuthConfig, CommandResult, HostConfig
from servermanage.ssh_client import (
    SSHClientWrapper,
    SudoAuthError,
    SudoUnavailable,
)

DEFAULT_TIMEOUT = 8

# Network/SSH errors that mean "the host is reachable but login failed".
_AUTH_MESSAGE = "认证失败：请检查用户名、密码或私钥是否正确"
_TIMEOUT_MESSAGE = "连接超时：请检查主机地址、端口和网络连通性"
_REFUSED_MESSAGE = "无法连接主机：请检查主机地址、端口和网络"


class ProbeRunner(Protocol):
    """Minimal interface shared by :class:`SSHClientWrapper` and test doubles."""

    def run(self, command: str, timeout: int) -> CommandResult:
        ...

    def run_sudo(self, command: str, timeout: int) -> CommandResult:
        ...

    def close(self) -> None:
        ...


@dataclass(frozen=True)
class ProbeResult:
    """Outcome of a host connection probe.

    ``ok`` is ``True`` only when SSH authentication succeeded and the basic
    identity commands ran.  Missing storcli or passwordless sudo is *not* fatal:
    the probe still returns ``ok=True`` and records an explanatory warning.
    """

    ok: bool
    status: str
    message: str
    hostname: str | None = None
    os_release: str | None = None
    kernel: str | None = None
    cpu_cores: int | None = None
    memory_total_mb: int | None = None
    mounts: list[dict[str, Any]] = field(default_factory=list)
    storcli_available: bool = False
    storcli_path: str | None = None
    sudo_available: bool = False
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# candidate -> HostConfig
# ---------------------------------------------------------------------------


def _candidate_value(candidate: Any, name: str, default: Any = None) -> Any:
    """Read a field from either an attribute object or a plain mapping."""

    if isinstance(candidate, Mapping):
        return candidate.get(name, default)
    return getattr(candidate, name, default)


def _build_host_config(candidate: Any) -> HostConfig:
    """Build a transient :class:`HostConfig` from a wizard candidate.

    Accepts either an already-built ``HostConfig`` (as the settings probe route
    constructs) or a lightweight object/dict carrying ``host``, ``port``,
    ``username``, ``auth_type``, ``password``, ``private_key`` and
    ``key_passphrase``.  The result is never persisted.
    """

    if getattr(candidate, "auth", None) is not None:
        return candidate  # already a HostConfig-like object

    auth_type = _candidate_value(candidate, "auth_type", "password") or "password"
    passphrase = _candidate_value(candidate, "key_passphrase")
    if passphrase is None:
        passphrase = _candidate_value(candidate, "passphrase")

    auth = AuthConfig(
        type=str(auth_type),
        password=_candidate_value(candidate, "password"),
        key_data=_candidate_value(candidate, "private_key"),
        key_path=_candidate_value(candidate, "key_path"),
        passphrase=passphrase,
    )
    host = str(_candidate_value(candidate, "host", "") or "")
    return HostConfig(
        name=str(_candidate_value(candidate, "name", "") or host or "probe"),
        host=host,
        port=int(_candidate_value(candidate, "port", 22) or 22),
        username=str(_candidate_value(candidate, "username", "") or ""),
        auth=auth,
        sudo_password=_candidate_value(candidate, "sudo_password"),
    )


def _default_ssh_factory(timeout: int) -> Callable[[Any], ProbeRunner]:
    def factory(candidate: Any) -> ProbeRunner:
        return SSHClientWrapper(
            host=_build_host_config(candidate),
            connect_timeout=int(timeout),
        )

    return factory


# ---------------------------------------------------------------------------
# tolerant parsers
# ---------------------------------------------------------------------------


def _parse_os_release(text: str | None) -> str | None:
    if not text:
        return None
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("PRETTY_NAME="):
            continue
        value = line.split("=", 1)[1].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        return value or None
    return None


def _parse_int(text: str | None) -> int | None:
    if not text:
        return None
    stripped = text.strip()
    try:
        return int(stripped)
    except ValueError:
        match = re.search(r"\d+", stripped)
        return int(match.group()) if match else None


def _parse_memory_total(text: str | None) -> int | None:
    if not text:
        return None
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "Mem:":
            try:
                return int(parts[1])
            except ValueError:
                return None
    return None


def _parse_df(text: str | None) -> list[dict[str, Any]]:
    mounts: list[dict[str, Any]] = []
    if not text:
        return mounts
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.lower().startswith("filesystem"):
            continue
        parts = line.split()
        if len(parts) < 6:
            continue
        fs, total, used, available, percent, *rest = parts
        if not percent.endswith("%"):
            continue
        try:
            percent_value = int(percent.rstrip("%"))
        except ValueError:
            continue
        mounts.append(
            {
                "fs": fs,
                "total": total,
                "used": used,
                "available": available,
                "percent": percent_value,
                "mountpoint": " ".join(rest),
            }
        )
    return mounts


# ---------------------------------------------------------------------------
# command execution helpers
# ---------------------------------------------------------------------------


def _read_field(
    runner: ProbeRunner,
    command: str,
    timeout: int,
    warnings: list[str],
    label: str,
) -> str | None:
    result = runner.run(command, timeout)
    text = (result.stdout or "").strip()
    if result.exit_status != 0 or not text:
        warnings.append(f"无法获取{label}")
        return None
    return text


def _detect_storcli(runner: ProbeRunner, timeout: int) -> str | None:
    for binary in ("storcli", "storcli64"):
        result = runner.run(f"command -v {binary}", timeout)
        lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
        if result.exit_status == 0 and lines:
            return lines[0]
    return None


def _run_probe(runner: ProbeRunner, timeout: int) -> ProbeResult:
    warnings: list[str] = []

    hostname = _read_field(runner, "hostname", timeout, warnings, "主机名")
    os_release = _parse_os_release(
        _read_field(runner, "cat /etc/os-release", timeout, warnings, "系统版本")
    )
    kernel = _read_field(runner, "uname -r", timeout, warnings, "内核版本")
    cpu_cores = _parse_int(_read_field(runner, "nproc", timeout, warnings, "CPU 核数"))
    memory_total_mb = _parse_memory_total(
        _read_field(runner, "free -m", timeout, warnings, "内存信息")
    )
    mounts = _parse_df(_read_field(runner, "df -hP", timeout, warnings, "磁盘挂载"))

    storcli_path = _detect_storcli(runner, timeout)
    storcli_available = bool(storcli_path)
    sudo_available = False
    if storcli_path:
        sudo_available = False
        try:
            run_sudo = getattr(runner, "run_sudo", None)
            if callable(run_sudo):
                sudo_result = run_sudo(f"{storcli_path} -v", timeout)
            else:
                # Legacy test doubles only implement ``run``.
                sudo_result = runner.run(f"sudo -n {storcli_path} -v", timeout)
            sudo_available = sudo_result.exit_status == 0
        except (SudoAuthError, SudoUnavailable):
            sudo_available = False
        if not sudo_available:
            warnings.append(
                "未检测到可用的 sudo 提权；可在主机编辑中配置 sudo 密码，"
                "或配置免密 sudo 后重试"
            )
    else:
        warnings.append("未检测到 storcli，磁盘健康将不可用")

    return ProbeResult(
        ok=True,
        status="ok",
        message="连接成功",
        hostname=hostname,
        os_release=os_release,
        kernel=kernel,
        cpu_cores=cpu_cores,
        memory_total_mb=memory_total_mb,
        mounts=mounts,
        storcli_available=storcli_available,
        storcli_path=storcli_path,
        sudo_available=sudo_available,
        warnings=warnings,
    )


def _failure(status: str, message: str) -> ProbeResult:
    return ProbeResult(ok=False, status=status, message=message)


# ---------------------------------------------------------------------------
# public entry point
# ---------------------------------------------------------------------------


def probe_host(
    candidate: Any,
    *,
    ssh_factory: Callable[[Any], ProbeRunner] | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> ProbeResult:
    """Probe ``candidate`` over SSH and return a populated :class:`ProbeResult`.

    ``ssh_factory`` exists for tests and dependency injection; by default a
    :class:`~servermanage.ssh_client.SSHClientWrapper` is built from the
    candidate using ``timeout`` as the connect timeout.  Authentication and
    connection failures are mapped to stable ``status`` values instead of
    propagating exceptions, and the runner is always closed.
    """

    factory = ssh_factory or _default_ssh_factory(timeout)
    runner: ProbeRunner | None = None
    try:
        runner = factory(candidate)
        return _run_probe(runner, timeout)
    except paramiko.AuthenticationException:
        return _failure("auth_failed", _AUTH_MESSAGE)
    except paramiko.BadHostKeyException:
        return _failure("host_key_failed", "主机密钥校验失败：主机密钥可能已变更")
    except (socket.timeout, TimeoutError):
        return _failure("timeout", _TIMEOUT_MESSAGE)
    except paramiko.SSHException as exc:
        return _failure("ssh_error", f"SSH 连接失败：{exc}")
    except OSError:
        return _failure("connection_failed", _REFUSED_MESSAGE)
    except Exception as exc:  # noqa: BLE001 - probe must never raise to caller
        return _failure("error", f"探测失败：{exc}")
    finally:
        if runner is not None:
            try:
                runner.close()
            except Exception:  # noqa: BLE001 - closing is best effort
                pass
