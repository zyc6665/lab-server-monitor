"""v0.1.103：概览主机行/卡片显示「N 项关注」徽标。"""

from __future__ import annotations

from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"


def test_attention_helpers_exist():
    script = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function hostAttentionReasons(host) {" in script
    assert "function attentionChip(host, compact) {" in script
    assert "var ATTENTION_LIMITS = { cpu: 90, memory: 90, disk: 90, gpu: 90, temperature: 70 };" in script


def test_reasons_cover_the_operator_surface():
    script = (STATIC / "app.js").read_text(encoding="utf-8")
    body = script.split("function hostAttentionReasons(host) {")[1].split("function attentionChip")[0]
    for token in ("项服务检查异常", "块盘严重", "块盘告警", "温度 ", "条活动告警"):
        assert token in body
    assert "主机离线或未采集" not in body  # 状态列已表达离线，不重复


def test_chip_rendered_in_table_and_cards():
    script = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "var rowAttention = attentionChip(host, true);" in script
    assert "var cardAttention = attentionChip(host);" in script
    # 表格里放在状态列，避免名称列换行把行高撑高
    status_block = script.split("var statusCell = document.createElement('td');")[1].split("tr.appendChild(statusCell);")[0]
    assert "rowAttention" in status_block


def test_chip_styles_including_dark_theme():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css.split("v0.1.103 概览需关注徽标")[1]
    assert ".attention-chip {" in tail
    assert ".attention-chip.is-critical {" in tail
    assert ".attention-chip.is-compact {" in tail
    assert 'html[data-theme="dark"] .attention-chip {' in tail
    assert 'html[data-theme="dark"] .attention-chip.is-critical {' in tail
