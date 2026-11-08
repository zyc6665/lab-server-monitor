"""v0.1.2 UX wiring: sortable host tables and one-click alert silencing."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from servermanage.config import load_config_from_mapping
from servermanage.settings import SettingsService
from servermanage.web import create_app

ADMIN_PASSWORD = "AdminPass!23"


def _client(tmp_path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "m.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    service = SettingsService(config_path=cfg_path, db_path=db, base_config=base)
    app = create_app(config=service.load(), db_path=db, settings_service=service)
    client = app.test_client()
    page = client.get("/setup").get_data(as_text=True)
    token = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
    assert client.post(
        "/setup",
        data={
            "username": "admin",
            "password": ADMIN_PASSWORD,
            "confirm": ADMIN_PASSWORD,
            "csrf_token": token,
        },
    ).status_code == 302
    assert client.post(
        "/login", data={"username": "admin", "password": ADMIN_PASSWORD}
    ).status_code == 302
    return client, service


def test_host_tables_expose_sort_keys(tmp_path):
    client, _ = _client(tmp_path)
    for path in ("/", "/hosts"):
        html = client.get(path).get_data(as_text=True)
        assert 'data-sort-key="name"' in html
        assert 'data-sort-key="cpu"' in html
        assert 'data-sort-key="health"' in html


def test_alert_search_severity_and_csv_export_are_wired(tmp_path):
    client, _ = _client(tmp_path)
    html = client.get("/alerts").get_data(as_text=True)
    assert 'id="alert-search"' in html
    assert 'id="alert-severity-filter"' in html
    assert 'id="alert-export"' in html

    js = client.get("/static/app.js").get_data(as_text=True)
    assert "filteredAlerts" in js
    assert "exportAlertsCsv" in js
    assert "alertKeyword" in js
    assert "alertSeverity" in js


def test_alert_silence_dialog_and_js_are_wired(tmp_path):
    client, _ = _client(tmp_path)
    html = client.get("/alerts").get_data(as_text=True)
    assert 'id="silence-dialog"' in html
    assert 'id="silence-duration"' in html
    assert 'id="silence-reason"' in html

    js = client.get("/static/app.js").get_data(as_text=True)
    assert "hostSortKey" in js
    assert "silence-btn" in js
    assert "/api/settings/silences" in js
    assert "servermonitorToast" in js


def test_silence_api_accepts_scope_and_returns_id(tmp_path):
    client, service = _client(tmp_path)
    settings = client.get("/settings").get_data(as_text=True)
    token = re.search(r'data-csrf="([^"]+)"', settings).group(1)
    now = datetime.now(timezone.utc)
    response = client.post(
        "/api/settings/silences",
        json={
            "scope_type": "all",
            "scope": None,
            "reason": "维护窗口",
            "starts_at": now.isoformat(),
            "ends_at": (now + timedelta(hours=1)).isoformat(),
        },
        headers={"X-CSRF-Token": token},
    )
    assert response.status_code == 200
    assert response.get_json()["ok"] is True
    assert service.list_silences(active_only=True)
