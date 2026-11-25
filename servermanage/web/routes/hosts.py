"""Host inventory, probes, checks and pages (M1: split out of ``register_routes``)."""

from __future__ import annotations

from flask import (
    Flask,
    Response,
    current_app,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    url_for,
)

from servermanage.web.routes._core import (
    Any,
    LOGGER,
    SSHClientWrapper,
    SettingsError,
    ThreadPoolExecutor,
    _build_host_check,
    _build_host_detail,
    _build_host_report,
    _build_overview,
    _config,
    _db_path,
    _ensure_writable,
    _notify_hosts_imported,
    _parse_import_payload,
    _read_ssh_config_candidates,
    _refresh_config,
    _reject_unsafe_target,
    _report_filename,
    _request_user_refresh,
    _sanitize_host_checks,
    _settings_or_404,
    _truthy_arg,
    availability,
    container_stats_mod,
    datetime,
    getpass,
    host_probe,
    replace,
    resolve_timezone,
    run_host_checks,
    storage,
    timezone,
    to_jsonable,
)


def probe_host_settings():
    app = current_app._get_current_object()
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict) or not str(payload.get("host") or "").strip():
        return jsonify({"ok": False, "status": "invalid", "message": "请填写服务器地址"}), 400
    blocked = _reject_unsafe_target(str(payload.get("host") or ""), app)
    if blocked:
        return jsonify({"ok": False, "status": "blocked", "message": blocked}), 200
    try:
        result = host_probe.probe_host(payload)
    except Exception as exc:  # defensive; probe_host normally reports failures
        LOGGER.exception("Host probe failed unexpectedly")
        return jsonify({"ok": False, "status": "error", "message": f"探测失败：{exc}"}), 200
    return jsonify(to_jsonable(result)), 200


def api_host(name: str):
    app = current_app._get_current_object()
    detail = _build_host_detail(name, _config(app), _db_path(app))
    if detail is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(detail)


def api_host_report(name: str):
    app = current_app._get_current_object()
    detail = _build_host_detail(name, _config(app), _db_path(app))
    if detail is None:
        return jsonify({"error": "not found"}), 404
    config = _config(app)
    generated_at = datetime.now(resolve_timezone(config.app.timezone))
    text = _build_host_report(detail, generated_at)
    return Response(
        "﻿" + text,
        mimetype="text/plain",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{_report_filename(name, generated_at)}"'
            )
        },
    )


def api_host_history(name: str):
    app = current_app._get_current_object()
    range_key = request.args.get("range", "24h")
    if range_key not in ("24h", "7d", "30d"):
        return jsonify({"error": "invalid_range"}), 400
    detail = _build_host_detail(name, _config(app), _db_path(app))
    if detail is None:
        return jsonify({"error": "not found"}), 404
    config = _config(app)
    points = storage.fetch_host_history(
        _db_path(app),
        name,
        range_key=range_key,
        tz=resolve_timezone(config.app.timezone),
    )
    return jsonify({"range": range_key, "points": points})


def api_host_collection_status():
    app = current_app._get_current_object()
    provider = app.config.get("COLLECTION_STATUS_PROVIDER")
    if provider is None:
        return jsonify({"statuses": {}})
    raw_names = request.args.get("names")
    names = None
    if raw_names is not None:
        names = [item.strip() for item in raw_names.split(",") if item.strip()]
    try:
        statuses = provider(names)
    except Exception:  # noqa: BLE001 - status is best effort
        LOGGER.exception("collection_status provider failed")
        statuses = {}
    return jsonify({"statuses": statuses})


def api_list_hosts():
    app = current_app._get_current_object()
    service, error = _settings_or_404(app)
    if error is not None:
        return error
    return jsonify({"hosts": service.list_hosts()})


def api_upsert_host(name: str):
    app = current_app._get_current_object()
    service, error = _settings_or_404(app)
    if error is not None:
        return error
    rejection = _ensure_writable(service)
    if rejection is not None:
        return rejection
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_payload"}), 400
    try:
        service.upsert_host(name, payload)
    except SettingsError as exc:
        return jsonify({"error": str(exc)}), 400
    _refresh_config(app)
    _notify_hosts_imported(app, [name])
    if payload.get("sudo_password"):
        # A freshly stored sudo password unblocks the size scan, so do not
        # wait for the (two day) usage interval to run it.
        _request_user_refresh(app, force_usage=True)
    return jsonify({"ok": True})


