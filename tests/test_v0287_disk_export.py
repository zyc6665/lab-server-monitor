"""v0.1.187：磁盘 CSV 导出按筛选结果，不受分组折叠影响。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATE = ROOT / "servermanage" / "web" / "templates" / "disk_health.html"


def test_filter_flag_is_recorded():
    js = (STATIC / "disk-health.js").read_text(encoding="utf-8")
    assert "el.setAttribute('data-disk-match', matched ? '1' : '0');" in js


def test_export_uses_filter_not_collapse():
    js = (STATIC / "disk-health.js").read_text(encoding="utf-8")
    assert "if (block.getAttribute('data-disk-match') === '0') { return; }" in js
    assert "if (block.hidden) { return; }" not in js


def test_export_button_explains_scope():
    html = TEMPLATE.read_text(encoding="utf-8")
    assert 'title="导出当前筛选结果，不受分组折叠影响"' in html
