"""v0.1.266：诊断摘要复制带上主机地址、总体结论，并在失败时如实提示。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def test_section_carries_summary_attributes():
    page = (TEMPLATES / "host.html").read_text(encoding="utf-8")
    assert 'data-host-address="{{ detail.host or \'\' }}"' in page
    assert 'data-host-status="{{ detail.status }}"' in page
    assert "data-attention=" in page


def test_copy_text_has_verdict_and_address():
    js = (STATIC / "host-detail.js").read_text(encoding="utf-8")
    assert "var verdict = attention > 0 ? attention + ' 项需关注' : '全部正常';" in js
    assert "var where = address ? hostName + '（' + address + '）' : hostName;" in js
    assert "'主机健康诊断 · ' + where + ' · ' + verdict" in js


def test_copy_failure_is_reported():
    js = (STATIC / "host-detail.js").read_text(encoding="utf-8")
    assert "button.textContent = '复制失败';" in js
    assert "navigator.clipboard.writeText(text).then(done, failed);" in js
