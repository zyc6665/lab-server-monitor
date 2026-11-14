"""v0.1.199：磁盘页分组可一键全部折叠 / 展开。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_template_has_toggle():
    html = (TEMPLATES / "disk_health.html").read_text(encoding="utf-8")
    assert 'id="disk-groups-toggle"' in html
    assert "全部折叠" in html
    # 按钮默认隐藏，靠脚本在有分组时显出来
    assert 'id="disk-groups-toggle" hidden' in html


def test_script_wires_toggle():
    js = (STATIC / "disk-health.js").read_text(encoding="utf-8")
    assert "function updateGroupsToggle()" in js
    assert "function setAllGroupsCollapsed(collapsed)" in js
    assert "saveGroups(collapsed ? names.filter(Boolean) : []);" in js
    assert "setAllGroupsCollapsed(!allCollapsed);" in js
    assert "button.textContent = collapsed.length === heads.length ? '全部展开' : '全部折叠';" in js


def test_style_present():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.199" in css
    assert ".disk-groups-toggle" in css
