from __future__ import annotations

import io
from pathlib import Path
from typing import Callable

import paramiko

from servermanage.models import CommandResult, HostConfig


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
    ) -> None:
        self.host = host
        self.connect_timeout = connect_timeout
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

    def run(self, command: str, timeout: int) -> CommandResult:
        client = self._get_client()
        _stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        exit_status = stdout.channel.recv_exit_status()
        return CommandResult(
            stdout=stdout.read().decode("utf-8", errors="replace"),
            stderr=stderr.read().decode("utf-8", errors="replace"),
            exit_status=exit_status,
        )

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self) -> "SSHClientWrapper":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()
