from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "servermanage" / "web" / "static"

TAB = chr(9)
NL = chr(10)


def _line(*fields):
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


class FakeRunner:
    def __init__(self, usage_payloads):
        self.usage_payloads = list(usage_payloads)
        self.sudo_calls = []

    def run(self, command, timeout):
        class Result:
            exit_status = 0
            stdout = SCAN

        return Result()

    def run_sudo(self, command, timeout, stdin_data=None):
        self.sudo_calls.append((command, timeout))

        class Result:
            exit_status = 0

        result = Result()
        result.stdout = self.usage_payloads.pop(0) if self.usage_payloads else ""
        return result


def test_usage_progress_reports_each_account():
    from datetime import datetime, timezone

    from servermanage.models import AuthConfig, HostConfig
    from servermanage.user_scan import collect_host_users

    seen = []
    runner = FakeRunner(
        [
            _line("1024", "/home/alice"),
            _line("2048", "/home/bob"),
        ]
    )
    host = HostConfig(
        name="gpu-01",
        host="10.0.0.1",
        port=22,
        username="root",
        auth=AuthConfig(type="password", password="pw"),
        sudo_password="pw",
    )
    accounts, readable, refreshed = collect_host_users(
        host,
        runner,
        now=datetime(2026, 11, 13, 2, 0, tzinfo=timezone.utc),
        usage_due=True,
        usage_timeout=600,
        usage_progress=lambda name, done, total: seen.append((name, done, total)),
    )

    assert seen == [("alice", 0, 2), ("bob", 1, 2)]
    sizes = {account.username: account.home_size_bytes for account in accounts}
    assert sizes == {"alice": 1024, "bob": 2048}
    assert refreshed is True
    assert readable is True
    # One `du` call per account keeps the round accountable per user.
    assert len(runner.sudo_calls) == 2


def test_route_exposes_current_account():
    body = (ROOT / "servermanage" / "web" / "routes.py").read_text(encoding="utf-8")
    assert '"current_account": payload.get("current_account"),' in body
    assert '"accounts_done": int(payload.get("accounts_done") or 0),' in body
    assert '"current_host": payload.get("current_host"),' in body


def test_frontend_marks_scanning_account():
    js = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "function markScanningAccounts(scan)" in js
    assert "正在统计占用…" in js
    assert "等待统计" in js
    assert "markScanningAccounts(lastScan);" in js
    assert "data-usage-pending" in js


def test_frontend_shows_trend_text():
    js = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "usage-spark-text" in js
    assert "'近 30 天：' + formatBytes(first)" in js


def test_style_covers_scan_badges():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert ".user-acct-scan.is-active" in css
    assert ".usage-spark-text" in css
    assert 'html[data-theme="dark"] .user-acct-scan.is-active' in css
    assert "@media (prefers-reduced-motion: reduce)" in css
