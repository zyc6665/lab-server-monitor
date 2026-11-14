"""v0.1.197：点任意一块盘弹出完整字段详情。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def test_dialog_markup():
    html = (TEMPLATES / "disk_health.html").read_text(encoding="utf-8")
    assert 'id="disk-drive-dialog"' in html
    assert 'id="disk-drive-body"' in html
    assert "数据来自最近一次 storcli 采集" in html


def test_dialog_logic():
    js = (STATIC / "disk-health.js").read_text(encoding="utf-8")
    assert "v0.1.197 单块磁盘详情" in js
    assert "tr[data-disk-row]" in js
    assert "dialog.showModal()" in js
    # 点链接或按钮时不要弹详情，避免抢走导航
    assert "if (event.target.closest('a, button')) { return; }" in js
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.197 单块磁盘详情" in css
    assert ".disk-drive-dialog" in css
