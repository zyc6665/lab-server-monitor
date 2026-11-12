"""v0.1.142: 30-day usage sparkline, growth leaderboard, 3-day usage interval."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage import storage
from servermanage.models import UserMonitoringConfig
from servermanage.web import create_app
from servermanage.config import load_config_from_mapping

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)
GIB = 1024**3


def _seed(db: Path, host: str, user: str, when: datetime, home: int) -> None:
    storage.append_user_usage_history(
        host,
        [{"username": user, "home_size_bytes": home, "data_size_bytes": None}],
        db,
        now=when,
    )


def _host(name: str) -> HostConfig:
    return HostConfig(
        name=name,
        host="10.0.0.1",
        port=22,
        username="root",
        auth=AuthConfig(type="key", key_path="C:/keys/id_ed25519"),
    )


def _client(tmp_path):
    import re

    from servermanage.settings import SettingsService

    db = tmp_path / "monitor.db"
    storage.init_storage(db)
    key = tmp_path / "id_ed25519"
    key.write_text("dummy-key", encoding="utf-8")
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    base = load_config_from_mapping(
        {"app": {"db_path": str(db)}}, allow_empty_servers=True
    )
    service = SettingsService(
        config_path=cfg_path, db_path=tmp_path / "settings.db", base_config=base
    )
    app = create_app(config=service.load(), db_path=db, settings_service=service)
    app.config.update(TESTING=True)
    client = app.test_client()
    page = client.get("/setup").get_data(as_text=True)
    token = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
    password = "admin" + "-pw-123"
    client.post(
        "/setup",
        data={
            "username": "admin",
            "password": password,
            "confirm": password,
            "csrf_token": token,
        },
    )
    client.post("/login", data={"username": "admin", "password": password})
    client.put(
        "/api/settings/hosts/gpu-01",
        json={
            "address": "10.0.0.1",
            "username": "root",
            "auth_type": "key",
            "key_path": str(key),
        },
        headers={"X-CSRF-Token": re.search(r'name="csrf-token" content="([^"]+)"', client.get("/settings").get_data(as_text=True)).group(1)},
    )
    return client, db


def test_series_groups_by_account_and_down_samples(tmp_path):
    db = tmp_path / "monitor.db"
    storage.init_storage(db)
    for index in range(6):
        _seed(db, "gpu-01", "alice", NOW - timedelta(days=5 - index), GIB * (index + 1))
    _seed(db, "gpu-01", "bob", NOW - timedelta(days=1), 2 * GIB)

    series = storage.get_user_usage_series("gpu-01", db, days=30, now=NOW)

    assert set(series) == {"alice", "bob"}
    assert series["alice"][0]["total"] == GIB
    assert series["alice"][-1]["total"] == 6 * GIB
    assert series["bob"][0]["total"] == 2 * GIB

    limited = storage.get_user_usage_series(
        "gpu-01", db, days=30, now=NOW, max_points=3
    )
    assert len(limited["alice"]) == 3
    assert limited["alice"][0]["total"] == GIB
    assert limited["alice"][-1]["total"] == 6 * GIB


def test_series_ignores_older_samples_and_missing_db(tmp_path):
    db = tmp_path / "monitor.db"
    storage.init_storage(db)
    _seed(db, "gpu-01", "alice", NOW - timedelta(days=40), GIB)

    assert storage.get_user_usage_series("gpu-01", db, days=30, now=NOW) == {}
    assert storage.get_user_usage_series("gpu-01", tmp_path / "nope.db") == {}


def test_top_growth_ranks_positive_deltas(tmp_path):
    db = tmp_path / "monitor.db"
    storage.init_storage(db)
    _seed(db, "gpu-01", "alice", NOW - timedelta(days=3), 10 * GIB)
    _seed(db, "gpu-01", "alice", NOW, 14 * GIB)
    _seed(db, "gpu-02", "bob", NOW - timedelta(days=3), 5 * GIB)
    _seed(db, "gpu-02", "bob", NOW, 10 * GIB)
    _seed(db, "gpu-03", "carol", NOW - timedelta(days=3), 8 * GIB)
    _seed(db, "gpu-03", "carol", NOW, 6 * GIB)
    _seed(db, "gpu-03", "dave", NOW, 3 * GIB)

    items = storage.top_user_growth(db, days=7, limit=5, now=NOW)

    assert [item["account"] for item in items] == ["bob", "alice"]
    assert items[0]["delta"] == 5 * GIB
    assert items[0]["host"] == "gpu-02"
    assert storage.top_user_growth(db, days=7, limit=0, now=NOW) == []


def test_history_endpoint_requires_host_and_returns_accounts(tmp_path):
    client, db = _client(tmp_path)
    _seed(db, "gpu-01", "alice", NOW - timedelta(days=2), GIB)
    _seed(db, "gpu-01", "alice", NOW, 3 * GIB)

    assert client.get("/api/users/history").status_code in (400, 401, 403)

    response = client.get("/api/users/history?host=gpu-01&days=30")
    payload = response.get_json()
    assert response.status_code == 200
    assert payload["host"] == "gpu-01"
    assert payload["days"] == 30
    assert len(payload["accounts"]["alice"]) == 2


def test_top_endpoint_returns_ranked_items(tmp_path):
    client, db = _client(tmp_path)
    _seed(db, "gpu-01", "alice", NOW - timedelta(days=2), 10 * GIB)
    _seed(db, "gpu-01", "alice", NOW, 12 * GIB)

    payload = client.get("/api/users/top?days=7&limit=3").get_json()

    assert payload["days"] == 7
    assert payload["items"][0]["account"] == "alice"
    assert payload["items"][0]["delta"] == 2 * GIB


def test_frontend_renders_sparkline_and_leaderboard():
    js = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "function sparkline(points, options)" in js
    assert "function loadTrends(hostName)" in js
    assert "/api/users/history?host=" in js
    assert "function renderTopGrowth()" in js
    assert "/api/users/top?days=7&limit=8" in js
    assert "data-trend-account" in js
    assert "if (rows.length) { loadTrends(activeHost); }" in js

    html = (ROOT / "servermanage" / "web" / "templates" / "users.html").read_text(
        encoding="utf-8"
    )
    assert 'id="user-top-card"' in html
    assert 'id="user-top-list"' in html

    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert ".usage-spark-line" in css
    assert ".user-top-row" in css


def test_usage_interval_defaults_to_three_days():
    assert UserMonitoringConfig().usage_interval_seconds == 259200
    example = (ROOT / "config" / "config.yaml.example").read_text(encoding="utf-8")
    assert "usage_interval_seconds: 259200" in example
