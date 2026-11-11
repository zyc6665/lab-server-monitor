"""v0.1.87：「重点关注」按主机去重。"""

from __future__ import annotations

from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.web import create_app

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def _client(tmp_path: Path):
    app = create_app(
        config=load_config_from_mapping(
            {
                "report": {"daily_enabled": False, "weekly": {"enabled": False}},
                "dashboard": {"auth": {"password": "secret"}},
                "servers": [],
            },
            allow_empty_servers=True,
        ),
        db_path=tmp_path / "monitor.db",
    )
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "zyc"
    return client


def test_overview_has_focus_hint(tmp_path: Path):
    html = _client(tmp_path).get("/").get_data(as_text=True)
    assert 'id="focus-hint"' in html
    assert 'id="focus-alert-list"' in html


def test_js_groups_focus_alerts_by_host():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function pickFocusAlerts(alerts)" in js
    assert "FOCUS_SEVERITY_WEIGHT = { critical: 3, warning: 2, info: 1 }" in js
    assert "同一台主机只保留最严重" in js
    assert "picks.slice(0, 5)" in js
    assert "extra.className = 'focus-extra'" in js
    assert "另有 ' + pick.extra + ' 条" in js
    assert "每台主机只列最严重一条" in js
    # 每台主机最多一条
    assert "groups[key].total += 1" in js


def test_focus_styles():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css[css.index("v0.1.87 重点关注按主机去重") :]
    assert ".focus-hint {" in tail
    assert ".focus-hint[hidden] { display: none !important; }" in tail
    assert ".focus-extra {" in tail
    assert 'html[data-theme="dark"] .focus-extra' in tail