def api_delete_host(name: str):
    app = current_app._get_current_object()
    service, error = _settings_or_404(app)
    if error is not None:
        return error
    rejection = _ensure_writable(service)
    if rejection is not None:
        return rejection
    if service.get_host(name) is None:
        return jsonify({"error": "not_found"}), 404
    try:
        service.delete_host(name)
    except SettingsError as exc:
        return jsonify({"error": str(exc)}), 400
    _refresh_config(app)
    return jsonify({"ok": True})


def api_preview_host_import():
    """Parse pasted/uploaded host definitions without touching the store."""
    app = current_app._get_current_object()
    service, error = _settings_or_404(app)
    if error is not None:
        return error
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_payload"}), 400
    parsed, parse_error = _parse_import_payload(payload)
    if parse_error is not None:
        return parse_error
    return jsonify(
        {
            "candidates": [to_jsonable(candidate) for candidate in parsed.candidates],
            "errors": parsed.errors,
            "warnings": parsed.warnings,
        }
    )


def api_ssh_config_preview():
    """Return hosts parsed from the local ``~/.ssh/config`` for confirmation."""
    app = current_app._get_current_object()
    service, error = _settings_or_404(app)
    if error is not None:
        return error
    path, exists, parsed = _read_ssh_config_candidates()
    return jsonify(
        {
            "path": str(path),
            "exists": exists,
            "default_username": getpass.getuser(),
            "candidates": [to_jsonable(candidate) for candidate in parsed.candidates],
            "errors": parsed.errors,
            "warnings": parsed.warnings,
        }
    )


def api_ssh_config_import():
    """Import selected hosts from ``~/.ssh/config``.

    The file is re-read server-side; ``names`` only selects from the fresh
    parse, so a browser cannot inject a made-up host or credential.
    """
    app = current_app._get_current_object()
    service, error = _settings_or_404(app)
    if error is not None:
        return error
    rejection = _ensure_writable(service)
    if rejection is not None:
        return rejection
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_payload"}), 400
    names = payload.get("names")
    if names is not None and (
        not isinstance(names, list) or not all(isinstance(n, str) for n in names)
    ):
        return jsonify({"error": "invalid_payload"}), 400
    _path, exists, parsed = _read_ssh_config_candidates()
    selected = set(names) if names is not None else None
    candidates = [
        to_jsonable(candidate)
        for candidate in parsed.candidates
        if selected is None or candidate.name in selected
    ]
    if selected is not None and not candidates:
        return jsonify(
            {"ok": False, "error": "no_matching_hosts", "candidates": []}
        ), 400
    try:
        result = service.import_hosts(
            candidates,
            overwrite=_truthy_arg(payload.get("overwrite")),
            allow_missing_credentials=True,
        )
    except SettingsError as exc:
        return jsonify({"error": str(exc)}), 400
    _refresh_config(app)
    _notify_hosts_imported(app, result.get("created", []) + result.get("updated", []))
    return jsonify(
        {
            "ok": True,
            "exists": exists,
            "parse_errors": parsed.errors,
            "warnings": parsed.warnings,
            **result,
        }
    )


def api_import_hosts():
    app = current_app._get_current_object()
    service, error = _settings_or_404(app)
    if error is not None:
        return error
    rejection = _ensure_writable(service)
    if rejection is not None:
        return rejection
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_payload"}), 400
    parsed, parse_error = _parse_import_payload(payload)
    if parse_error is not None:
        return parse_error
    try:
        result = service.import_hosts(
            [to_jsonable(candidate) for candidate in parsed.candidates],
            overwrite=_truthy_arg(payload.get("overwrite")),
        )
    except SettingsError as exc:
        return jsonify({"error": str(exc)}), 400
    _refresh_config(app)
    _notify_hosts_imported(app, result.get("created", []) + result.get("updated", []))
    return jsonify({"ok": True, "parse_errors": parsed.errors, **result})


