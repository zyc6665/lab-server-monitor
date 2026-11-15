"""v0.1.218：账号卡可复制该账号的信息（含占用与显存）。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def _js() -> str:
    return (STATIC / "users.js").read_text(encoding="utf-8")


def _css() -> str:
    return (STATIC / "style.css").read_text(encoding="utf-8")


def test_account_card_has_copy_button():
    js = _js()
    assert "copyButton.className = 'btn-link user-acct-copy';" in js
    assert "copyAccountInfo(copyButton, row)" in js
    assert "head.appendChild(copyButton);" in js


def test_account_text_lists_key_fields():
    js = _js()
    assert "function accountInfoText(row)" in js
    for label in ["账号：", "主机：", "UID / GID：", "家目录：", "/data：", "状态："]:
        assert label in js, label
    assert "function copyTextToClipboard(text, done, failed)" in js
    assert "document.execCommand('copy')" in js


def test_copy_button_style_block():
    css = _css()
    assert "v0.1.218 账号卡复制信息" in css
    assert ".user-acct-head .user-acct-copy" in css
