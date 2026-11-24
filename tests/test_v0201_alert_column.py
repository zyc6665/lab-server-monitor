"""v0.1.201：主机表与卡片视图显示每台主机的活动告警数。"""

from __future__ import annotations

from pathlib import Path
from _frontend import app_js_source

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def test_header_has_alert_column():
    for name in ("overview.html", "hosts.html"):
        html = (TEMPLATES / name).read_text(encoding="utf-8")
        assert 'data-sort-key="alerts"' in html
        assert ">告警</th>" in html


def test_row_builds_alert_cell():
    js = app_js_source(STATIC)
    assert "var alertTotal = Number(host.active_alert_count || 0);" in js
    assert "'/alerts?host=' + encodeURIComponent(host.name || '') + '&status=active'" in js
    assert "alertLink.textContent = String(alertTotal);" in js
    assert "if (key === 'alerts') { return Number(host.active_alert_count || 0); }" in js


def test_style_present():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.201" in css
    assert ".alert-count-badge" in css
