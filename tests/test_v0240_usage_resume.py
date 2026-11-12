from datetime import datetime, timezone

from servermanage.models import AuthConfig, HostConfig
from servermanage.user_scan import collect_host_users

TAB = chr(9)
NL = chr(10)


def _line(*fields: str) -> str:
    return TAB.join(fields) + NL


SCAN = (
    _line("P", "1")
    + _line("U", "alice", "1001", "1001", "/home/alice", "/bin/bash", "Alice")
    + _line("U", "bob", "1002", "1002", "/home/bob", "/bin/bash", "Bob")
    + _line("G", "alice", "1001", "alice,docker")
    + _line("G", "bob", "1002", "bob")
    + _line("H", "alice", "1", "alice", "alice", "755")
    + _line("H", "bob", "1", "bob", "bob", "755")
)

NOW = datetime(2026, 11, 12, 4, 0, tzinfo=timezone.utc)
KNOWN_AT = datetime(2026, 11, 11, 4, 0, tzinfo=timezone.utc)


class FakeRunner:
    def __init__(self, usage_stdout: str, exit_status: int = 0):
        self.usage_stdout = usage_stdout
        self.exit_status = exit_status
        self.sudo_calls: list[tuple[str, int]] = []

    def run(self, command, timeout):
        class Result:
            exit_status = 0
            stdout = SCAN

        return Result()

    def run_sudo(self, command, timeout, stdin_data=None):
        self.sudo_calls.append((command, timeout))

        class Result:
            pass

        result = Result()
        result.exit_status = self.exit_status
        result.stdout = self.usage_stdout
        return result


def _host() -> HostConfig:
    return HostConfig(
        name="gpu-01",
        host="10.0.0.9",
        port=22,
        username="root",
        auth=AuthConfig(type="password", password="pw"),
        sudo_password="pw",
    )


def test_known_accounts_are_skipped_and_carried_forward():
    runner = FakeRunner(_line("5368709120", "/home/bob"))
    accounts, readable, refreshed = collect_host_users(
        _host(),
        runner,
        now=NOW,
        usage_due=True,
        usage_timeout=600,
        known_usage={
            "alice": {"home": 1073741824, "data": None, "at": KNOWN_AT},
        },
    )

    by_name = {account.username: account for account in accounts}
    # Only the directory that is still missing goes into `du`.
    assert "/home/bob" in runner.sudo_calls[0][0]
    assert "/home/alice" not in runner.sudo_calls[0][0]
    # Alice keeps yesterday's numbers and her measurement timestamp.
    assert by_name["alice"].home_size_bytes == 1073741824
    assert by_name["alice"].usage_collected_at == KNOWN_AT
    # Bob is measured now.
    assert by_name["bob"].home_size_bytes == 5368709120
    assert by_name["bob"].usage_collected_at == NOW
    assert readable is True
    assert refreshed is True


def test_everything_known_skips_du_entirely():
    runner = FakeRunner("")
    accounts, _readable, refreshed = collect_host_users(
        _host(),
        runner,
        now=NOW,
        usage_due=True,
        known_usage={
            "alice": {"home": 10, "data": None, "at": KNOWN_AT},
            "bob": {"home": 20, "data": None, "at": KNOWN_AT},
        },
    )

    assert runner.sudo_calls == []
    assert [account.home_size_bytes for account in accounts] == [10, 20]
    assert refreshed is False


def test_partial_sweep_only_marks_measured_accounts():
    runner = FakeRunner(_line("5368709120", "/home/bob"))
    accounts, _readable, refreshed = collect_host_users(
        _host(),
        runner,
        now=NOW,
        usage_due=True,
        known_usage={},
    )

    by_name = {account.username: account for account in accounts}
    assert by_name["bob"].home_size_bytes == 5368709120
    assert by_name["bob"].usage_collected_at == NOW
    assert by_name["alice"].home_size_bytes is None
    assert by_name["alice"].usage_collected_at is None
    # Alice is still pending, so the host-level refresh did not complete.
    assert refreshed is False
