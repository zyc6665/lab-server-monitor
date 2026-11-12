"""v0.1.130：主机详情展示 GPU 显存占用进程。"""

from __future__ import annotations

from pathlib import Path

from servermanage.parsers import parse_nvidia_smi_processes

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "servermanage" / "web" / "templates" / "host.html"
STYLE = ROOT / "servermanage" / "web" / "static" / "style.css"


def test_processes_sorted_by_memory_within_gpu():
    output = "0, 100, 800, /usr/bin/a\n0, 101, 4000, /usr/bin/b\n1, 102, 900, /usr/bin/c\n"
    rows = parse_nvidia_smi_processes(output)
    assert [row.pid for row in rows] == [101, 100, 102]
    assert rows[0].memory_used_mb == 4000


def test_template_renders_process_table():
    markup = TEMPLATE.read_text(encoding="utf-8")
    assert "<h3>占用显存的进程</h3>" in markup
    assert 'data-gpu-proc="{{ proc.pid }}"' in markup
    assert "共 {{ metrics.gpu_processes|length }} 个 · 合计 {{ proc_ns.total }} MB" in markup
    assert "当前没有进程占用显存" in markup
    assert "{{ proc.username or '—' }}" in markup


def test_style_truncates_long_commands():
    css = STYLE.read_text(encoding="utf-8")
    block = css[css.index("v0.1.130 GPU 显存占用进程"):]
    assert ".gpu-proc-head" in block
    assert ".gpu-proc-table td.gpu-proc-cmd" in block
    assert "text-overflow: ellipsis;" in block
