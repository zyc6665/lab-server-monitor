from pathlib import Path

import pytest

import servermanage.ssh_client as ssh_client
from servermanage.models import AuthConfig, HostConfig
from servermanage.ssh_client import SSHClientWrapper


class FakeChannel:
    def recv_exit_status(self):
        return 0


class FakeStream:
    def __init__(self, data: str):
        self._data = data.encode("utf-8")
        self.channel = FakeChannel()

    def read(self):
        return self._data


class FakeSSHClient:
    def __init__(self):
        self.kwargs = None
        self.closed = False
        self.connect_calls = 0
        self.commands = []

    def set_missing_host_key_policy(self, _policy):
        return None

    def connect(self, **kwargs):
        self.connect_calls += 1
        self.kwargs = kwargs

    def exec_command(self, command, timeout):
        self.commands.append((command, timeout))
        return None, FakeStream("gpu-01"), FakeStream("")

    def close(self):
        self.closed = True


def test_command_result_captures_exit_code():
    host = HostConfig(
        name="gpu-01",
        host="10.0.0.1",
        port=22,
        username="root",
        auth=AuthConfig(type="password", password="secret"),
    )
    client = FakeSSHClient()
    wrapper = SSHClientWrapper(
        host=host,
        connect_timeout=10,
        client_factory=lambda: client,
    )

    result = wrapper.run("hostname", timeout=20)
    wrapper.close()

    assert result.exit_status == 0
    assert result.stdout == "gpu-01"
    assert client.kwargs["password"] == "secret"
    assert client.closed is True


def test_ssh_client_uses_key_auth():
    host = HostConfig(
        name="gpu-01",
        host="10.0.0.1",
        port=22,
        username="root",
        auth=AuthConfig(type="key", key_path="/tmp/id_rsa"),
    )
    client = FakeSSHClient()
    wrapper = SSHClientWrapper(
        host=host,
        connect_timeout=10,
        client_factory=lambda: client,
    )

    wrapper.run("hostname", timeout=20)
    wrapper.close()

    assert client.kwargs["key_filename"] == str(Path("/tmp/id_rsa"))


def test_ssh_client_reuses_connection_until_closed():
    host = HostConfig(
        name="gpu-01",
        host="10.0.0.1",
        port=22,
        username="root",
        auth=AuthConfig(type="password", password="secret"),
    )
    client = FakeSSHClient()
    wrapper = SSHClientWrapper(
        host=host,
        connect_timeout=10,
        client_factory=lambda: client,
    )

    wrapper.run("hostname", timeout=20)
    wrapper.run("uptime", timeout=20)
    wrapper.close()

    assert client.connect_calls == 1
    assert client.commands == [("hostname", 20), ("uptime", 20)]
    assert client.closed is True


def test_ssh_client_uses_key_passphrase_when_configured():
    host = HostConfig(
        name="gpu-01",
        host="10.0.0.1",
        port=22,
        username="root",
        auth=AuthConfig(
            type="key",
            key_path="/tmp/id_rsa",
            passphrase_env="GPU01_KEY_PASSPHRASE",
            passphrase="key-passphrase",
        ),
    )
    client = FakeSSHClient()
    wrapper = SSHClientWrapper(
        host=host,
        connect_timeout=10,
        client_factory=lambda: client,
    )

    wrapper.run("hostname", timeout=20)
    wrapper.close()

    assert client.kwargs["key_filename"] == str(Path("/tmp/id_rsa"))
    assert client.kwargs["passphrase"] == "key-passphrase"


def test_ssh_client_uses_inline_key(monkeypatch):
    sentinel = object()
    monkeypatch.setattr(
        ssh_client.paramiko.PKey,
        "from_private_key",
        classmethod(lambda cls, stream, password=None: sentinel),
    )
    host = HostConfig(
        name="h",
        host="10.0.0.1",
        port=22,
        username="u",
        auth=AuthConfig(type="key", key_data="-----BEGIN KEY-----"),
    )
    wrapper = SSHClientWrapper(host=host, connect_timeout=5)
    kwargs = wrapper._build_connect_kwargs()
    assert kwargs["pkey"] is sentinel
    assert "key_filename" not in kwargs


def test_ssh_client_inline_key_passes_passphrase(monkeypatch):
    sentinel = object()
    captured = {}

    def fake_from_private_key(cls, stream, password=None):
        captured["password"] = password
        return sentinel

    monkeypatch.setattr(
        ssh_client.paramiko.PKey,
        "from_private_key",
        classmethod(fake_from_private_key),
    )
    host = HostConfig(
        name="h",
        host="10.0.0.1",
        port=22,
        username="u",
        auth=AuthConfig(
            type="key",
            key_data="-----BEGIN KEY-----",
            passphrase="secret-pass",
        ),
    )
    wrapper = SSHClientWrapper(host=host, connect_timeout=5)
    assert wrapper._build_connect_kwargs()["pkey"] is sentinel
    assert captured["password"] == "secret-pass"


def test_ssh_client_inline_key_without_passphrase_passes_none(monkeypatch):
    captured = {}

    def fake_from_private_key(cls, stream, password=None):
        captured["password"] = password
        return object()

    monkeypatch.setattr(
        ssh_client.paramiko.PKey,
        "from_private_key",
        classmethod(fake_from_private_key),
    )
    host = HostConfig(
        name="h",
        host="10.0.0.1",
        port=22,
        username="u",
        auth=AuthConfig(type="key", key_data="-----BEGIN KEY-----"),
    )
    SSHClientWrapper(host=host, connect_timeout=5)._build_connect_kwargs()
    assert captured["password"] is None


def test_ssh_client_key_auth_without_key_raises():
    host = HostConfig(
        name="h",
        host="10.0.0.1",
        port=22,
        username="u",
        auth=AuthConfig(type="key"),
    )
    wrapper = SSHClientWrapper(host=host, connect_timeout=5)
    with pytest.raises(ValueError, match="SSH key is not configured"):
        wrapper._build_connect_kwargs()
