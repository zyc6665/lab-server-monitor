"""v0.1.188：主机表列宽可拖拽（复用告警表的通用实现）。"""

from __future__ import annotations

from pathlib import Path
from _frontend import app_js_source

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"


def test_generic_resizer_helpers():
    js = app_js_source(STATIC)
    assert "function readTableWidths(key)" in js
    assert "function applyTableWidths(tableId, key)" in js
    assert "function bindTableResizers(tableId, key)" in js
    assert "var HOST_WIDTHS_KEY = 'overview:colwidths';" in js
    assert "bindTableResizers('host-table', HOST_WIDTHS_KEY);" in js
    assert "bindTableResizers('alerts-table', ALERT_WIDTHS_KEY);" in js


def test_host_table_keeps_widths_on_rerender():
    js = app_js_source(STATIC)
    start = js.index("function renderHosts(")
    call = js.index("applyTableWidths('host-table', HOST_WIDTHS_KEY);", start)
    # 重绘函数开头就恢复列宽，避免下一次渲染把用户拖过的宽度冲掉
    assert call - start < 120


def test_host_resizer_styles():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css.split("v0.1.188 主机表列宽可拖拽")[1]
    assert "#host-table .col-resizer" in tail
    assert "cursor: col-resize;" in tail
