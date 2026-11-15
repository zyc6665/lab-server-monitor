"""v0.1.213：磁盘详情弹窗可复制这块盘的信息。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def _tpl() -> str:
    return (TEMPLATES / "disk_health.html").read_text(encoding="utf-8")


def _js() -> str:
    return (STATIC / "disk-health.js").read_text(encoding="utf-8")


def test_dialog_has_copy_button():
    tpl = _tpl()
    assert 'id="disk-drive-copy"' in tpl
    assert 'title="把这块盘的字段复制成文本"' in tpl


def test_script_collects_fields_and_copies():
    js = _js()
    assert "var lastDrive = null;" in js
    assert "lines.push(label + '\\t' + (dd.textContent || ''));" in js
    assert "function copyDrive(button)" in js
    assert "lastDrive.lines.join('\\n')" in js
    assert "button.textContent = '已复制';" in js


def test_script_falls_back_when_clipboard_unavailable():
    js = _js()
    assert "navigator.clipboard && navigator.clipboard.writeText" in js
    assert "document.execCommand('copy')" in js
    assert "button.textContent = '复制失败';" in js
