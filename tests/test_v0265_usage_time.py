"""v0.1.165：用户页显示每台主机的占用统计时间。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROUTES = ROOT / "servermanage" / "web" / "routes.py"
USERS_JS = ROOT / "servermanage" / "web" / "static" / "users.js"


def test_payload_exposes_last_usage_at():
    source = ROUTES.read_text(encoding="utf-8")
    # 正常分支与「监控关闭」分支都要有，否则页面字段会 undefined
    assert source.count('"last_usage_at": _to_local_iso((state or {}).get("last_usage_at"), tz),') == 1
    assert source.count('"last_usage_at": None,') == 1


def test_host_card_shows_usage_time():
    js = USERS_JS.read_text(encoding="utf-8")
    assert "'占用统计 ' + formatTimestamp(host.last_usage_at)" in js
    assert ": '占用未统计');" in js
    assert "' · 占用 ' + formatTimestamp(host.last_usage_at)" in js
