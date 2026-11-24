"""Characterization lock for the dashboard's public endpoint names.

M1 splits the monolithic ``web/routes.py`` into per-domain modules.  Templates
and the Electron client address these endpoints by their *bare* names, so the
split must preserve every name, rule and method exactly.  This test fails if a
refactor lets Flask prefix an endpoint (e.g. via a Blueprint) or renames one.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from servermanage.models import (
    AppConfig,
    AppRuntimeConfig,
    AuthConfig,
    DashboardAuthConfig,
    DashboardConfig,
    ReportConfig,
    SSHRuntimeConfig,
)
from servermanage.web import create_app


# (endpoint, rule, methods) — captured from the pre-split app.url_map.
EXPECTED_ENDPOINTS: frozenset[tuple[str, str, frozenset[str]]] = frozenset(
    {
        ("alerts_page", "/alerts", frozenset({"GET"})),
        ("api_ack_alert", "/api/alerts/<int:alert_id>/ack", frozenset({"POST"})),
        ("api_add_silence", "/api/settings/silences", frozenset({"POST"})),
        ("api_alerts", "/api/alerts", frozenset({"GET"})),
        ("api_change_password", "/api/settings/password", frozenset({"POST"})),
        ("api_collect_saved_host", "/api/settings/hosts/<name>/collect", frozenset({"POST"})),
        ("api_collect_saved_hosts", "/api/settings/hosts/collect", frozenset({"POST"})),
        ("api_compute", "/api/compute", frozenset({"GET"})),
        ("api_copy_host", "/api/settings/hosts/<name>/copy", frozenset({"POST"})),
        ("api_delete_host", "/api/settings/hosts/<name>", frozenset({"DELETE"})),
        ("api_delete_silence", "/api/settings/silences/<int:silence_id>", frozenset({"DELETE"})),
        ("api_get_settings", "/api/settings", frozenset({"GET"})),
        ("api_host", "/api/host/<name>", frozenset({"GET"})),
        ("api_host_collection_status", "/api/settings/hosts/collection-status", frozenset({"GET"})),
        ("api_host_container_stats", "/api/host/<name>/containers/stats", frozenset({"POST"})),
        ("api_host_history", "/api/host/<name>/history", frozenset({"GET"})),
        ("api_host_report", "/api/host/<name>/report", frozenset({"GET"})),
        ("api_import_hosts", "/api/settings/hosts/import", frozenset({"POST"})),
        ("api_list_hosts", "/api/settings/hosts", frozenset({"GET"})),
        ("api_list_silences", "/api/settings/silences", frozenset({"GET"})),
        ("api_logs", "/api/logs", frozenset({"GET"})),
        ("api_logs_download", "/api/logs/download", frozenset({"GET"})),
        ("api_my_summary", "/api/my/summary", frozenset({"GET"})),
        ("api_overview", "/api/overview", frozenset({"GET"})),
        ("api_overview_alert_history", "/api/overview/alert-history", frozenset({"GET"})),
        ("api_overview_capacity", "/api/overview/capacity", frozenset({"GET"})),
        ("api_overview_history", "/api/overview/history", frozenset({"GET"})),
        ("api_overview_report", "/api/overview/report", frozenset({"GET"})),
        ("api_preview_host_import", "/api/settings/hosts/import/preview", frozenset({"POST"})),
        ("api_probe_saved_host", "/api/settings/hosts/<name>/probe", frozenset({"POST"})),
        ("api_put_settings_section", "/api/settings/<section>", frozenset({"PUT"})),
        ("api_run_host_checks", "/api/host/<name>/checks/run", frozenset({"POST"})),
        ("api_runtime", "/api/runtime", frozenset({"GET"})),
        ("api_ssh_config_import", "/api/settings/hosts/ssh-config/import", frozenset({"POST"})),
        ("api_ssh_config_preview", "/api/settings/hosts/ssh-config", frozenset({"GET"})),
        ("api_system_backup", "/api/system/backup", frozenset({"GET"})),
        ("api_system_config_export", "/api/system/config-export", frozenset({"GET"})),
        ("api_system_health", "/api/system/health", frozenset({"GET"})),
        ("api_system_host_key_forget", "/api/system/host-keys/<hostname>", frozenset({"DELETE"})),
        ("api_system_host_keys", "/api/system/host-keys", frozenset({"GET"})),
        ("api_system_maintenance", "/api/system/maintenance", frozenset({"POST"})),
        ("api_system_restore", "/api/system/restore", frozenset({"POST"})),
        ("api_system_storage", "/api/system/storage", frozenset({"GET"})),
        ("api_test_desktop", "/api/settings/test-desktop", frozenset({"POST"})),
        ("api_test_email", "/api/settings/test-email", frozenset({"POST"})),
        ("api_test_hosts_batch", "/api/settings/hosts/test-batch", frozenset({"POST"})),
        ("api_test_saved_host_check", "/api/settings/hosts/<name>/checks/test", frozenset({"POST"})),
        ("api_test_ssh", "/api/settings/test-ssh", frozenset({"POST"})),
        ("api_test_webhook", "/api/settings/test-webhook", frozenset({"POST"})),
        ("api_upsert_host", "/api/settings/hosts/<name>", frozenset({"PUT"})),
        ("api_users", "/api/users", frozenset({"GET"})),
        ("api_users_baseline_remove", "/api/users/baseline/remove", frozenset({"POST"})),
        ("api_users_execute", "/api/users/execute", frozenset({"POST"})),
        ("api_users_execute_status", "/api/users/execute/status", frozenset({"GET"})),
        ("api_users_history", "/api/users/history", frozenset({"GET"})),
        ("api_users_operations", "/api/users/operations", frozenset({"GET"})),
        ("api_users_plan", "/api/users/plan", frozenset({"POST"})),
        ("api_users_refresh", "/api/users/refresh", frozenset({"POST"})),
        ("api_users_refresh_status", "/api/users/refresh-status", frozenset({"GET"})),
        ("api_users_top", "/api/users/top", frozenset({"GET"})),
        ("compute_page", "/compute", frozenset({"GET"})),
        ("create_ssh_session", "/api/ssh/sessions", frozenset({"POST"})),
        ("disk_health_page", "/disk-health", frozenset({"GET"})),
        ("host_page", "/host/<name>", frozenset({"GET"})),
        ("hosts_page", "/hosts", frozenset({"GET"})),
        ("login", "/login", frozenset({"GET"})),
        ("login_submit", "/login", frozenset({"POST"})),
        ("logout", "/logout", frozenset({"POST"})),
        ("my_page", "/my", frozenset({"GET"})),
        ("overview_page", "/", frozenset({"GET"})),
        ("probe_host_settings", "/api/settings/hosts/probe", frozenset({"POST"})),
        ("settings_page", "/settings", frozenset({"GET"})),
        ("setup", "/setup", frozenset({"GET", "POST"})),
        ("ssh_terminal_close", "/api/ssh/sessions/<session_id>", frozenset({"DELETE"})),
        ("ssh_terminal_input", "/api/ssh/sessions/<session_id>/input", frozenset({"POST"})),
        ("ssh_terminal_resize", "/api/ssh/sessions/<session_id>/resize", frozenset({"POST"})),
        ("ssh_terminal_stream", "/api/ssh/sessions/<session_id>/stream", frozenset({"GET"})),
        ("terminal_page", "/terminal", frozenset({"GET"})),
        ("users_page", "/users", frozenset({"GET"})),
    }
)


@pytest.fixture()
def app(tmp_path: Path):
    cfg = AppConfig(
        smtp=None,
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        report=ReportConfig(subject_prefix="[Test]"),
        servers=[],
        app=AppRuntimeConfig(poll_interval_seconds=600),
        dashboard=DashboardConfig(
            auth=DashboardAuthConfig(enabled=True, username="admin", password="pw"),
            session_secret="s",
        ),
    )
    return create_app(config=cfg, db_path=tmp_path / "endpoints.db")


def test_route_endpoints_are_stable(app):
    """Every bare endpoint, rule and method set must survive the M1 split."""
    actual = frozenset(
        (
            rule.endpoint,
            str(rule),
            frozenset(rule.methods - {"HEAD", "OPTIONS"}),
        )
        for rule in app.url_map.iter_rules()
        if rule.endpoint != "static"
    )
    assert actual == EXPECTED_ENDPOINTS, (
        f"missing={sorted(EXPECTED_ENDPOINTS - actual)!r}\n"
        f"added={sorted(actual - EXPECTED_ENDPOINTS)!r}"
    )
    assert len(actual) == 79
