from pathlib import Path

import io

import paramiko
import pytest

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


@pytest.fixture(scope="module")
def rsa_key():
    return paramiko.RSAKey.generate(2048)


@pytest.fixture(scope="module")
def plain_pem(rsa_key):
    buf = io.StringIO()
    rsa_key.write_private_key(buf)
    return buf.getvalue()


@pytest.fixture(scope="module")
def encrypted_pem(rsa_key):
    buf = io.StringIO()
    rsa_key.write_private_key(buf, password="correct-pass")
    return buf.getvalue()


def _inline_host(key_data, passphrase=None, key_path=None):
    return HostConfig(
        name="h",
        host="10.0.0.1",
        port=22,
        username="u",
        auth=AuthConfig(
            type="key",
            key_data=key_data,
            key_path=key_path,
            passphrase=passphrase,
        ),
    )


def test_ssh_client_uses_inline_key(plain_pem):
    host = _inline_host(plain_pem)
    wrapper = SSHClientWrapper(host=host, connect_timeout=5)
    kwargs = wrapper._build_connect_kwargs()
    assert isinstance(kwargs["pkey"], paramiko.PKey)
    assert "key_filename" not in kwargs


def test_ssh_client_inline_key_encrypted_with_passphrase(encrypted_pem):
    host = _inline_host(encrypted_pem, passphrase="correct-pass")
    wrapper = SSHClientWrapper(host=host, connect_timeout=5)
    kwargs = wrapper._build_connect_kwargs()
    assert isinstance(kwargs["pkey"], paramiko.PKey)


def test_ssh_client_inline_key_encrypted_without_passphrase_raises(encrypted_pem):
    host = _inline_host(encrypted_pem)
    wrapper = SSHClientWrapper(host=host, connect_timeout=5)
    with pytest.raises(ValueError, match="passphrase required"):
        wrapper._build_connect_kwargs()


def test_ssh_client_inline_key_encrypted_wrong_passphrase_raises(encrypted_pem):
    host = _inline_host(encrypted_pem, passphrase="wrong-pass")
    wrapper = SSHClientWrapper(host=host, connect_timeout=5)
    with pytest.raises(ValueError):
        wrapper._build_connect_kwargs()


def test_ssh_client_inline_key_wins_over_key_path(plain_pem):
    host = _inline_host(plain_pem, key_path="/tmp/id_rsa")
    wrapper = SSHClientWrapper(host=host, connect_timeout=5)
    kwargs = wrapper._build_connect_kwargs()
    assert isinstance(kwargs["pkey"], paramiko.PKey)
    assert "key_filename" not in kwargs


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


class _KeepAliveTransport:
    def __init__(self):
        self.interval = None

    def set_keepalive(self, value):
        self.interval = value


class _KeepAliveClient(FakeSSHClient):
    def __init__(self):
        super().__init__()
        self.transport = _KeepAliveTransport()

    def get_transport(self):
        return self.transport


def test_run_sets_transport_keepalive():
    host = HostConfig(
        name="gpu-01",
        host="10.0.0.1",
        port=22,
        username="root",
        auth=AuthConfig(type="password", password="secret"),
    )
    client = _KeepAliveClient()
    wrapper = SSHClientWrapper(
        host=host,
        connect_timeout=10,
        keepalive_interval=45,
        client_factory=lambda: client,
    )
    wrapper.run("hostname", timeout=20)
    wrapper.close()
    assert client.transport.interval == 45


class _FlakyClient(FakeSSHClient):
    def __init__(self):
        super().__init__()
        self.failures_left = 1

    def connect(self, **kwargs):
        if self.failures_left > 0:
            self.failures_left -= 1
            self.connect_calls += 1
            raise paramiko.SSHException("transient handshake failure")
        return super().connect(**kwargs)


def test_transient_connect_error_is_retried_once(monkeypatch):
    import servermanage.ssh_client as ssh_client_mod

    monkeypatch.setattr(ssh_client_mod, "_CONNECT_RETRY_BACKOFF", 0)
    host = HostConfig(
        name="gpu-01",
        host="10.0.0.1",
        port=22,
        username="root",
        auth=AuthConfig(type="password", password="secret"),
    )
    client = _FlakyClient()
    wrapper = SSHClientWrapper(
        host=host, connect_timeout=10, client_factory=lambda: client
    )
    result = wrapper.run("hostname", timeout=20)
    wrapper.close()
    assert result.stdout == "gpu-01"
    assert client.connect_calls == 2


class _AuthFailClient(FakeSSHClient):
    def connect(self, **kwargs):
        self.connect_calls += 1
        raise paramiko.AuthenticationException("bad password")


def test_auth_failure_is_not_retried(monkeypatch):
    import servermanage.ssh_client as ssh_client_mod

    monkeypatch.setattr(ssh_client_mod, "_CONNECT_RETRY_BACKOFF", 0)
    host = HostConfig(
        name="gpu-01",
        host="10.0.0.1",
        port=22,
        username="root",
        auth=AuthConfig(type="password", password="bad"),
    )
    client = _AuthFailClient()
    wrapper = SSHClientWrapper(
        host=host, connect_timeout=10, client_factory=lambda: client
    )
    with pytest.raises(paramiko.AuthenticationException):
        wrapper.run("hostname", timeout=20)
    assert client.connect_calls == 1


def test_inline_private_key_parse_is_cached(plain_pem):
    from servermanage.ssh_client import _load_inline_private_key

    first = _load_inline_private_key(plain_pem, None)
    second = _load_inline_private_key(plain_pem, None)
    assert first is second
