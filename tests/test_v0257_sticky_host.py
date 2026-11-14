"""v0.1.157：主机表首列（主机名）在横向滚动时保持可见。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_both_pages_use_the_same_table_id():
    for name in ("overview.html", "hosts.html"):
        page = (TEMPLATES / name).read_text(encoding="utf-8")
        assert 'id="host-table"' in page


def test_first_column_is_sticky():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.157 主机表首列吸附 -- */" in css
    assert "#host-table th:first-child," in css
    assert "position: sticky;" in css
    assert "left: 0;" in css
    # 表头单元格压在粘性单元格之上，滚动时不出缝
    assert "#host-table thead th:first-child { z-index: 3; }" in css
    # 深浅色都保持不透明底，避免内容透出来
    assert 'html[data-theme="dark"] #host-table th:first-child,' in css
