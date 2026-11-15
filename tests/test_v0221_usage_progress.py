"""v0.1.221：占用统计的进度面板（当前账号、下一个账号、进度条）。"""

from __future__ import annotations

from pathlib import Path

from test_user_collection import make_config, make_engine, make_host
from servermanage.user_collection import run_user_scan


def test_progress_payload_reports_current_and_next_account(tmp_path):
    db = tmp_path / "monitor.db"
    engine, _ = make_engine(db)
    events = []

    def fake_scan(host, runner, *, now, usage_due, command_timeout=120, usage_timeout=None,
                  sudo_available=True, known_usage=None, usage_progress=None):
        if usage_progress is not None:
            usage_progress("alice", 0, 2, "bob")
        return [], True, True

    run_user_scan(
        make_config(make_host()),
        db,
        engine,
        build_runner=lambda host, config: None,
        scan=fake_scan,
        progress=events.append,
    )

    hits = [event for event in events if event.get("current_account") == "alice"]
    assert hits, events
    assert hits[0]["next_account"] == "bob"
    assert hits[0]["current_host"] == "gpu-01"


def _js() -> str:
    root = Path(__file__).resolve().parents[1]
    return (root / "servermanage" / "web" / "static" / "users.js").read_text(encoding="utf-8")


def _css() -> str:
    root = Path(__file__).resolve().parents[1]
    return (root / "servermanage" / "web" / "static" / "style.css").read_text(encoding="utf-8")


def test_ui_builds_progress_panel():
    js = _js()
    assert "usage-progress-head" in js
    assert "usage-progress-fill" in js
    assert "scan.next_account" in js
    assert "'第 ' + Math.min(accountsDone + 1, accountsTotal)" in js


def test_progress_panel_style_block():
    css = _css()
    assert "v0.1.221 占用统计的进度面板" in css
    assert ".usage-progress-track" in css
    assert "@keyframes usage-pulse" in css
    assert "prefers-reduced-motion" in css
