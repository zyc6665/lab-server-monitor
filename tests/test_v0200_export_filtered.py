"""v0.1.200：磁盘健康导出 CSV 遵循当前筛选。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def test_export_skips_hidden_rows():
    js = (STATIC / "disk-health.js").read_text(encoding="utf-8")
    assert "var bodyRows = [];" in js
    assert "if (row.hidden) { return; }" in js
    assert "if (!bodyRows.length) { return; }" in js
    assert "lines = lines.concat(bodyRows);" in js


def test_export_keeps_host_filter():
    js = (STATIC / "disk-health.js").read_text(encoding="utf-8")
    # 被「只看异常主机」筛掉的主机整块不导出，这条逻辑要保留
    assert "if (block.getAttribute('data-disk-match') === '0') { return; }" in js
