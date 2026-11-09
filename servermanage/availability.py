"""Availability check execution for 0.2.0.

Builds safe shell commands for ``tcp`` / ``http`` / ``process`` / ``service``
checks, parses their :class:`~servermanage.models.CommandResult` and runs a
list of checks against one host.  All values interpolated into a shell command
are validated and quoted; config-provided strings are never interpolated raw.
"""

from __future__ import annotations

import ipaddress
import re
import shlex
from datetime import datetime, timezone
from typing import Protocol

from .models import CommandResult, HostCheckConfig, HostCheckResult, HostConfig

SUPPORTED_CHECK_TYPES = ("tcp", "http", "process", "service")

_HTTP_FORBIDDEN_TOKENS = ("`", "$(", ";", "|", "&")
_TCP_HOST_RE = re.compile(r"^[A-Za-z0-9.-]{1,253}$")
_PROCESS_RE = re.compile(r"^[A-Za-z0-9._+\-]{1,64}$")
_SERVICE_RE = re.compile(r"^[A-Za-z0-9@._:\-]{1,128}$")
_DIGITS_RE = re.compile(r"^[0-9]+$")
_EXPECTED_RE = re.compile(r"^(\d{3})(?:-(\d{3}))?$")
_BRACKET_V6_RE = re.compile(r"^\[([0-9A-Fa-f:.]+)\]:([0-9]{1,5})$")


class CommandRunner(Protocol):
    """Minimal runner interface (matches ``SSHRunner``)."""

    def run(self, command: str, timeout: int) -> CommandResult:
        ...


class CheckTargetError(ValueError):
    """Raised when a check target fails validation."""


def _coerce_timeout(value: object) -> int:
    """Return ``timeout_seconds`` as an int in 1..30, rejecting forgery."""
    if isinstance(value, bool):
        raise ValueError("timeout_seconds 不能是布尔值")
    if isinstance(value, float):
        raise ValueError("timeout_seconds 必须是整数")
    try:
        timeout = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise ValueError("timeout_seconds 必须是整数") from None
    if not 1 <= timeout <= 30:
        raise ValueError("timeout_seconds 必须在 1..30 之间")
    return timeout


def _has_control_or_space(text: str) -> bool:
    for ch in text:
        if ch.isspace() or ord(ch) < 32 or ord(ch) == 127:
            return True
    return False


def _parse_port(text: str) -> int:
    if not _DIGITS_RE.fullmatch(text):
        raise ValueError(f"TCP 端口非法: {text!r}")
    port = int(text)
    if not 1 <= port <= 65535:
        raise ValueError("TCP 端口必须在 1..65535 之间")
    return port


def _validate_tcp_host(host: str) -> None:
    if not host:
        raise ValueError("TCP 主机为空")
    try:
        ipaddress.ip_address(host)
        return
    except ValueError:
        pass
    if not _TCP_HOST_RE.fullmatch(host):
        raise ValueError(f"TCP 主机名非法: {host!r}")
    if not re.search(r"[A-Za-z0-9]", host):
        raise ValueError(f"TCP 主机名非法: {host!r}")


def _split_tcp_target(target: str) -> tuple[str, int]:
    if not isinstance(target, str) or not target:
        raise ValueError("TCP 目标为空")
    if len(target) > 256:
        raise ValueError("TCP 目标过长")
    if _has_control_or_space(target):
        raise ValueError("TCP 目标包含空白或控制字符")

    if target.startswith("["):
        match = _BRACKET_V6_RE.fullmatch(target)
        if not match:
            raise ValueError(f"TCP IPv6 目标非法: {target!r}")
        host, port_text = match.group(1), match.group(2)
        try:
            if ipaddress.ip_address(host).version != 6:
                raise ValueError("不是 IPv6 地址")
        except ValueError:
            raise ValueError(f"TCP IPv6 主机非法: {host!r}") from None
        return host, _parse_port(port_text)

    if ":" in target:
        host, _, port_text = target.rpartition(":")
    else:
        host, port_text = "127.0.0.1", target
    _validate_tcp_host(host)
    return host, _parse_port(port_text)


