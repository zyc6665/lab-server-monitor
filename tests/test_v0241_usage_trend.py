"""v0.1.141: TB display and per-account usage growth."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage import storage
from servermanage.web.routes import _host_user_counts

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)
GIB = 1024**3
TIB = 1024**4


def _account(name: str, home: int | None, data: int | None) -> dict:
    return {"username": name, "home_size_bytes": home, "data_size_bytes": data}


def test_history_records_only_measured_accounts(tmp_path):
    db = tmp_path / "monitor.db"
    storage.init_storage(db)

    written = storage.append_user_usage_history(
        "gpu-01",
        [_account("alice", 2 * GIB, None), _account("bob", None, None)],
        db,
        now=NOW,
    )

    assert written == 1
    rows = storage.get_user_usage_deltas("gpu-01", db, days=7, now=NOW)
    assert set(rows) == {"alice"}
    # A single sample cannot express growth yet.
    assert rows["alice"]["delta"] is None
    assert rows["alice"]["points"] == 1


def test_delta_uses_oldest_and_newest_sample(tmp_path):
    db = tmp_path / "monitor.db"
    storage.init_storage(db)

    storage.append_user_usage_history(
        "gpu-01", [_account("alice", 100 * GIB, None)], db, now=NOW - timedelta(days=6)
    )
    storage.append_user_usage_history(
        "gpu-01", [_account("alice", 160 * GIB, 40 * GIB)], db, now=NOW
    )

    rows = storage.get_user_usage_deltas("gpu-01", db, days=7, now=NOW)

    # 100 GiB -> 200 GiB across /home and /data
    assert rows["alice"]["delta"] == 100 * GIB
    assert rows["alice"]["points"] == 2


def test_delta_ignores_samples_outside_the_window(tmp_path):
    db = tmp_path / "monitor.db"
    storage.init_storage(db)

    storage.append_user_usage_history(
        "gpu-01", [_account("alice", 10 * GIB, None)], db, now=NOW - timedelta(days=30)
    )
    storage.append_user_usage_history(
        "gpu-01", [_account("alice", 12 * GIB, None)], db, now=NOW
    )

    rows = storage.get_user_usage_deltas("gpu-01", db, days=7, now=NOW)

    assert rows["alice"]["delta"] is None
    assert rows["alice"]["points"] == 1


def test_host_counts_sum_the_growth():
    rows = [
        {"state": "present", "usage_delta_bytes": 3 * GIB, "home_size_bytes": 5 * GIB},
        {"state": "present", "usage_delta_bytes": -1 * GIB, "home_size_bytes": 2 * GIB},
        {"state": "present", "usage_delta_bytes": None, "home_size_bytes": 1 * GIB},
    ]

    counts = _host_user_counts(rows)

    assert counts["delta_bytes"] == 2 * GIB
    assert counts["delta_days"] == 7


def test_frontend_switches_to_tb_and_renders_growth():
    js = (STATIC / "users.js").read_text(encoding="utf-8")

    assert "num / 1099511627776).toFixed(2) + ' TB'" in js
    assert "function deltaChip(bytes, days)" in js
    assert "deltaChip(row.usage_delta_bytes, row.usage_delta_days)" in js
    assert "deltaChip(host.delta_bytes, host.delta_days)" in js
    assert "'近 ' + days + ' 天 '" in js


def test_growth_styles_exist_for_both_themes():
    css = (STATIC / "style.css").read_text(encoding="utf-8")

    assert ".usage-delta.is-up" in css
    assert ".usage-delta.is-down" in css
    assert 'html[data-theme="dark"] .usage-delta.is-up' in css


def test_routes_expose_delta_fields():
    routes = (ROOT / "servermanage" / "web" / "routes.py").read_text(encoding="utf-8")

    assert "_USAGE_DELTA_DAYS = 7" in routes
    assert 'row["usage_delta_bytes"] = info.get("delta") if info else None' in routes
    assert "get_user_usage_deltas(host_name, db_path, days=_USAGE_DELTA_DAYS)" in routes


def test_unchanged_sizes_are_not_recorded_twice_within_the_floor(tmp_path):
    db = tmp_path / "monitor.db"
    storage.init_storage(db)

    first = storage.append_user_usage_history(
        "gpu-01", [_account("alice", 5 * GIB, None)], db, now=NOW
    )
    again = storage.append_user_usage_history(
        "gpu-01", [_account("alice", 5 * GIB, None)], db, now=NOW + timedelta(hours=1)
    )
    grown = storage.append_user_usage_history(
        "gpu-01", [_account("alice", 7 * GIB, None)], db, now=NOW + timedelta(hours=2)
    )

    assert (first, again, grown) == (1, 0, 1)
    rows = storage.get_user_usage_deltas("gpu-01", db, days=7, now=NOW + timedelta(hours=3))
    assert rows["alice"]["delta"] == 2 * GIB
