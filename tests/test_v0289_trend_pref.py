"""v0.1.189：概览趋势的时间范围与主机选择会被记住。"""

from __future__ import annotations

from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"


def test_preference_helpers_exist():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "var TREND_PREF_KEY = 'overview:trend';" in js
    assert "var TREND_RANGES = ['24h', '7d', '30d', '90d'];" in js
    assert "function readTrendPref()" in js
    assert "function saveTrendPref()" in js
    assert "range: overviewHistory.range || '24h'," in js


def test_restores_and_persists():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    # 初始化时按存储恢复页签与主机
    assert "var initialRange = pref && pref.range ? pref.range : '24h';" in js
    assert "tab.classList.toggle('active', tab.getAttribute('data-overview-range') === initialRange);" in js
    assert "trendHostPref = pref && pref.host ? pref.host : '';" in js
    # 主机下拉重建后仍能选回之前那台
    assert "if (!keep && trendHostPref) {" in js
    # 写入必须发生在 overviewHistory 更新之后，否则会存到上一轮的范围
    body = js.split("function loadOverviewHistory(rangeKey)")[1].split("function overviewPointLabel")[0]
    assert body.index("overviewHistory = { range: rangeKey") < body.index("saveTrendPref();")
