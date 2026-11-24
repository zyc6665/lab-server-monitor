"""v0.1.182：关注项原因可以点进主机对应分区。"""

from __future__ import annotations

from pathlib import Path
from _frontend import app_js_source

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def test_reasons_link_to_anchor():
    js = app_js_source(STATIC)
    assert "function attentionAnchor(reason)" in js
    assert "return 'tab-checks';" in js
    assert "return 'tab-storage';" in js
    assert "return 'tab-alerts';" in js
    assert "link.href = '/host/' + encodeURIComponent(hostName) + '#' + attentionAnchor(reason);" in js


def test_link_style():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert ".attention-pop .attention-link" in css
    assert "border-bottom: 1px dashed transparent" in css
