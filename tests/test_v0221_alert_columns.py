"""v0.1.121：告警表列显示偏好。"""

from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
TEMPLATE = REPO / "servermanage" / "web" / "templates" / "alerts.html"
SCRIPT = REPO / "servermanage" / "web" / "static" / "app.js"
STYLE = REPO / "servermanage" / "web" / "static" / "style.css"


def _template() -> str:
    return TEMPLATE.read_text(encoding="utf-8")


def _script() -> str:
    return SCRIPT.read_text(encoding="utf-8")


def test_toolbar_offers_column_menu():
    html = _template()
    assert 'id="alert-columns"' in html
    for name in ("category", "host", "message"):
        assert f'data-alert-col="{name}"' in html
    assert html.index('id="alert-columns"') < html.index('id="alert-bulk-ack"')


def test_headers_carry_column_classes():
    html = _template()
    assert 'class="col-secondary col-category"' in html
    assert '<th class="col-host">主机</th>' in html
    assert 'class="col-message"' in html


def test_rows_carry_column_classes():
    script = _script()
    assert "categoryCell.classList.add('col-secondary', 'col-category');" in script
    assert "hostCell.className = 'mono col-host';" in script
    assert "'alert-message col-wide col-message'" in script


def test_preference_is_persisted_and_restored():
    script = _script()
    assert "var ALERT_COLUMNS_STORE = 'alerts:columns';" in script
    assert "localStorage.setItem(ALERT_COLUMNS_STORE, JSON.stringify(next));" in script
    assert "boxes[i].checked = !hidden[name];" in script
    assert "bindAlertColumns();" in script


def test_style_hides_columns():
    css = STYLE.read_text(encoding="utf-8")
    block = css[css.index("v0.1.121 告警表列显示偏好"):]
    assert "#alerts-table.hide-category .col-category," in block
    assert "#alerts-table.hide-host .col-host," in block
    assert "#alerts-table.hide-message .col-message { display: none; }" in block
    assert ".col-menu-body" in block
    assert 'html[data-theme="dark"] .col-menu-body' in block
