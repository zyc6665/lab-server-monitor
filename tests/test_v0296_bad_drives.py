"""v0.1.196：磁盘页「只看异常盘」按单块盘过滤。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def test_toggle_exists():
    html = (TEMPLATES / "disk_health.html").read_text(encoding="utf-8")
    assert 'id="disk-only-bad"' in html
    assert "只看异常盘" in html


def test_row_level_filtering():
    js = (STATIC / "disk-health.js").read_text(encoding="utf-8")
    assert "var BAD_KEY = 'disk:onlyBad';" in js
    assert "function rowIsBad(row)" in js
    assert "return (health && health !== 'ok' && health !== 'healthy') || media > 0;" in js
    assert "var onlyBad = readOnlyBad();" in js
    assert "(onlyBad && !hasBadRow)" in js
    # 关闭筛选时要把行恢复显示，否则刷新后仍有行被藏着
    assert "row.hidden = false;" in js
