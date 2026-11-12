"""v0.1.132: hosts without a sudo password skip the size scan entirely."""

from __future__ import annotations

from datetime import datetime, timezone

from servermanage.models import AuthConfig, HostConfig
from servermanage.user_scan import collect_host_users
from test_user_scan import SCAN_TEXT, FakeRunner, make_host

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)

USAGE_TEXT = "1024\t/home/alice\n2048\t/data/alice\n"


def collect(runner, *, usage_due=True, sudo_available=True, usage_timeout=None):
    return collect_host_users(
        make_host(sudo_password="pw"),
        runner,
        now=NOW,
        usage_due=usage_due,
        usage_timeout=usage_timeout,
        sudo_available=sudo_available,
    )


def test_without_sudo_password_probe_fails_and_du_is_skipped():
    runner = FakeRunner(SCAN_TEXT, usage_stdout=USAGE_TEXT, usage_exit=1)

    accounts, readable, refreshed = collect(runner, sudo_available=False)

    # Only the cheap `sudo -n true` probe runs; the long `du` never does.
    assert len(runner.sudo_calls) == 1
    assert runner.sudo_calls[0][0] == "true"
    assert "du " not in runner.sudo_calls[0][0]
    assert readable is False
    assert refreshed is False
    assert accounts[0].home_size_bytes is None


def test_without_password_but_passwordless_sudo_still_collects():
    runner = FakeRunner(SCAN_TEXT, usage_stdout=USAGE_TEXT)

    accounts, readable, refreshed = collect(runner, sudo_available=False)

    assert len(runner.sudo_calls) == 2
    assert runner.sudo_calls[0][0] == "true"
    assert "du " in runner.sudo_calls[1][0]
    assert readable is True
    assert refreshed is True
    assert accounts[0].home_size_bytes == 1024


def test_with_sudo_password_sizes_are_collected():
    runner = FakeRunner(SCAN_TEXT, usage_stdout=USAGE_TEXT)

    accounts, readable, refreshed = collect(runner, usage_timeout=1800)

    assert len(runner.sudo_calls) == 1
    assert runner.sudo_calls[0][1] == 1800
    assert readable is True
    assert refreshed is True
    assert accounts[0].home_size_bytes == 1024


def test_usage_not_due_skips_even_with_sudo():
    runner = FakeRunner(SCAN_TEXT, usage_stdout=USAGE_TEXT)

    _, readable, refreshed = collect(runner, usage_due=False)

    assert runner.sudo_calls == []
    assert readable is True
    assert refreshed is False
