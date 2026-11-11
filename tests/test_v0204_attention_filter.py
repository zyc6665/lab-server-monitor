"""v0.1.104：概览状态筛选新增「需关注」。"""

from __future__ import annotations

from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"
TEMPLATES = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "templates"


def test_status_filter_has_attention_option():
    html = (TEMPLATES / "overview.html").read_text(encoding="utf-8")
    block = html.split('id="filter-status"')[1].split("</select>")[0]
    assert '<option value="attention">需关注</option>' in block
    # 顺序：有告警 → 需关注 → 静默
    assert block.index('value="alert"') < block.index('value="attention"') < block.index('value="silenced"')


def test_rows_and_cards_carry_attention_count():
    script = (STATIC / "app.js").read_text(encoding="utf-8")
    assert script.count("setAttribute('data-attention', hostAttentionReasons(host).length);") == 2


def test_matcher_filters_by_attention():
    script = (STATIC / "app.js").read_text(encoding="utf-8")
    body = script.split("function hostRowMatches(tr, group, status, keyword) {")[1].split("function applyHostFilters")[0]
    assert "if (status === 'attention' && Number(tr.getAttribute('data-attention') || 0) <= 0) { return false; }" in body
