"""v0.1.150：概览显存徽标与告警/算力页的主机名跳转。"""

from __future__ import annotations

from pathlib import Path

from servermanage.web.routes import _gpu_memory_totals

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_gpu_memory_totals():
    metrics = {
        "gpu_summary": [
            {"index": 0, "memory_used_mb": 30000, "memory_total_mb": 81920},
            {"index": 1, "memory_used_mb": 10000, "memory_total_mb": 81920},
        ]
    }
    assert _gpu_memory_totals(metrics) == (40000.0, 163840.0)
    assert _gpu_memory_totals({"gpu_summary": []}) is None
    assert _gpu_memory_totals({}) is None
    # 坏数据不该把整行搞崩
    assert _gpu_memory_totals({"gpu_summary": [{"memory_total_mb": "x"}]}) is None


def test_overview_rows_expose_gpu_memory():
    routes = (ROOT / "servermanage" / "web" / "routes.py").read_text(encoding="utf-8")
    assert "def _gpu_memory_totals(" in routes
    assert routes.count('"gpu_memory": _gpu_payload(gpu_totals)') == 2  # 无快照与正常两条返回


def test_frontend_and_pages_link_hosts():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function gpuMemoryChip(memory)" in js
    assert "chip.className = 'gpu-chip'" in js
    assert js.count("gpuMemoryChip(host.gpu_memory)") == 2
    assert "hostLink.setAttribute('href', '/host/' + encodeURIComponent(alert.host_name));" in js

    compute = (TEMPLATES / "compute.html").read_text(encoding="utf-8")
    assert "url_for('host_page', name=host_name)" in compute

    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.150 概览显存徽标与主机名链接 -- */" in css
    assert ".gpu-chip {" in css
    assert "a.host-link {" in css
    assert '[data-theme="dark"] .gpu-chip {' in css
