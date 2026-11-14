"""v0.1.191：概览卡片补充负载与运行时长。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def test_payload_exposes_load_and_uptime(tmp_path):
    from servermanage.web.routes import _metrics_payload

    payload = _metrics_payload(
        {
            "cpu_usage_percent": 12.5,
            "load_average": {"load_1": 4.53, "load_5": 4.33, "load_15": 4.37},
            "cpu_core_count": 64,
            "uptime": "497 days, 17:30",
        }
    )
    assert payload["load_1"] == 4.53
    assert payload["cpu_cores"] == 64
    assert payload["uptime"] == "497 days, 17:30"

    empty = _metrics_payload({})
    assert empty["load_1"] is None
    assert empty["cpu_cores"] == 0
    assert empty["uptime"] == ""


def test_card_renders_chips():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "loadChip.className = 'host-card-load';" in js
    assert "loadChip.textContent = '负载 ' + Number(host.load_1).toFixed(2);" in js
    assert "uptimeChipNode.className = 'host-card-uptime';" in js
    assert "uptimeChipNode.textContent = '运行 ' + String(host.uptime).split(',')[0];" in js
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.191 概览卡片补充负载与运行时长" in css
    assert ".host-card-load," in css
