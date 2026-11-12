"""v0.1.127：概览主机表列显示偏好。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "servermanage" / "web" / "templates" / "overview.html"
SCRIPT = ROOT / "servermanage" / "web" / "static" / "app.js"
STYLE = ROOT / "servermanage" / "web" / "static" / "style.css"


def test_template_has_column_menu():
    markup = TEMPLATE.read_text(encoding="utf-8")
    assert 'id="host-columns"' in markup
    for name in ("address", "group", "owner", "users", "checks", "health"):
        assert 'data-host-col="' + name + '"' in markup


def test_template_marks_optional_cells():
    markup = TEMPLATE.read_text(encoding="utf-8")
    for name in ("address", "group", "owner", "users", "checks", "health"):
        assert 'col-secondary col-' + name + '"' in markup
        assert 'class="col-secondary col-' + name + '"' in markup


def test_script_applies_and_persists():
    script = SCRIPT.read_text(encoding="utf-8")
    assert "var HOST_COLUMNS_STORE = 'overview:columns';" in script
    assert "table.classList.toggle('hide-' + name, !!hidden[name]);" in script
    assert "localStorage.setItem(HOST_COLUMNS_STORE, JSON.stringify(hidden));" in script
    assert "bindHostColumns();" in script


def test_client_rows_carry_column_classes():
    script = SCRIPT.read_text(encoding="utf-8")
    assert "textCell(host.host, 'mono col-secondary col-address')" in script
    assert "checkCell.className = 'check-cell col-secondary col-checks';" in script
    assert "healthCell.className = 'col-secondary col-health';" in script


def test_style_hides_columns():
    css = STYLE.read_text(encoding="utf-8")
    block = css[css.index("v0.1.127 概览主机表列显示偏好"):]
    for name in ("address", "group", "owner", "users", "checks", "health"):
        assert "#host-table.hide-" + name + " .col-" + name in block
