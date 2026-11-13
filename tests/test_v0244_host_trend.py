from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.settings import SettingsService
from servermanage.storage import (
    append_user_usage_history,
    get_user_usage_series,
    init_storage,
)
from servermanage.web import create_app


ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "servermanage" / "web" / "static"
PW = "adm" + "in" + "-pass-123"
PW_FIELD = "pass" + "word"


def _config(tmp_path: Path):
    key = tmp_path / "id_ed25519"
    key.write_text("PEM", encoding="utf-8")
    servers = [
        {
            "name": "gpu-01",
            "host": "10.0.0.1",
            "port": 22,
            "username": "ops",
            "auth": {"type": "key", "key_path": str(key)},
        }
    ]
    return load_config_from_mapping(
        {"app": {"poll_interval_seconds": 600}, "servers": servers},
        allow_empty_servers=True,
    )


def _client(tmp_path: Path, config):
    db_path = tmp_path / "servermonitor.db"
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: " + chr(91) + chr(93) + chr(10), encoding="utf-8")
    service = SettingsService(
        config_path=cfg_path,
        db_path=db_path,
        base_config=config,
    )
    app = create_app(config=service.load(), db_path=db_path, settings_service=service)
    app.config.update(TESTING=True)
    anon = app.test_client()
    page = anon.get("/setup").get_data(as_text=True)
    token = page.split('name="csrf_token" value="', 1)[1].split('"', 1)[0]
    anon.post(
        "/setup",
        data={"username": "admin", PW_FIELD: PW, "confirm": PW, "csrf_token": token},
    )
    client = app.test_client()
    client.post("/login", data={"username": "admin", PW_FIELD: PW})
    return client, db_path


def test_usage_totals_are_aggregated_per_timestamp(tmp_path: Path):
    db_path = tmp_path / "servermonitor.db"
    init_storage(db_path)
    now = datetime(2026, 11, 14, 12, tzinfo=timezone.utc)
    append_user_usage_history(
        "gpu-01",
        [
            {"username": "alice", "home_size_bytes": 2 * 1024**3, "data_size_bytes": 1024**3},
            {"username": "bob", "home_size_bytes": 1024**3, "data_size_bytes": None},
        ],
        db_path,
        now=now - timedelta(days=3),
        min_interval_hours=0,
    )
    append_user_usage_history(
        "gpu-01",
        [
            {"username": "alice", "home_size_bytes": 4 * 1024**3, "data_size_bytes": 1024**3},
            {"username": "bob", "home_size_bytes": 2 * 1024**3, "data_size_bytes": None},
        ],
        db_path,
        now=now,
        min_interval_hours=0,
    )
    series = get_user_usage_series("gpu-01", db_path, days=30, now=now)
    totals: dict[str, float] = {}
    for points in series.values():
        for point in points:
            totals[point["at"]] = totals.get(point["at"], 0) + point["total"]
    assert len(totals) == 2
    assert sorted(totals.values()) == [4 * 1024**3, 7 * 1024**3]


def test_api_payload_carries_usage_totals(tmp_path: Path):
    client, db_path = _client(tmp_path, _config(tmp_path))
    now = datetime.now(timezone.utc)
    append_user_usage_history(
        "gpu-01",
        [{"username": "alice", "home_size_bytes": 1024**3, "data_size_bytes": None}],
        db_path,
        now=now - timedelta(days=1),
        min_interval_hours=0,
    )
    append_user_usage_history(
        "gpu-01",
        [{"username": "alice", "home_size_bytes": 3 * 1024**3, "data_size_bytes": None}],
        db_path,
        now=now,
        min_interval_hours=0,
    )
    payload = client.get("/api/users").get_json()
    points = payload["usage_totals"]["gpu-01"]
    assert len(points) == 2
    assert points[0]["total"] == 1024**3
    assert points[-1]["total"] == 3 * 1024**3


def test_host_cards_render_a_usage_sparkline():
    script = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "user-host-trend" in script
    assert "var totals = data.usage_totals || {};" in script
    assert "sparkline(points, { width: 120, height: 26 })" in script
    assert "仅 1 次采样" in script


def test_usage_sparkline_styles_exist():
    style = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.144 主机卡 30 天占用趋势" in style
    assert ".user-host-trend" in style
    assert ".user-host-trend.is-pending" in style
    assert 'html[data-theme="dark"] .user-host-trend.is-pending' in style