def _validate_http_target(target: str) -> str:
    from urllib.parse import urlsplit

    if not isinstance(target, str) or not target:
        raise ValueError("HTTP 目标为空")
    if len(target) > 256:
        raise ValueError("HTTP 目标过长")
    if _has_control_or_space(target):
        raise ValueError("HTTP 目标包含空白或控制字符")
    for token in _HTTP_FORBIDDEN_TOKENS:
        if token in target:
            raise ValueError(f"HTTP 目标包含非法字符: {token!r}")
    if "?" in target or "#" in target:
        raise ValueError("HTTP 目标不允许查询串或片段")

    try:
        parsed = urlsplit(target)
    except ValueError as exc:
        raise ValueError(f"HTTP 目标无法解析: {exc}") from None
    if parsed.scheme not in ("http", "https"):
        raise ValueError("HTTP 目标只允许 http/https")
    if not parsed.netloc:
        raise ValueError("HTTP 目标缺少主机")
    if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
        raise ValueError("HTTP 目标不允许携带 userinfo/凭据")
    if parsed.query or parsed.fragment:
        raise ValueError("HTTP 目标不允许查询串或片段")
    return target


def _validate_process_target(target: str) -> str:
    if not isinstance(target, str) or len(target) > 256:
        raise ValueError("进程目标非法")
    if not _PROCESS_RE.fullmatch(target):
        raise ValueError(f"进程名非法: {target!r}")
    return target


def _validate_service_target(target: str) -> str:
    if not isinstance(target, str) or len(target) > 256:
        raise ValueError("服务目标非法")
    if not _SERVICE_RE.fullmatch(target):
        raise ValueError(f"systemd unit 非法: {target!r}")
    return target


def validate_check_target(check_type: str, target: str) -> str:
    """Validate a check target for ``check_type``; raises ``ValueError``."""
    ctype = (check_type or "").strip().lower()
    if ctype == "tcp":
        _split_tcp_target(target)
        return target
    if ctype == "http":
        return _validate_http_target(target)
    if ctype == "process":
        return _validate_process_target(target)
    if ctype == "service":
        return _validate_service_target(target)
    raise ValueError(f"不支持的检查类型: {check_type!r}")


def build_check_command(check: HostCheckConfig) -> str:
    """Build a safe shell command for one check."""
    timeout = _coerce_timeout(check.timeout_seconds)
    ctype = (check.type or "").strip().lower()

    if ctype == "tcp":
        host, port = _split_tcp_target(check.target)
        inner = f"cat < /dev/null > /dev/tcp/{host}/{port}"
        return f"timeout {timeout} bash -c {shlex.quote(inner)}"

    if ctype == "http":
        url = _validate_http_target(check.target)
        return (
            f"curl -sS -o /dev/null -w '%{{http_code}} %{{time_total}}' "
            f"--max-time {timeout} {shlex.quote(url)}"
        )

    if ctype == "process":
        name = _validate_process_target(check.target)
        return f"pgrep -x -- {shlex.quote(name)}"

    if ctype == "service":
        unit = _validate_service_target(check.target)
        return f"systemctl is-active -- {shlex.quote(unit)}"

    raise ValueError(f"不支持的检查类型: {check.type!r}")


def _expected_range(expected: str | None) -> tuple[int, int]:
    if not expected:
        return (200, 399)
    match = _EXPECTED_RE.fullmatch(str(expected).strip())
    if not match:
        return (200, 399)
    low = int(match.group(1))
    high = int(match.group(2)) if match.group(2) is not None else low
    if low > high:
        low, high = high, low
    return low, high


