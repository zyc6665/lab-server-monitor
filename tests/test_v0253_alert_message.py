"""v0.1.153：告警「内容」列收成两行，行高更整齐。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def test_message_column_is_clamped_to_two_lines():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "-webkit-line-clamp: 2;" in css
    assert ".alert-row.is-expanded .alert-message { -webkit-line-clamp: unset; }" in css
    assert "white-space: normal;" in css.split(".alert-message {", 1)[1].split("}", 1)[0]


def test_long_messages_get_expand_affordance():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "if (String(alert.message).length > 48) { messageCell.classList.add('is-clamped'); }" in js
    # 悬浮仍能看到完整内容
    assert "messageCell.title = String(alert.message);" in js


def test_row_expansion_still_toggles_state():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "row.classList.add('is-expanded');" in js
    assert "row.classList.remove('is-expanded');" in js
