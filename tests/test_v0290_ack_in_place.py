"""v0.1.190：告警状态中文显示，单条确认后就地更新而不是整表刷新。"""

from __future__ import annotations

from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"


def test_state_cell_is_localized_and_tagged():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "var stateCell = textCell(STATUS_TEXT[alert.status] || alert.status || '—', 'alert-state');" in js
    assert "stateCell.setAttribute('data-state', alert.status || 'active');" in js


def test_ack_updates_row_in_place():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function applyAckInPlace(button, alertId)" in js
    assert "function dropAlertRow(row)" in js
    assert "applyAckInPlace(button, alertId);" in js
    body = js.split("function ackAlert(button)")[1].split("function openSilenceDialog")[0]
    # 确认后不再整表重刷，避免滚动位置和展开行丢失
    assert "refreshAlerts()" not in body


def test_styles_and_fade():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.190 告警确认就地更新" in css
    assert 'td.alert-state[data-state="acknowledged"]' in css
    assert "tr.alert-row-leaving" in css
