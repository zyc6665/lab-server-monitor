"""v0.1.83：告警列表按主机分组折叠。"""

from __future__ import annotations

from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.web import create_app

TEMPLATES = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "templates"
STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"


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


def test_alerts_toolbar_has_group_toggle(tmp_path: Path):
    html = _client(tmp_path).get("/alerts").get_data(as_text=True)
    assert 'id="alert-group-toggle"' in html
    assert 'aria-pressed="false"' in html
    assert "按主机分组" in html


def test_grouping_helpers_exist():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "var ALERT_GROUP_KEY = 'alerts:group-by-host';" in js
    assert "function groupAlertsByHost(alerts)" in js
    assert "function buildAlertGroupRow(group)" in js
    assert "function setAlertGrouping(value)" in js
    assert "function readAlertGrouping()" in js
    assert "collapsedHosts[hostKey] = !collapsedHosts[hostKey];" in js
    assert "subRow.classList.add('alert-row', 'alert-subrow');" in js


def test_group_rows_render_instead_of_flat_rows():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "if (alertGrouped) {" in js
    assert "body.appendChild(buildAlertGroupRow(group));" in js
    assert "if (collapsedHosts[group.host]) { continue; }" in js
    # 分组标题行必须跨满 9 列
    assert "cell.colSpan = 9;" in js


def test_group_styles_and_dark_theme():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css[css.index("v0.1.83 告警按主机分组") :]
    assert "#alert-group-toggle.active" in tail
    assert ".alert-group > td.alert-group-cell" in tail
    assert "cursor: pointer" in tail
    assert "tr.alert-subrow > td:first-child" in tail
    assert 'html[data-theme="dark"] .alert-group > td.alert-group-cell' in tail


def test_severity_weight_prefers_critical():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "var SEVERITY_WEIGHT = { critical: 3, warning: 2, info: 1 };" in js
    assert "if (weight > (SEVERITY_WEIGHT[group.severity] || 0)) {" in js
