"""v0.1.79：告警列表可视化打磨（严重度色条 + 相对时间）。"""

from __future__ import annotations

from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"


def _app_js() -> str:
    return (STATIC / "app.js").read_text(encoding="utf-8")


def _css() -> str:
    return (STATIC / "style.css").read_text(encoding="utf-8")


def test_alert_rows_carry_severity_and_status():
    js = _app_js()
    assert "function buildAlertRow(alert)" in js
    assert "tr.setAttribute('data-severity', alert.severity || 'info');" in js
    assert "tr.setAttribute('data-status', alert.status || 'active');" in js


def test_alert_time_uses_relative_format():
    js = _app_js()
    assert "function formatRelative(value)" in js
    assert "' 分钟前'" in js
    assert "' 小时前'" in js
    assert "' 天前'" in js
    assert "'刚刚'" in js
    assert "textCell(formatRelative(alert.created_at), 'mono alert-time')" in js
    assert "timeCell.title = formatStamp(alert.created_at);" in js


def test_alert_polish_styles_are_wired():
    css = _css()
    tail = css[css.index("v0.1.79 告警列表可视化打磨") :]
    for selector in (
        '#alerts-table tbody tr[data-severity="critical"]',
        '#alerts-table tbody tr[data-severity="warning"]',
        '#alerts-table tbody tr[data-severity="info"]',
        '#alerts-table tbody tr[data-status="resolved"]',
        "#alerts-table td.alert-time",
    ):
        assert selector in tail
    assert "inset 3px 0 0 #dc2626" in tail
    assert 'html[data-theme="dark"] #alerts-table tbody tr[data-severity="critical"]' in tail
