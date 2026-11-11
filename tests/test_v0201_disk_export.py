"""v0.1.101：磁盘健康页导出 CSV。"""

from __future__ import annotations

from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"
TEMPLATES = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "templates"


def test_template_has_export_button():
    html = (TEMPLATES / "disk_health.html").read_text(encoding="utf-8")
    assert 'id="disk-export"' in html
    assert "导出 CSV" in html
    # 按钮只在有盘时出现
    assert "{% if drives %}" in html.split('id="disk-export"')[0][-80:]


def test_script_builds_and_downloads_csv():
    script = (STATIC / "disk-health.js").read_text(encoding="utf-8")
    assert "function csvCell(value)" in script
    assert script.count("replace(/\"/g, '\"\"')") == 1
    assert "function collectCsv()" in script
    assert "'\\ufeff'" in script
    assert "text/csv;charset=utf-8" in script
    assert "disk-health-" in script
    assert "已导出 " in script


def test_export_skips_hidden_hosts():
    script = (STATIC / "disk-health.js").read_text(encoding="utf-8")
    body = script.split("function collectCsv()")[1].split("function exportCsv")[0]
    assert "if (block.hidden) { return; }" in body
    assert "querySelectorAll('tbody tr')" in body


def test_styles_cover_export_button():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css.split("v0.1.101 磁盘健康导出 CSV")[1]
    assert "#disk-groups .section-head .disk-export" in tail
    assert 'html[data-theme="dark"] #disk-groups .disk-export' in tail