def api_test_hosts_batch():
    """Probe several saved hosts with a small connection pool.

    Nothing is persisted and the response only carries a status line; secret
    material from the config is never copied into the payload.  Serial
    probing burned one connect timeout per unreachable host inside a single
    HTTP request, so the fleet is checked in parallel instead.
    """
    app = current_app._get_current_object()
    service, error = _settings_or_404(app)
    if error is not None:
        return error
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_payload"}), 400
    names = payload.get("names")
    if not isinstance(names, list) or not all(
        isinstance(name, str) for name in names
    ):
        return jsonify({"error": "invalid_payload"}), 400
    config = _config(app)
    servers = {server.name: server for server in config.servers}

    def probe_one(name: str) -> dict[str, Any]:
        if service.get_host(name) is None:
            return {"name": name, "ok": False, "detail": "主机不存在"}
        host_config = servers.get(name)
        if host_config is None:
            return {"name": name, "ok": False, "detail": "主机配置不可用"}
        try:
            with SSHClientWrapper(
                host=host_config,
                connect_timeout=config.ssh.connect_timeout,
            ) as ssh:
                probe = ssh.run(
                    "echo ok", timeout=config.ssh.command_timeout
                )
            detail = (probe.stdout or probe.stderr or "").strip()
            return {
                "name": name,
                "ok": probe.exit_status == 0,
                "detail": detail,
            }
        except Exception as exc:  # noqa: BLE001 - text-only error surface
            return {"name": name, "ok": False, "detail": str(exc)}

    if len(names) <= 1:
        results = [probe_one(name) for name in names]
    else:
        # 一台掉线主机要吃满 connect_timeout，串行探测会让浏览器先超时。
        workers = max(1, min(4, len(names)))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            results = list(executor.map(probe_one, names))
    return jsonify({"results": results})


def api_probe_saved_host(name: str):
    """Probe a saved host using its stored credentials.

    This is the host-detail "test connection" button.  The probe is
    read-only; no secret is ever returned to the browser.
    """
    app = current_app._get_current_object()
    config = _config(app)
    host_config = next((h for h in config.servers if h.name == name), None)
    if host_config is None:
        return jsonify({"error": "not_found"}), 404
    result = host_probe.probe_host(
        host_config, timeout=config.ssh.connect_timeout
    )
    return jsonify(to_jsonable(result))


def api_test_saved_host_check(name: str):
    """Run one posted check against a saved host using stored credentials.

    The host must already be saved (404 otherwise) so a browser never has to
    send connection credentials merely to test a check.  Connection details
    and the sudo password come from the saved configuration; nothing is
    persisted and the response never carries secret material.
    """
    app = current_app._get_current_object()
    config = _config(app)
    host_config = next((h for h in config.servers if h.name == name), None)
    if host_config is None:
        return jsonify({"error": "not_found"}), 404
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_payload"}), 400
    try:
        sanitized = _sanitize_host_checks([payload])
    except SettingsError as exc:
        return jsonify({"error": str(exc)}), 400
    check_config = _build_host_check(sanitized[0])
    temp_host = replace(host_config, checks=[check_config])
    try:
        with SSHClientWrapper(
            host=temp_host, connect_timeout=config.ssh.connect_timeout
        ) as ssh:
            results = run_host_checks(
                temp_host, ssh, [check_config], config.ssh.command_timeout
            )
    except Exception as exc:  # noqa: BLE001 - text-only error surface
        LOGGER.exception("saved host check test failed for %s", name)
        return jsonify({"ok": False, "error": str(exc)}), 200
    return jsonify({"ok": True, "results": to_jsonable(results)})


def api_host_container_stats(name: str):
    """Run one read-only ``docker stats --no-stream`` for a saved host."""
    app = current_app._get_current_object()
    config = _config(app)
    host_config = next((h for h in config.servers if h.name == name), None)
    if host_config is None:
        return jsonify({"error": "not_found"}), 404
    try:
        with SSHClientWrapper(
            host=host_config, connect_timeout=config.ssh.connect_timeout
        ) as ssh:
            rows = container_stats_mod.collect_container_stats(
                host_config, ssh, timeout=config.ssh.command_timeout
            )
    except Exception as exc:  # noqa: BLE001 - text-only error surface
        LOGGER.exception("container stats failed for %s", name)
        return jsonify({"ok": False, "error": str(exc)}), 200
    return jsonify(
        {
            "ok": True,
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "containers": rows,
        }
    )


