"""v0.1.186：告警表列宽可拖拽并记忆。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def test_resize_helpers_exist():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "var ALERT_WIDTHS_KEY = 'alerts:colwidths';" in js
    assert "function readAlertWidths()" in js
    assert "function applyAlertWidths()" in js
    assert "function bindAlertResizers()" in js
    assert "grip.className = 'col-resizer';" in js
    assert "table.style.tableLayout = widths.length ? 'fixed' : '';" in js


def test_resizers_bound_and_applied():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "bindAlertResizers();\n    applyAlertWidths();" in js
    assert "function renderAlertRows() {\n    applyAlertWidths();" in js
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.186 告警表列宽可拖拽" in css
    assert "cursor: col-resize;" in css
    assert "#alerts-table th { position: relative; }" not in css
