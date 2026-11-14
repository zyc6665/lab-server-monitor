"""v0.1.198：主机详情历史趋势可导出 CSV。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def test_export_button():
    html = (TEMPLATES / "host.html").read_text(encoding="utf-8")
    assert 'id="trend-export"' in html
    assert "导出 CSV" in html
    assert 'data-history-range="30d"' in html


def test_export_logic():
    js = (STATIC / "host-detail.js").read_text(encoding="utf-8")
    assert "function trendCsv()" in js
    assert "function exportTrend()" in js
    assert "function csvCell(value)" in js
    assert "historyPoints = points;" in js
    assert "bindTrendExport();" in js
    # 导出要带主机名与时间范围，便于区分文件
    assert "'-trend-' + historyRange + '-'" in js
