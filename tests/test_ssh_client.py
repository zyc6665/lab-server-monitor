from pathlib import Path

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
