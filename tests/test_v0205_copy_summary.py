"""v0.1.205：用户页支持一键复制占用汇总。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_template_has_copy_button():
    html = (TEMPLATES / "users.html").read_text(encoding="utf-8")
    assert 'id="user-copy-summary"' in html
    assert 'id="user-refresh"' in html
    assert html.index('id="user-copy-summary"') < html.index('id="user-refresh"')


def test_script_builds_summary_and_handles_failure():
    js = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "function usageSummaryText(data)" in js
    assert "'主机" in js and "\\t账号\\t" in js
    assert "function copyUsageSummary(button)" in js
    assert "复制失败" in js
    assert "navigator.clipboard.writeText(text).then(done, failed)" in js
    assert "document.execCommand('copy')" in js
    assert js.count("lastPayload = data;") == 1
    assert "bindCopySummary();" in js


def test_style_present():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.205" in css
    assert "#user-copy-summary" in css
