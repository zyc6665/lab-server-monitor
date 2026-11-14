"""v0.1.164：设置页显示各分区上次保存的时间。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def test_page_has_save_log_placeholder():
    page = (TEMPLATES / "settings.html").read_text(encoding="utf-8")
    assert 'id="settings-save-log"' in page
    assert 'hidden' in page.split('id="settings-save-log"')[1][:40]


def test_script_records_and_renders_log():
    js = (STATIC / "settings.js").read_text(encoding="utf-8")
    assert 'var SAVE_LOG_KEY = "settings:saved-log";' in js
    assert "function recordSave(sectionName)" in js
    assert "function renderSaveLog()" in js
    assert "recordSave(sectionName);" in js
    assert "box.textContent = \"上次保存：\" + parts.join(\" · \");" in js
    assert "renderSaveLog();\n" in js


def test_styles_hide_when_empty():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.164 设置页显示上次保存 -- */" in css
    assert ".save-log[hidden] { display: none !important; }" in css