def api_run_host_checks(name: str):
    """Run this host's service checks once, on demand (read-only)."""
    app = current_app._get_current_object()
    config = _config(app)
    db_path = _db_path(app)
    host_config = next((h for h in config.servers if h.name == name), None)
    if host_config is None:
        return jsonify({"error": "not_found"}), 404
    checks = [check for check in (host_config.checks or []) if getattr(check, "enabled", True)]
    if not checks:
        return jsonify({"ok": False, "error": "该主机还没有配置服务检查"})
    try:
        with SSHClientWrapper(
            host=host_config,
            connect_timeout=config.ssh.connect_timeout,
        ) as ssh:
            results = availability.run_host_checks(
                host_config, ssh, checks, config.ssh.command_timeout
            )
    except Exception as exc:  # noqa: BLE001 - report, never leak a traceback
        LOGGER.exception("on-demand checks failed for %s", name)
        return jsonify({"ok": False, "error": str(exc)})
    try:
        storage.save_host_check_results(name, results, db_path)
        storage.append_host_check_history(name, results, db_path)
    except Exception:  # noqa: BLE001 - metrics already computed
        LOGGER.exception("failed to persist checks for %s", name)
    return jsonify(
        {
            "ok": True,
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "checks": [
                {
                    "name": result.name,
                    "type": result.type,
                    "target": result.target,
                    "status": result.status,
                    "message": result.message,
                    "latency_ms": result.latency_ms,
                }
                for result in results
            ],
        }
    )


def api_collect_saved_host(name: str):
    """Queue an immediate status + disk collection for one saved host."""
    app = current_app._get_current_object()
    config = _config(app)
    if not any(h.name == name for h in config.servers):
        return jsonify({"error": "not_found"}), 404
    callback = app.config.get("ON_HOSTS_IMPORTED")
    if callback is None:
        return jsonify({"error": "collection_unavailable"}), 409
    try:
        callback([name])
    except Exception:  # noqa: BLE001 - surface a stable error
        LOGGER.exception("immediate collection failed for %s", name)
        return jsonify({"error": "collection_failed"}), 500
    return jsonify({"ok": True})


def api_collect_saved_hosts():
    """Queue an immediate collection for several saved hosts.

    The browser sends ``{"names": [...]}``; an empty or omitted list means
    every saved host. Unknown names are ignored instead of failing the
    whole batch.
    """
    app = current_app._get_current_object()
    config = _config(app)
    saved_names = [host.name for host in config.servers]
    payload = request.get_json(silent=True)
    if payload is None:
        selected = saved_names
    elif not isinstance(payload, dict):
        return jsonify({"error": "invalid_payload"}), 400
    else:
        raw_names = payload.get("names")
        if raw_names is None:
            selected = saved_names
        elif not isinstance(raw_names, list):
            return jsonify({"error": "invalid_payload"}), 400
        else:
            wanted = {str(name) for name in raw_names}
            selected = [name for name in saved_names if name in wanted]
    if not selected:
        return jsonify({"ok": True, "count": 0})
    callback = app.config.get("ON_HOSTS_IMPORTED")
    if callback is None:
        return jsonify({"error": "collection_unavailable"}), 409
    try:
        callback(selected)
    except Exception:  # noqa: BLE001 - surface a stable error
        LOGGER.exception("batch collection failed for %s", selected)
        return jsonify({"error": "collection_failed"}), 500
    return jsonify({"ok": True, "count": len(selected)})


def api_copy_host(name: str):
    app = current_app._get_current_object()
    service, error = _settings_or_404(app)
    if error is not None:
        return error
    rejection = _ensure_writable(service)
    if rejection is not None:
        return rejection
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_payload"}), 400
    new_name = str(payload.get("new_name") or "").strip()
    if not new_name:
        return jsonify({"error": "new_name 不能为空"}), 400
    if service.get_host(name) is None:
        return jsonify({"error": "not_found"}), 404
    try:
        service.copy_host(name, new_name)
    except SettingsError as exc:
        return jsonify({"error": str(exc)}), 400
    _refresh_config(app)
    _notify_hosts_imported(app, [new_name])
    return jsonify({"ok": True, "name": new_name})


