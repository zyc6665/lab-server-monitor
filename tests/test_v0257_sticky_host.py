"""v0.1.157：主机表首列在横向滚动时保持可见。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_css_pins_the_first_column():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.157 主机表首列吸附 -- */" in css
    assert "#host-table th:first-child," in css
    assert "position: sticky;" in css
    assert "left: 0;" in css
    # 表头压在首列之上，滚动时不露出缝隙
    assert "#host-table thead th:first-child { z-index: 3; }" in css
    # 深浅色都要是不透明底，否则内容会透出来
    assert 'html[data-theme="dark"] #host-table th:first-child,' in css
    assert "box-shadow: 1px 0 0 var(--border);" in css


def test_both_host_tables_share_the_id():
    for name in ("overview.html", "hosts.html"):
        page = (TEMPLATES / name).read_text(encoding="utf-8")
        assert 'id="host-table"' in page, name
