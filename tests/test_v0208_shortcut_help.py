"""v0.1.208：键盘快捷键帮助面板。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def _base() -> str:
    return (TEMPLATES / "base.html").read_text(encoding="utf-8")


def _js() -> str:
    return (STATIC / "app.js").read_text(encoding="utf-8")


def _css() -> str:
    return (STATIC / "style.css").read_text(encoding="utf-8")


def test_sidebar_has_help_button_and_dialog():
    base = _base()
    assert 'id="shortcut-help-open"' in base
    assert 'id="shortcut-help"' in base
    assert 'class="shortcut-list"' in base
    for key in ["<kbd>/</kbd>", "<kbd>Esc</kbd>", "<kbd>?</kbd>"]:
        assert key in base


def test_script_opens_dialog_from_button_and_question_mark():
    js = _js()
    assert "function bindShortcutHelp()" in js
    assert "dialog.showModal()" in js
    assert "event.key === '?'" in js
    assert "bindShortcutHelp();" in js


def test_style_defines_help_dialog():
    css = _css()
    assert "v0.1.208" in css
    assert ".shortcut-help::backdrop" in css
    assert ".shortcut-list kbd" in css
    assert ".sidebar-help" in css
