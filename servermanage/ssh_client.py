from __future__ import annotations

from pathlib import Path
from typing import Callable

import paramiko

from servermanage.models import CommandResult, HostConfig


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
            kwargs["key_filename"] = str(Path(self.host.auth.key_path).expanduser())
            if self.host.auth.passphrase:
                kwargs["passphrase"] = self.host.auth.passphrase
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
