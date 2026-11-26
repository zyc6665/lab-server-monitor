# HTTP API 文档

> 自动生成，请勿手工编辑。运行 `pnpm --filter servermonitor-backend run api:doc` 重新生成。
> 端点注册表来源：`backend/src/web/routes/registry.ts`。

- API 端点：73 个
- 页面路由：17 个
- 运行时可通过 `GET /api/system/endpoints` 获取 JSON 版本。

## API 端点

| 名称 | 路径 |
| --- | --- |
| `api_change_password` | `/api/settings/password` |
| `api_overview` | `/api/overview` |
| `api_overview_capacity` | `/api/overview/capacity` |
| `api_overview_history` | `/api/overview/history` |
| `api_overview_alert_history` | `/api/overview/alert-history` |
| `api_overview_report` | `/api/overview/report` |
| `api_compute` | `/api/compute` |
| `api_my_summary` | `/api/my/summary` |
| `api_alerts` | `/api/alerts` |
| `api_ack_alert` | `/api/alerts/{alert_id}/ack` |
| `api_list_silences` | `/api/settings/silences` |
| `api_add_silence` | `/api/settings/silences` |
| `api_delete_silence` | `/api/settings/silences/{silence_id}` |
| `probe_host_settings` | `/api/settings/hosts/probe` |
| `api_host` | `/api/host/{name}` |
| `api_host_report` | `/api/host/{name}/report` |
| `api_host_history` | `/api/host/{name}/history` |
| `api_host_collection_status` | `/api/settings/hosts/collection-status` |
| `api_list_hosts` | `/api/settings/hosts` |
| `api_upsert_host` | `/api/settings/hosts/{name}` |
| `api_delete_host` | `/api/settings/hosts/{name}` |
| `api_preview_host_import` | `/api/settings/hosts/import/preview` |
| `api_ssh_config_preview` | `/api/settings/hosts/ssh-config` |
| `api_ssh_config_import` | `/api/settings/hosts/ssh-config/import` |
| `api_import_hosts` | `/api/settings/hosts/import` |
| `api_test_hosts_batch` | `/api/settings/hosts/test-batch` |
| `api_probe_saved_host` | `/api/settings/hosts/{name}/probe` |
| `api_test_saved_host_check` | `/api/settings/hosts/{name}/checks/test` |
| `api_host_container_stats` | `/api/host/{name}/containers/stats` |
| `api_run_host_checks` | `/api/host/{name}/checks/run` |
| `api_collect_saved_host` | `/api/settings/hosts/{name}/collect` |
| `api_collect_saved_hosts` | `/api/settings/hosts/collect` |
| `api_copy_host` | `/api/settings/hosts/{name}/copy` |
| `api_get_settings` | `/api/settings` |
| `api_put_settings_section` | `/api/settings/{section}` |
| `api_settings_history` | `/api/settings/history` |
| `api_test_ssh` | `/api/settings/test-ssh` |
| `api_test_email` | `/api/settings/test-email` |
| `api_test_desktop` | `/api/settings/test-desktop` |
| `api_test_webhook` | `/api/settings/test-webhook` |
| `api_system_host_keys` | `/api/system/host-keys` |
| `api_system_host_key_forget` | `/api/system/host-keys/{hostname}` |
| `api_system_health` | `/api/system/health` |
| `api_system_endpoints` | `/api/system/endpoints` |
| `api_system_audit` | `/api/system/audit` |
| `api_system_storage` | `/api/system/storage` |
| `api_system_maintenance` | `/api/system/maintenance` |
| `api_system_backup` | `/api/system/backup` |
| `api_system_restore` | `/api/system/restore` |
| `api_system_config_export` | `/api/system/config-export` |
| `api_system_tasks` | `/api/system/tasks` |
| `api_run_system_task` | `/api/system/tasks/{name}/run` |
| `api_reports_preview` | `/api/reports/preview` |
| `api_reports_history` | `/api/reports/history` |
| `api_reports_send` | `/api/reports/send` |
| `api_logs` | `/api/logs` |
| `api_logs_download` | `/api/logs/download` |
| `api_runtime` | `/api/runtime` |
| `api_users` | `/api/users` |
| `api_users_refresh` | `/api/users/refresh` |
| `api_users_history` | `/api/users/history` |
| `api_users_top` | `/api/users/top` |
| `api_users_refresh_status` | `/api/users/refresh-status` |
| `api_users_baseline_remove` | `/api/users/baseline/remove` |
| `api_users_plan` | `/api/users/plan` |
| `api_users_execute` | `/api/users/execute` |
| `api_users_execute_status` | `/api/users/execute/status` |
| `api_users_operations` | `/api/users/operations` |
| `create_ssh_session` | `/api/ssh/sessions` |
| `ssh_terminal_input` | `/api/ssh/sessions/{session_id}/input` |
| `ssh_terminal_resize` | `/api/ssh/sessions/{session_id}/resize` |
| `ssh_terminal_close` | `/api/ssh/sessions/{session_id}` |
| `ssh_terminal_stream` | `/api/ssh/sessions/{session_id}/stream` |

## 页面路由

| 名称 | 路径 |
| --- | --- |
| `overview_page` | `/` |
| `hosts_page` | `/hosts` |
| `host_page` | `/host/{name}` |
| `alerts_page` | `/alerts` |
| `disk_health_page` | `/disk-health` |
| `compute_page` | `/compute` |
| `my_page` | `/my` |
| `users_page` | `/users` |
| `settings_page` | `/settings` |
| `terminal_page` | `/terminal` |
| `tasks_page` | `/tasks` |
| `reports_page` | `/reports` |
| `setup` | `/setup` |
| `login` | `/login` |
| `login_submit` | `/login` |
| `logout` | `/logout` |
| `static` | `/static/{filename}` |
