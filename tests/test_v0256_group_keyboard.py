"""v0.1.156：告警分组行可用键盘展开/折叠，并在重绘后保留焦点。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def test_group_rows_are_semantic_buttons():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "tr.tabIndex = 0;" in js
    assert "tr.setAttribute('role', 'button');" in js
    assert "tr.setAttribute('aria-label', group.host + ' 分组，' + group.alerts.length + ' 条告警');" in js
    assert "tr.setAttribute('aria-expanded', collapsedHosts[group.host] ? 'false' : 'true');" in js


def test_keyboard_toggles_and_keeps_focus():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function toggleAlertGroup(hostKey, keepFocus) {" in js
    assert "if (again && again.focus) { again.focus(); }" in js
    assert "document.addEventListener('keydown', function (event) {" in js
    assert "event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar'" in js
    assert "toggleAlertGroup(row.getAttribute('data-alert-group'), true);" in js
    # 鼠标点击不抢焦点
    assert "toggleAlertGroup(row.getAttribute('data-alert-group'), false);" in js


def test_focus_ring_is_visible():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.156 告警分组行的键盘可达性 -- */" in css
    assert ".alert-group:focus-visible {" in css
    assert "outline: 2px solid var(--accent);" in css