def hosts_page():
    app = current_app._get_current_object()
    data = _build_overview(_config(app), _db_path(app))
    return render_template(
        "hosts.html",
        active_page="hosts",
        summary=data["summary"],
        meta=data["meta"],
        hosts=data["hosts"],
    )


def host_page(name: str):
    app = current_app._get_current_object()
    detail = _build_host_detail(name, _config(app), _db_path(app))
    if detail is None:
        return (
            render_template(
                "host.html", active_page="hosts", name=name, detail=None
            ),
            404,
        )
    return render_template(
        "host.html", active_page="hosts", name=name, detail=detail
    )


def register_hosts(app: Flask) -> None:
    app.add_url_rule('/api/settings/hosts/probe', endpoint='probe_host_settings', view_func=probe_host_settings, methods=['POST'])
    app.add_url_rule('/api/host/<name>', endpoint='api_host', view_func=api_host, methods=['GET'])
    app.add_url_rule('/api/host/<name>/report', endpoint='api_host_report', view_func=api_host_report, methods=['GET'])
    app.add_url_rule('/api/host/<name>/history', endpoint='api_host_history', view_func=api_host_history, methods=['GET'])
    app.add_url_rule('/api/settings/hosts/collection-status', endpoint='api_host_collection_status', view_func=api_host_collection_status, methods=['GET'])
    app.add_url_rule('/api/settings/hosts', endpoint='api_list_hosts', view_func=api_list_hosts, methods=['GET'])
    app.add_url_rule('/api/settings/hosts/<name>', endpoint='api_upsert_host', view_func=api_upsert_host, methods=['PUT'])
    app.add_url_rule('/api/settings/hosts/<name>', endpoint='api_delete_host', view_func=api_delete_host, methods=['DELETE'])
    app.add_url_rule('/api/settings/hosts/import/preview', endpoint='api_preview_host_import', view_func=api_preview_host_import, methods=['POST'])
    app.add_url_rule('/api/settings/hosts/ssh-config', endpoint='api_ssh_config_preview', view_func=api_ssh_config_preview, methods=['GET'])
    app.add_url_rule('/api/settings/hosts/ssh-config/import', endpoint='api_ssh_config_import', view_func=api_ssh_config_import, methods=['POST'])
    app.add_url_rule('/api/settings/hosts/import', endpoint='api_import_hosts', view_func=api_import_hosts, methods=['POST'])
    app.add_url_rule('/api/settings/hosts/test-batch', endpoint='api_test_hosts_batch', view_func=api_test_hosts_batch, methods=['POST'])
    app.add_url_rule('/api/settings/hosts/<name>/probe', endpoint='api_probe_saved_host', view_func=api_probe_saved_host, methods=['POST'])
    app.add_url_rule('/api/settings/hosts/<name>/checks/test', endpoint='api_test_saved_host_check', view_func=api_test_saved_host_check, methods=['POST'])
    app.add_url_rule('/api/host/<name>/containers/stats', endpoint='api_host_container_stats', view_func=api_host_container_stats, methods=['POST'])
    app.add_url_rule('/api/host/<name>/checks/run', endpoint='api_run_host_checks', view_func=api_run_host_checks, methods=['POST'])
    app.add_url_rule('/api/settings/hosts/<name>/collect', endpoint='api_collect_saved_host', view_func=api_collect_saved_host, methods=['POST'])
    app.add_url_rule('/api/settings/hosts/collect', endpoint='api_collect_saved_hosts', view_func=api_collect_saved_hosts, methods=['POST'])
    app.add_url_rule('/api/settings/hosts/<name>/copy', endpoint='api_copy_host', view_func=api_copy_host, methods=['POST'])
    app.add_url_rule('/hosts', endpoint='hosts_page', view_func=hosts_page, methods=['GET'])
    app.add_url_rule('/host/<name>', endpoint='host_page', view_func=host_page, methods=['GET'])