def _parse_http(check: HostCheckConfig, result: CommandResult) -> tuple[str, str, float | None]:
    if result.exit_status == 127:
        return "error", "curl 不可用", None
    parts = (result.stdout or "").split()
    if not parts:
        return "error", "无 HTTP 输出", None
    code = parts[0]
    latency = None
    if len(parts) > 1:
        try:
            latency = float(parts[1]) * 1000.0
        except ValueError:
            latency = None
    if code == "000" or not re.fullmatch(r"\d{3}", code):
        return "error", f"HTTP {code}：无法连接", latency
    low, high = _expected_range(check.expected)
    status_code = int(code)
    if low <= status_code <= high:
        return "ok", f"HTTP {code}", latency
    return "failed", f"HTTP {code}（期望 {low}-{high}）", latency


def _parse_tcp(result: CommandResult) -> tuple[str, str, float | None]:
    if result.exit_status == 0:
        return "ok", "端口可连接", None
    if result.exit_status == 127:
        return "error", "timeout/bash 命令不可用", None
    detail = (result.stderr or "").strip()
    message = "端口不可连接" + (f"：{detail}" if detail else "")
    return "failed", message, None


def _parse_process(result: CommandResult) -> tuple[str, str, float | None]:
    stdout = (result.stdout or "").strip()
    if result.exit_status == 0 and stdout:
        return "ok", "进程运行中", None
    if result.exit_status == 1:
        return "failed", "进程未运行", None
    if result.exit_status == 0 and not stdout:
        return "error", "进程检查无输出", None
    return "error", f"pgrep 退出码 {result.exit_status}", None


def _parse_service(result: CommandResult) -> tuple[str, str, float | None]:
    state = (result.stdout or "").strip()
    if state == "active":
        return "ok", "服务 active", None
    if state in ("inactive", "failed"):
        return "failed", f"服务 {state}", None
    return "error", f"服务状态 {state or '未知'}", None


def parse_check_result(check: HostCheckConfig, result: CommandResult) -> HostCheckResult:
    """Map a command result to a :class:`HostCheckResult`."""
    ctype = (check.type or "").strip().lower()
    if ctype == "http":
        status, message, latency = _parse_http(check, result)
    elif ctype == "tcp":
        status, message, latency = _parse_tcp(result)
    elif ctype == "process":
        status, message, latency = _parse_process(result)
    elif ctype == "service":
        status, message, latency = _parse_service(result)
    else:
        status, message, latency = "error", f"不支持的检查类型: {check.type!r}", None

    return HostCheckResult(
        name=check.name,
        type=check.type,
        target=check.target,
        status=status,
        message=message,
        latency_ms=latency,
        checked_at=datetime.now(timezone.utc),
    )


def _error_result(check: HostCheckConfig, exc: BaseException) -> HostCheckResult:
    target = check.target if isinstance(getattr(check, "target", ""), str) else ""
    detail = str(exc).strip()
    message = f"检查执行失败：{detail}" if detail else "检查执行失败"
    return HostCheckResult(
        name=getattr(check, "name", "") or "",
        type=getattr(check, "type", "") or "",
        target=target,
        status="error",
        message=message,
        latency_ms=None,
        checked_at=datetime.now(timezone.utc),
    )


def run_host_checks(
    host: HostConfig,
    runner: CommandRunner,
    checks: list[HostCheckConfig],
    command_timeout: int,
) -> list[HostCheckResult]:
    """Run every enabled check sequentially, isolating per-check failures.

    ``host`` is accepted for symmetry with the collector call site; checks are
    executed through ``runner`` over the existing SSH connection.
    """
    del host  # unused, kept for the documented call signature

    try:
        ceiling = int(command_timeout)
    except (TypeError, ValueError):
        ceiling = 0

    enabled = [check for check in checks if getattr(check, "enabled", True)][:20]
    results: list[HostCheckResult] = []
    for check in enabled:
        try:
            timeout = _coerce_timeout(check.timeout_seconds)
            if ceiling > 0:
                timeout = min(timeout, ceiling)
            command = build_check_command(check)
            command_result = runner.run(command, timeout)
            results.append(parse_check_result(check, command_result))
        except Exception as exc:  # noqa: BLE001 - one check must not abort others
            results.append(_error_result(check, exc))
    return results
