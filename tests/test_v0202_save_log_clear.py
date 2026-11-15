"""v0.1.202：设置页「上次保存」记录可清除。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_template_has_clear_button():
    html = (TEMPLATES / "settings.html").read_text(encoding="utf-8")
    assert 'id="settings-save-log-text"' in html
    assert 'id="settings-save-log-clear"' in html
    # 整块仍然默认隐藏
    assert 'id="settings-save-log" hidden' in html


def test_script_clears_log():
    js = (STATIC / "settings.js").read_text(encoding="utf-8")
    assert 'document.getElementById("settings-save-log-text") || box' in js
    assert 'window.localStorage.removeItem(SAVE_LOG_KEY);' in js
    assert "saveLogClear.addEventListener(\"click\"" in js
    # 清除后要重新渲染（隐藏整块）
    assert js.count("renderSaveLog();") >= 3


def test_style_present():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.202" in css
    assert ".save-log-clear" in css
