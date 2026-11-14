"""v0.1.146：告警页筛选区收敛的回归测试。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "servermanage" / "web" / "templates" / "alerts.html"
STYLE = ROOT / "servermanage" / "web" / "static" / "style.css"
SCRIPT = ROOT / "servermanage" / "web" / "static" / "app.js"


def _template() -> str:
    return TEMPLATE.read_text(encoding="utf-8")


def _style() -> str:
    return STYLE.read_text(encoding="utf-8")


def _script() -> str:
    return SCRIPT.read_text(encoding="utf-8")


def test_level_filter_is_only_rendered_once():
    html = _template()
    assert 'id="alert-severity-filter"' not in html
    assert html.count('data-alert-stat="critical"') == 1
    assert 'id="alert-summary"' in html


def test_view_and_bulk_actions_live_in_the_second_row():
    html = _template()
    viewbar = html.split('class="alert-viewbar"', 1)[1].split('id="alert-count"', 1)[0]
    for marker in (
        'id="alert-group-toggle"',
        'id="alert-group-expand"',
        'id="alert-columns"',
        'id="alert-bulk-ack"',
    ):
        assert marker in viewbar
    toolbar = html.split('class="alert-toolbar"', 1)[1].split('class="alert-viewbar"', 1)[0]
    assert 'id="alert-group-toggle"' not in toolbar
    assert 'id="alert-bulk-ack"' not in toolbar


def test_severity_link_still_works_from_the_url():
    script = _script()
    assert "new URLSearchParams(window.location.search).get('severity')" in script
    assert "severityParam === 'critical'" in script


def test_viewbar_styles_exist():
    css = _style()
    assert "/* -- v0.1.146 告警页筛选与操作分区 -- */" in css
    assert ".alert-viewbar {" in css
    assert ".alert-viewbar-actions {" in css
    assert "html[data-theme=\"dark\"] .alert-viewbar" in css or "@media (max-width: 900px)" in css
