"""v0.1.129：磁盘健康页分组内搜索计数。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "servermanage" / "web" / "static" / "disk-health.js"
TEMPLATE = ROOT / "servermanage" / "web" / "templates" / "disk_health.html"
STYLE = ROOT / "servermanage" / "web" / "static" / "style.css"


def test_template_has_count_hint():
    markup = TEMPLATE.read_text(encoding="utf-8")
    assert 'id="disk-search-count"' in markup
    assert 'data-group-count data-group-size="{{ host.group_size }}"' in markup


def test_script_counts_group_hits():
    script = SCRIPT.read_text(encoding="utf-8")
    assert "var groupHits = {};" in script
    assert "groupHits[groupOf(el)] = (groupHits[groupOf(el)] || 0) + 1;" in script
    assert "label.textContent = hits ? ('命中 ' + hits + ' / ' + size + ' 台')" in script
    assert "searchCount.textContent = '搜索命中 ' + visibleHosts + ' 台主机';" in script


def test_script_restores_counts_without_keyword():
    script = SCRIPT.read_text(encoding="utf-8")
    assert "if (!needle) {" in script
    assert "label.textContent = size + ' 台主机';" in script


def test_style_highlights_hit_count():
    css = STYLE.read_text(encoding="utf-8")
    block = css[css.index("v0.1.129 磁盘页分组内搜索计数"):]
    assert "#disk-search-count" in block
    assert ".disk-group-head .disk-group-count" in block
    assert 'html[data-theme="dark"] #disk-search-count' in block
