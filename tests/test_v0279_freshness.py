"""v0.1.179：侧栏显示最近一次成功拉取数据的时间。"""

from __future__ import annotations

from pathlib import Path
from _frontend import app_js_source

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_template_has_freshness_slot():
    page = (TEMPLATES / "base.html").read_text(encoding="utf-8")
    assert 'id="data-freshness"' in page
    assert "尚未拉取数据" in page


def test_script_marks_freshness_on_both_pages():
    js = app_js_source(STATIC)
    assert "function markFreshness()" in js
    assert "el.textContent = '更新于 '" in js
    assert js.count("markFreshness();") >= 2


def test_style_present():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.179 侧栏显示数据更新时间 -- */" in css
    assert ".sidebar-freshness" in css
