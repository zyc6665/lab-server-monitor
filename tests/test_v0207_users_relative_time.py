"""v0.1.207：用户页采集时间改用相对时长。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def _js() -> str:
    return (STATIC / "users.js").read_text(encoding="utf-8")


def test_relative_helper_is_defined_before_use():
    js = _js()
    assert "function relativeTime(value)" in js
    assert js.index("function relativeTime(value)") < js.index("function formatTimestamp(value)")
    for branch in ["'刚刚'", "' 分钟前'", "' 小时前'", "' 天前'"]:
        assert branch in js


def test_host_card_uses_relative_time_with_absolute_title():
    js = _js()
    assert "'采集 ' + relativeTime(host.last_scan_at)" in js
    assert "seen.title = '上次采集：' + formatTimestamp(host.last_scan_at)" in js


def test_detail_meta_uses_relative_time():
    js = _js()
    assert "parts.push('采集 ' + relativeTime(host.last_scan_at))" in js
