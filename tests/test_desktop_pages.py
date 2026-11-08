"""Page-level tests for the v1.4 desktop client restyle (Task 7).

These render the real Flask app for the overview, host detail and alerts pages
and pin the new UI contract:

* overview: four statistic cards (主机总数/在线/离线/活动告警) fed by
  ``/api/overview``, a per-host 操作 column with a ``/terminal?host=<name>``
  link, and the existing group/status/keyword filter bar;
* host detail: an 打开终端 primary button plus the 磁盘阵列 and 当前登录用户
  cards;
* alerts: active/all status filters and the existing ack button.

``app.js`` is also inspected as source to keep the polling/terminal/filter
behaviour from silently regressing.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from servermanage.disk_health import DiskHealthReport, PhysicalDriveInfo
from servermanage.models import (
    AppConfig,
    AppRuntimeConfig,
    AuthConfig,
    DashboardAuthConfig,
    DashboardConfig,
    DiskUsageRow,
    GPUSummaryRow,
    HostConfig,
    HostMetrics,
    HostReport,
    LoggedInUser,
    MemorySummary,
    ReportConfig,
    SSHRuntimeConfig,
)
from servermanage.storage import (
    insert_alert,
    save_disk_health,
    save_host_snapshot,
)
from servermanage.disk_health import AlertEvent
from servermanage.web import create_app

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"

HOST_NAME = "gpu-01"
HOST_ADDRESS = "10.0.0.1"


def _make_config(**overrides) -> AppConfig:
    return AppConfig(
        smtp=None,
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        report=ReportConfig(subject_prefix="[Test]"),
        servers=[
            HostConfig(
                name=HOST_NAME,
                host=HOST_ADDRESS,
                port=22,
                username="monitor",
                auth=AuthConfig(type="password", password="ssh-pw"),
                group="GPU",
                owner="alice",
                location="A-101",
            )
        ],
        app=AppRuntimeConfig(poll_interval_seconds=600),
        dashboard=DashboardConfig(
            auth=DashboardAuthConfig(
                enabled=True,
                username="admin",
                password_env=None,
                password="pw",
            ),
            session_secret="test-secret",
        ),
    )


def _memory() -> MemorySummary:
    return MemorySummary(
        total_mb=16384,
        used_mb=4096,
        free_mb=12288,
        shared_mb=0,
        buff_cache_mb=0,
        available_mb=12288,
        swap_total_mb=0,
        swap_used_mb=0,
        swap_free_mb=0,
    )


def _seed_database(db_path: Path) -> None:
    now = datetime.now(timezone.utc)
    save_host_snapshot(
        HostReport(
            host_name=HOST_NAME,
            host=HOST_ADDRESS,
            success=True,
            metrics=HostMetrics(
                collected_at=now,
                cpu_usage_percent=42.5,
                logged_in_users=[
                    LoggedInUser(
                        username="alice",
                        terminal="pts/0",
                        login_at="2026-11-06 09:00",
                        remote_host="10.0.0.9",
                    )
                ],
                memory=_memory(),
                disk_usage=[
                    DiskUsageRow(
                        filesystem="/dev/sda1",
                        size="100G",
                        used="45G",
                        available="55G",
                        percent="45%",
                        mountpoint="/",
                    )
                ],
                gpu_summary=[
                    GPUSummaryRow(
                        index=0,
                        name="NVIDIA A100",
                        utilization_percent=10,
                        temperature_c=40,
                        memory_used_mb=2048,
                        memory_total_mb=8192,
                    )
                ],
            ),
        ),
        db_path,
    )
    save_disk_health(
        DiskHealthReport(
            host_name=HOST_NAME,
            collected_at=now,
            status="warning",
            message="1 drive needs attention",
            physical_drives=[
                PhysicalDriveInfo(
                    controller=0,
                    enclosure=252,
                    slot=0,
                    state="Onln",
                    model="ST1000NM0011",
                    serial="SN0001",
                    health="healthy",
                )
            ],
        ),
        db_path,
    )
    insert_alert(
        AlertEvent(
            host_name=HOST_NAME,
            category="system",
            severity="warning",
            title="CPU 使用率过高",
            message="CPU 使用率 95% 超过阈值",
            fingerprint=f"system:{HOST_NAME}:cpu",
        ),
        db_path,
    )
    insert_alert(
        AlertEvent(
            host_name="other-01",
            category="disk",
            severity="critical",
            title="其他主机专用告警",
            message="不应出现在 gpu-01 页面",
            fingerprint="disk:other-01:root",
        ),
        db_path,
    )


@pytest.fixture()
def client(tmp_path):
    db_path = tmp_path / "desktop-pages.db"
    _seed_database(db_path)
    app = create_app(config=_make_config(), db_path=db_path)
    app.config.update(TESTING=True)
    test_client = app.test_client()
    response = test_client.post(
        "/login", data={"username": "admin", "password": "pw"}
    )
    assert response.status_code == 302
    return test_client


def _page(client, path: str) -> str:
    response = client.get(path)
    assert response.status_code == 200, f"{path} -> {response.status_code}"
    return response.get_data(as_text=True)


# -- overview ---------------------------------------------------------------


def test_overview_has_four_statistic_cards(client):
    html = _page(client, "/")
    for label in ("主机总数", "在线", "离线", "活动告警"):
        assert label in html
    for element_id in (
        "summary-total",
        "summary-online",
        "summary-offline",
        "summary-alerts",
    ):
        assert f'id="{element_id}"' in html


def test_overview_host_row_has_terminal_link(client):
    html = _page(client, "/")
    assert ">操作</th>" in html
    assert f"/terminal?host={HOST_NAME}" in html
    assert "终端" in html


def test_host_rows_have_quick_collect_and_percent_meters(client):
    for path in ("/", "/hosts"):
        html = _page(client, path)
        assert f'class="btn-link host-collect" data-host-name="{HOST_NAME}"' in html
        assert 'class="pct-meter"' in html
        assert 'class="pct-meter-fill"' in html
        assert 'class="pct-value"' in html
        assert 'id="collect-abnormal-hosts"' in html
        assert 'id="collect-all-hosts"' in html
        assert 'id="export-fleet-report"' in html
        assert "巡检报告" in html
        assert 'id="export-hosts"' in html
        assert "导出 CSV" in html


def test_overview_has_resource_ranking_card(client):
    html = _page(client, "/")
    assert 'id="resource-rank"' in html
    assert "资源占用排行" in html
    assert 'id="resource-rank-list"' in html
    for metric in ("cpu", "memory", "disk", "gpu"):
        assert f'data-rank-metric="{metric}"' in html


def test_overview_keeps_filter_bar_and_host_columns(client):
    html = _page(client, "/")
    assert 'id="host-filter"' in html
    assert 'id="filter-group"' in html
    assert 'id="filter-status"' in html
    assert 'id="filter-keyword"' in html
    for column in ("名称", "地址", "分组", "负责人", "状态", "CPU", "内存", "磁盘"):
        assert f">{column}</th>" in html


# -- host detail ------------------------------------------------------------


def test_host_page_has_terminal_button(client):
    html = _page(client, f"/host/{HOST_NAME}")
    assert "打开终端" in html
    assert f"/terminal?host={HOST_NAME}" in html


def test_host_page_keeps_disk_array_and_logged_in_users(client):
    html = _page(client, f"/host/{HOST_NAME}")
    assert "磁盘阵列" in html
    assert "当前登录用户" in html
    # controller / virtual drive / physical drive sections live inside the array card
    assert "控制器" in html
    assert "Virtual Drives" in html
    assert "Physical Drives" in html


def test_host_page_has_diagnostic_report_button(client):
    html = _page(client, f"/host/{HOST_NAME}")
    assert 'id="host-report-button"' in html
    assert f"/api/host/{HOST_NAME}/report" in html
    assert "导出诊断报告" in html


def test_host_page_has_recent_alerts_tab(client):
    html = _page(client, f"/host/{HOST_NAME}")
    assert 'data-host-tab="alerts"' in html
    assert 'id="host-alerts"' in html
    assert "最近告警" in html
    assert "CPU 使用率过高" in html
    assert "其他主机专用告警" not in html
    assert 'class="ack-btn" data-alert-id=' in html


def test_host_report_download_contains_diagnostics(client):
    response = client.get(f"/api/host/{HOST_NAME}/report")
    assert response.status_code == 200
    disposition = response.headers.get("Content-Disposition", "")
    assert "attachment" in disposition
    assert "host-report-gpu-01-" in disposition
    assert disposition.endswith('.txt"') or disposition.endswith(".txt")
    text = response.get_data(as_text=True)
    assert text.startswith("﻿")
    assert "服务器轮询监测 · 主机诊断报告" in text
    assert f"主机名称：{HOST_NAME}" in text
    assert "CPU 使用率：42.5%" in text
    assert "1 drive needs attention" in text
    assert "磁盘阵列状态为 warning" in text
    assert "[最近告警]" in text
    assert "CPU 使用率过高" in text


def test_fleet_report_download_contains_summary_and_hosts(client):
    response = client.get("/api/overview/report")
    assert response.status_code == 200
    disposition = response.headers.get("Content-Disposition", "")
    assert "attachment" in disposition
    assert "fleet-report-" in disposition
    assert disposition.endswith('.txt"') or disposition.endswith(".txt")
    text = response.get_data(as_text=True)
    assert text.startswith("﻿")
    assert "服务器轮询监测 · 全网巡检报告" in text
    assert "主机总数：1" in text
    assert "采集成功：1" in text
    assert "活动告警：1" in text
    assert "磁盘阵列异常：1" in text
    assert "[主机摘要]" in text
    assert f"{HOST_NAME} | {HOST_ADDRESS} | GPU | 状态 成功" in text
    assert f"【主机 1/1】{HOST_NAME}" in text
    assert "CPU 使用率：42.5%" in text
    assert "CPU 使用率过高" in text
    assert "报告由服务器轮询监测工具自动生成" in text


def test_global_command_palette_is_available(client):
    page = client.get("/")
    html = page.get_data(as_text=True)
    assert 'id="command-trigger"' in html
    assert 'id="command-palette"' in html
    assert 'id="command-input"' in html
    assert 'id="command-results"' in html
    assert "command-palette.js?v=" in html

    script = client.get("/static/command-palette.js")
    assert script.status_code == 200
    js = script.get_data(as_text=True)
    assert "function openPalette" in js
    assert "function closePalette" in js
    assert "function buildItems" in js
    assert "/api/overview" in js
    assert "/api/alerts?status=active" in js
    assert "function alertMatches" in js
    assert "'/alerts' +" in js
    assert "host=" in js
    assert "alertParams" in js
    assert "var ACTIONS" in js
    assert "function runAction" in js
    assert "function actionAvailable" in js
    assert "刷新当前页" in js
    assert "切换深浅色主题" in js
    assert "采集全部主机" in js
    assert "采集异常主机" in js
    assert "window.serverMonitorActions" in js
    assert "event.ctrlKey || event.metaKey" in js
    assert "ArrowDown" in js
    assert "Escape" in js
    app_js = client.get("/static/app.js").get_data(as_text=True)
    assert "window.serverMonitorActions" in app_js
    assert "collectAll: function" in app_js
    assert "collectAbnormal: function" in app_js

    css = client.get("/static/style.css").get_data(as_text=True)
    assert ".command-dialog" in css
    assert ".command-item.active" in css


def test_static_assets_are_versioned(client):
    html = _page(client, "/")
    assert "/static/style.css?v=" in html
    assert "/static/app.js?v=" in html


# -- alerts -----------------------------------------------------------------


def test_alerts_page_has_status_filters_and_ack(client):
    html = _page(client, "/alerts")
    assert 'id="alert-status-filter"' in html
    assert 'data-status="active"' in html
    assert 'data-status="all"' in html
    assert 'id="alert-host-filter"' in html
    assert 'id="alert-range-filter"' in html
    assert 'value="24h"' in html
    assert 'value="7d"' in html
    assert 'value="30d"' in html
    assert "全部主机" in html
    assert "全部时间" in html
    assert "活动" in html
    assert "全部" in html
    assert "ack-btn" in html
    assert "确认" in html


# -- app.js / style ---------------------------------------------------------


def test_alerts_page_supports_query_and_severity_deep_links(client):
    html = _page(client, "/alerts?q=cpu&severity=critical&host=gpu-01&range=7d")
    assert 'value="cpu"' in html
    assert 'value="critical" selected' in html
    assert 'value="gpu-01" selected' in html
    assert 'value="7d" selected' in html
    source = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "alertSearch.value" in source
    assert "alertSeverityFilter.value" in source
    assert "alertHostFilter.value" in source
    assert "alertRangeFilter.value" in source
    assert "alertTimeRange" in source
    assert "range=" in source
    assert "alertHost &&" in source


def test_app_js_keeps_terminal_and_filter_logic():
    source = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "/terminal?host=" in source
    assert "summary-total" in source
    assert "applyHostFilters" in source
    assert "filter-keyword" in source
    assert "ack-btn" in source
    assert "30000" in source or "REFRESH_MS" in source
    assert "function percentCell" in source
    assert "function collectHost" in source
    assert "function collectAllHosts" in source
    assert "function collectAbnormalHosts" in source
    assert "function collectHosts" in source
    assert "pollHostCollection" in source
    assert "pollHostsCollection" in source
    assert "/api/settings/hosts/collect" in source
    assert "/api/settings/hosts/" in source
    assert "function exportHostsCsv" in source
    assert "'\\ufeff'" in source
    assert "hosts-" in source
    assert "没有可导出的主机" in source
    assert "function renderResourceRanking" in source
    assert "function setResourceRankMetric" in source
    assert "function bindResourceRankTabs" in source
    assert "resource-rank-list" in source
    assert "resourceRankValue" in source


def test_host_detail_js_binds_alert_ack():
    source = (STATIC / "host-detail.js").read_text(encoding="utf-8")
    assert "function bindAlertAcks" in source
    assert "/api/alerts/" in source
    assert "status-acknowledged" in source
    assert "bindAlertAcks();" in source


def test_app_js_renders_terminal_link_without_user_innerhtml():
    source = (STATIC / "app.js").read_text(encoding="utf-8")
    # Terminal link must be built with DOM APIs + textContent, never innerHTML
    # fed from host data.
    assert "innerHTML" not in source
