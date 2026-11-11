"""v0.1.122：概览「需关注」原因按影响面排序。"""

from __future__ import annotations

from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static" / "app.js"


def _script() -> str:
    return SCRIPT.read_text(encoding="utf-8")


def test_weights_declared():
    script = _script()
    assert "var ATTENTION_WEIGHTS = {" in script
    for key in ("checks", "diskHealth", "temperature", "disk", "memory", "cpu", "gpu", "alerts"):
        assert key + ":" in script


def test_reasons_are_sorted_by_weight():
    script = _script()
    assert "entries.sort(function (a, b) { return b.weight - a.weight; });" in script
    assert "return entries.map(function (entry) { return entry.text; });" in script


def test_hard_failures_outrank_usage():
    script = _script()
    assert "add(ATTENTION_WEIGHTS.checks," in script
    assert "add(ATTENTION_WEIGHTS.diskHealth + 5," in script
    assert "add(ATTENTION_WEIGHTS.alerts," in script
    block_start = script.index("var ATTENTION_WEIGHTS = {")
    block = script[block_start:script.index("};", block_start)]
    weights = {}
    for key in ("checks", "diskHealth", "temperature", "disk", "memory", "cpu", "gpu", "alerts"):
        marker = key + ": "
        start = block.index(marker) + len(marker)
        end = block.index(",", start)
        weights[key] = int(block[start:end].strip())
    assert weights["checks"] > weights["diskHealth"] > weights["temperature"]
    assert weights["disk"] > weights["memory"] > weights["cpu"] > weights["gpu"] > weights["alerts"]
