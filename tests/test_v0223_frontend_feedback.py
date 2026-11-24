"""v0.1.223：前端反馈与轮询体验修复。

- 修复“刷新占用”按钮：users.js 的 fetchJson 此前丢弃请求体，
  后端永远收不到 usage: true，强制重扫目录占用从未生效；
- fetchJson 失败时解析响应体里的 error/detail，失败提示不再只有“请重试”；
- 30 秒轮询在数据未变化时跳过整表重建（悬停/选区不再丢失）；
- 窗口隐藏时暂停轮询，回到前台立即补一次；
- 排序表头支持键盘（Tab 聚焦 + Enter/空格）；
- “我的服务器”页不再直接展示原始 ISO 时间戳。
"""

from __future__ import annotations

from pathlib import Path
from _frontend import app_js_source

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def _read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# “刷新占用”按钮修复
# ---------------------------------------------------------------------------


def test_users_fetchjson_forwards_request_body():
    script = _read("users.js")
    assert "if (opts.body !== undefined) { base.body = opts.body; }" in script
    assert "headers['Content-Type'] = 'application/json'" in script


def test_refresh_usage_button_still_sends_usage_flag():
    script = _read("users.js")
    assert "body: JSON.stringify({ usage: !!forceUsage })" in script


def test_users_fetchjson_captures_server_error_detail():
    script = _read("users.js")
    assert "fetchJson.lastError" in script
    assert "payload.error || payload.detail || payload.message" in script


def test_users_refresh_failure_includes_server_reason():
    script = _read("users.js")
    assert "finishRefresh(detail ? '刷新失败：' + detail" in script


# ---------------------------------------------------------------------------
# app.js 错误透传与免闪烁渲染
# ---------------------------------------------------------------------------


def test_app_fetchjson_captures_error_detail_and_sets_json_type():
    script = _read("lib/api.js")
    assert "fetchJson.lastError" in script
    assert "payload.error || payload.detail || payload.message" in script
    # 请求体存在时自动补 JSON Content-Type（users.js 同步修复的同一约定）。
    assert "headers['Content-Type'] = 'application/json'" in script


def test_generic_failures_route_through_failtoast():
    script = app_js_source(STATIC)
    assert "function failToast(prefix, kind)" in script
    assert "failToast('批量确认失败')" in script
    assert "failToast('确认失败')" in script
    assert "failToast('静默失败')" in script
    assert "failToast('批量采集提交失败')" in script


def test_overview_skips_rebuild_when_unchanged():
    script = app_js_source(STATIC)
    assert "function payloadSignature(value)" in script
    assert "signature === payloadSignature(lastHosts)" in script


def test_alerts_skip_rebuild_when_payload_and_filters_unchanged():
    script = app_js_source(STATIC)
    assert "lastAlertsSig" in script
    assert "lastAlertsRendered" in script
    # 签名必须包含客户端筛选状态，避免筛选变化被误判为“无变化”。
    assert "alertStatus, alertKeyword, alertSeverity, alertHost, alertGroup," in script


# ---------------------------------------------------------------------------
# 隐藏暂停轮询 + 键盘排序
# ---------------------------------------------------------------------------


def test_refresh_all_pauses_when_hidden():
    script = app_js_source(STATIC)
    assert "if (document.hidden) { return; }" in script


def test_sort_headers_are_keyboard_reachable():
    script = app_js_source(STATIC)
    assert "heads[i].setAttribute('tabindex', '0')" in script
    assert "heads[i].setAttribute('role', 'button')" in script
    assert "event.key !== 'Enter' && event.key !== ' '" in script
    # 与点击排序同一个委托入口。
    assert "setHostSort(head.getAttribute('data-sort-key'))" in script


def test_my_page_formats_scan_timestamp():
    script = _read("my.js")
    assert "function formatStamp(value)" in script
    assert 'bits.push("采集于 " + formatStamp(host.last_scan_at))' in script
