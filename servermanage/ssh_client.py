from __future__ import annotations

import io
from pathlib import Path
from typing import Callable

import paramiko

from servermanage.models import CommandResult, HostConfig


class SudoAuthError(Exception):
    """Raised when sudo rejects the supplied password.

    The message is deliberately generic: the supplied password must never
    appear in an exception message, ``repr`` or traceback.
    """


class SudoUnavailable(Exception):
    """Raised when sudo cannot run and no password was supplied for it."""


# Text sudo emits when the password it read from stdin is wrong.
_SUDO_AUTH_MARKERS = (
    "incorrect password",
    "sorry, try again",
)
# Text sudo emits when it needs a password / escalation but could not get one.
_SUDO_UNAVAILABLE_MARKERS = (
    "a password is required",
    "no tty present",
    "askpass",
    "not in the sudoers",
    "is not allowed to",
    "may not run sudo",
)


def _text_contains_any(texts: tuple[str | None, ...], markers: tuple[str, ...]) -> bool:
    lowered = " ".join((text or "") for text in texts).lower()
    return any(marker in lowered for marker in markers)


def _execute_read_first(stdout, stderr) -> CommandResult:
    """Read both streams to EOF *before* waiting for the exit status.

    Reading first prevents a large writer (e.g. ``storcli show all J`` JSON)
    from filling the SSH channel window and deadlocking while we block on
    ``recv_exit_status``.
    """
    stdout_text = stdout.read().decode("utf-8", errors="replace")
    stderr_text = stderr.read().decode("utf-8", errors="replace")
    exit_status = stdout.channel.recv_exit_status()
    return CommandResult(
        stdout=stdout_text,
        stderr=stderr_text,
        exit_status=exit_status,
    )


def _load_inline_private_key(key_data: str, passphrase: str | None) -> paramiko.PKey:
    """Load an in-memory private key by trying each concrete paramiko key type.

    ``paramiko.PKey.from_private_key`` is the abstract base factory and is broken
    on pinned paramiko 3.5.1, so dispatch to concrete classes instead. Errors are
    re-raised as ``ValueError`` without ever including key material or passphrase.
    """
    last_error: Exception | None = None
    for cls in (paramiko.RSAKey, paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.DSSKey):
        try:
            return cls.from_private_key(
                io.StringIO(key_data),
                password=passphrase or None,
            )
        except paramiko.PasswordRequiredException as exc:
            raise ValueError("SSH private key is encrypted; passphrase required") from exc
        except paramiko.SSHException as exc:
            last_error = exc
            continue
    raise ValueError("Invalid SSH private key") from last_error


class SSHClientWrapper:
    def __init__(
        self,
        *,
        host: HostConfig,
        connect_timeout: int,
        client_factory: Callable[[], paramiko.SSHClient] | None = None,
        keepalive_interval: int = 30,
        shell_timeout: float = 1.0,
    ) -> None:
        self.host = host
        self.connect_timeout = connect_timeout
        self.keepalive_interval = keepalive_interval
        self.shell_timeout = shell_timeout
        self._client_factory = client_factory or self._default_client_factory
        self._client: paramiko.SSHClient | None = None

    @staticmethod
    def _default_client_factory() -> paramiko.SSHClient:
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        return client

    def _build_connect_kwargs(self) -> dict:
        kwargs = {
            "hostname": self.host.host,
            "port": self.host.port,
            "username": self.host.username,
            "timeout": self.connect_timeout,
        }
        if self.host.auth.type == "password":
            kwargs["password"] = self.host.auth.password
        elif self.host.auth.type == "key":
            if self.host.auth.key_data:
                kwargs["pkey"] = _load_inline_private_key(
                    self.host.auth.key_data,
                    self.host.auth.passphrase,
                )
            elif self.host.auth.key_path:
                kwargs["key_filename"] = str(Path(self.host.auth.key_path).expanduser())
                if self.host.auth.passphrase:
                    kwargs["passphrase"] = self.host.auth.passphrase
            else:
                raise ValueError("SSH key is not configured")
        else:  # pragma: no cover - guarded by config validation
            raise ValueError(f"Unsupported auth type: {self.host.auth.type}")
        return kwargs

    def _get_client(self) -> paramiko.SSHClient:
        if self._client is None:
            client = self._client_factory()
            client.connect(**self._build_connect_kwargs())
            self._client = client
        return self._client

    def open_shell(
        self,
        term: str = "xterm-256color",
        width: int = 120,
        height: int = 30,
    ) -> paramiko.Channel:
        """Open an interactive PTY shell channel over the reused connection.

        Reuses :meth:`_get_client` so the terminal shares the same connect logic
        (auth, timeouts) as command execution.  Transport keepalive keeps idle
        sessions from being dropped by intermediate firewalls, and a channel
        timeout keeps the reader thread responsive to close requests.  Callers
        must never touch the private ``_client`` directly.
        """
        client = self._get_client()
        transport = client.get_transport()
        if transport is not None:
            transport.set_keepalive(self.keepalive_interval)
        channel = client.invoke_shell(term=term, width=width, height=height)
        channel.settimeout(self.shell_timeout)
        return channel

    def run(self, command: str, timeout: int) -> CommandResult:
        client = self._get_client()
        _stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        return _execute_read_first(stdout, stderr)

    def run_sudo(
        self, command: str, timeout: int, stdin_data: str | None = None
    ) -> CommandResult:
        """Run *command* through sudo, feeding the password only via stdin.

        With no ``HostConfig.sudo_password`` this degrades to non-interactive
        ``sudo -n``; if that needs a password :class:`SudoUnavailable` is raised.
        With a password it is written to stdin (never the command line, logs or
        exceptions). Wrong-password output maps to :class:`SudoAuthError`.

        ``stdin_data`` (e.g. a ``chpasswd`` line) is written *after* the sudo
        password line; sudo consumes the first line and the child process reads
        the rest from the same channel.
        """
        password = getattr(self.host, "sudo_password", None)
        if not password:
            if stdin_data is None:
                result = self.run("sudo -n " + command, timeout)
            else:
                client = self._get_client()
                stdin, stdout, stderr = client.exec_command(
                    "sudo -n " + command, timeout=timeout
                )
                try:
                    stdin.write(stdin_data + "\n")
                    stdin.flush()
                    stdin.channel.shutdown_write()
                except Exception:  # noqa: BLE001 - stdin may already be closed
                    pass
                result = _execute_read_first(stdout, stderr)
            if result.exit_status != 0 and _text_contains_any(
                (result.stderr, result.stdout), _SUDO_UNAVAILABLE_MARKERS
            ):
                raise SudoUnavailable("未配置 sudo 密码且免密 sudo 不可用") from None
            return result

        client = self._get_client()
        stdin, stdout, stderr = client.exec_command(
            "sudo -S -p '' " + command, timeout=timeout
        )
        try:
            stdin.write(password + "\n")
            if stdin_data is not None:
                stdin.write(stdin_data + "\n")
            stdin.flush()
        except Exception:  # noqa: BLE001 - never let the password into a traceback
            raise SudoUnavailable("sudo 通道不可用") from None
        try:
            stdin.channel.shutdown_write()
        except Exception:  # noqa: BLE001 - some transports close stdin already
            pass
        result = _execute_read_first(stdout, stderr)
        if result.exit_status != 0 and _text_contains_any(
            (result.stderr, result.stdout), _SUDO_AUTH_MARKERS
        ):
            raise SudoAuthError("sudo 密码错误") from None
        return result

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self) -> "SSHClientWrapper":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()
