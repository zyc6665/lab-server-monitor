"""v0.1.105：磁盘健康页按主机折叠盘位明细。"""

from __future__ import annotations

import re
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"
TEMPLATES = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "templates"


def test_header_has_collapse_toggle():
    html = (TEMPLATES / "disk_health.html").read_text(encoding="utf-8")
    assert 'class="disk-collapse" data-disk-collapse' in html
    assert 'aria-expanded="true"' in html
    assert "展开 / 收起盘位明细" in html
    # 折叠按钮位于主机名之前，属于 disk-host-id
    head = html.split('class="disk-host-head"')[1].split("</header>")[0]
    assert head.index("data-disk-collapse") < head.index("{{ host.name }}")


def test_script_toggles_body_visibility():
    script = (STATIC / "disk-health.js").read_text(encoding="utf-8")
    body = script.split("function setCollapsed")[1]
    assert "block.querySelector('.table-wrap') || block.querySelector('.empty')" in body
    assert "body.hidden = collapsed;" in body
    assert "block.classList.toggle('is-collapsed', collapsed);" in body
    assert "button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');" in body
    assert "document.addEventListener('click', function (event) {" in script
    assert "event.target.closest('[data-disk-collapse]')" in script


def test_styles_mark_collapsed_blocks():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css.split("v0.1.105 磁盘按主机折叠")[1]
    assert ".disk-collapse {" in tail
    assert ".disk-host.is-collapsed .disk-host-head { border-bottom-color: transparent; }" in tail
    assert 'html[data-theme="dark"] .disk-collapse:hover' in tail
