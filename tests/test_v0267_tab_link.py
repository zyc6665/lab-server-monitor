"""v0.1.167：主机详情可复制当前分区链接，方便分享。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def test_button_exists_in_tab_bar():
    page = (TEMPLATES / "host.html").read_text(encoding="utf-8")
    assert 'id="host-tab-link"' in page
    assert "复制链接" in page
    # 它不该被当成一个分区（没有 data-host-tab）
    assert '<button type="button" class="host-tab host-tab-link" id="host-tab-link"' in page


def test_script_copies_current_tab_url():
    js = (STATIC / "host-detail.js").read_text(encoding="utf-8")
    assert "function bindTabLink()" in js
    assert "var url = base + '#tab-' + currentKey();" in js
    assert "button.textContent = '已复制';" in js
    assert "button.textContent = '复制失败';" in js
    assert "bindTabLink();" in js


def test_link_button_style():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.167 主机详情复制分区链接 -- */" in css
    assert ".host-tab-link {" in css
