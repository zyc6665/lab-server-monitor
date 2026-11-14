"""v0.1.194：批量确认改为就地更新，避免整表刷新。"""

from __future__ import annotations

from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"


def test_bulk_ack_updates_in_place():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function applyBulkAckInPlace(ids)" in js
    start = js.index("function bulkAckSelected()")
    body = js[start:start + 900]
    assert "applyBulkAckInPlace(ids);" in body
    assert "refreshAlerts();" not in body


def test_bulk_ack_keeps_local_state_consistent():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    body = js.split("function applyBulkAckInPlace(ids)")[1].split("function bulkAckSelected()")[0]
    # 本地数据、状态计数、顶部计数、时间分布都要跟着走，否则界面自相矛盾
    assert "lastAlerts[i].status = 'acknowledged';" in body
    assert "setCount('alert-status-count-active', -acked);" in body
    assert "setCount('alert-status-count-acknowledged', acked);" in body
    assert "setText('alert-count'," in body
    assert "renderAlertTimeline(filteredAlerts(true));" in body
