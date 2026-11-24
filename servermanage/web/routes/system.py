"""System diagnostics, backup and logs (M1: split out of ``register_routes``)."""

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
    Path,
    _LOG_FILE,
    _RUNTIME_FILE,
    _as_int,
    _config,
    _db_path,
    _system_diagnostics,
    app_version,
    datetime,
    deque,
    json,
    maintenance,
    os,
    read_runtime_state,
    ssh_client,
    storage,
    tempfile,
)


def api_system_host_keys():
    """List the SSH host keys trusted on first use."""
    return jsonify({"hosts": ssh_client.list_known_host_keys()})


def api_system_host_key_forget(hostname: str):
    """Forget one recorded host key (e.g. after a legitimate reinstall)."""
    removed = ssh_client.forget_host_key(hostname)
    if not removed:
        return jsonify({"error": "not_found", "message": "没有这个主机的密钥记录"}), 404
    return jsonify({"ok": True, "host": hostname})


def api_system_health():
    app = current_app._get_current_object()
    from servermanage import __version__ as app_version

    config = _config(app)
    stats = storage.system_stats(_db_path(app))
    runtime = read_runtime_state(_RUNTIME_FILE) or {}
    return jsonify(
        {
            "version": app_version,
            "runtime": runtime,
            "tasks": storage.list_task_states(_db_path(app)),
            "hosts_configured": len(config.servers),
            "diagnostics": _system_diagnostics(config, _db_path(app)),
            **stats,
        }
    )


def api_system_storage():
    app = current_app._get_current_object()
    db_path = _db_path(app)
    return jsonify(
        {
            "usage": maintenance.storage_usage(db_path),
            "db_path": str(db_path),
            "log_retention_hours": 24,
        }
    )


def api_system_maintenance():
    app = current_app._get_current_object()
    payload = request.get_json(silent=True) or {}
    target = str(payload.get("target") or "").strip()
    db_path = _db_path(app)
    app_dir = db_path.parent.parent
    if target == "logs":
        result = maintenance.cleanup_logs(app_dir / "logs")
    elif target == "updates":
        result = maintenance.cleanup_updates(
            app_dir / "data" / "updates", retention_hours=0
        )
    elif target == "cache":
        result = maintenance.cleanup_electron_cache(app_dir / "data" / "electron")
    elif target == "database":
        result = storage.maintain_database(db_path, force=True)
    else:
        return jsonify({"error": "unknown_target"}), 400
    return jsonify(
        {
            "ok": True,
            "target": target,
            "result": result,
            "usage": maintenance.storage_usage(db_path),
        }
    )


def api_system_backup():
    """Download a consistent snapshot of the SQLite database.

    The snapshot is streamed in 1 MB chunks instead of being read fully
    into memory: the database grows with history, and ``read_bytes`` used
    to spike RAM by the whole file size on every backup click while a
    waitress worker sat blocked.
    """
    app = current_app._get_current_object()
    handle, temp_name = tempfile.mkstemp(prefix="servermonitor-backup-", suffix=".db")
    os.close(handle)
    temp_path = Path(temp_name)
    try:
        storage.backup_database(_db_path(app), temp_path)
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")

    def _stream():
        try:
            with temp_path.open("rb") as fh:
                while True:
                    chunk = fh.read(1024 * 1024)
                    if not chunk:
                        break
                    yield chunk
        finally:
            temp_path.unlink(missing_ok=True)

    return Response(
        _stream(),
        mimetype="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="servermonitor-backup-{stamp}.db"'
        },
    )


def api_system_restore():
    """Restore the database from an uploaded backup (admin only)."""
    app = current_app._get_current_object()
    if request.content_length and request.content_length > 100 * 1024 * 1024:
        return jsonify({"error": "备份文件不能超过 100 MB"}), 413
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return jsonify({"error": "请选择备份文件"}), 400

    handle, temp_name = tempfile.mkstemp(prefix="servermonitor-restore-", suffix=".db")
    os.close(handle)
    incoming = Path(temp_name)
    try:
        upload.save(incoming)
        try:
            storage.validate_backup_database(incoming)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        db_path = _db_path(app)
        safety_dir = db_path.parent / "backups"
        safety_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        safety = safety_dir / f"pre-restore-{stamp}.db"
        storage.backup_database(db_path, safety)
        storage.restore_database(incoming, db_path)
        # A restored file may come from an older release: re-run the schema
        # even though this process already initialised this path before.
        storage.init_storage(db_path, daily_summary_tz=None, force=True)
    finally:
        incoming.unlink(missing_ok=True)

    return jsonify(
        {
            "ok": True,
            "restart_required": True,
            "safety_backup": str(safety),
            "message": "数据库已恢复，请关闭并重新打开工具使配置生效。",
        }
    )


def api_system_config_export():
    """Download the non-secret configuration as a JSON document."""
    app = current_app._get_current_object()
    service = app.config.get("SETTINGS_SERVICE")
    if service is None:
        return jsonify({"error": "settings service unavailable"}), 404
    payload = json.dumps(service.public_settings(), ensure_ascii=False, indent=2)
    return Response(
        payload,
        mimetype="application/json",
        headers={
            "Content-Disposition": "attachment; filename=servermonitor-config.json"
        },
    )


def api_logs():
    """Return the tail of the fixed dashboard log.

    Response contract: ``lines`` is the tail *text* (design §3.9),
    ``text`` is the same content under the brief's naming, and
    ``line_count`` is the integer number of lines returned—so callers can
    tell the payload apart from the request parameter unambiguously.
    """
    lines = max(1, min(_as_int(request.args.get("lines"), 200), 2000))
    log_path = _LOG_FILE
    if not log_path.is_file():
        return jsonify(
            {"path": str(log_path), "lines": "", "text": "", "line_count": 0}
        )
    try:
        with log_path.open("r", encoding="utf-8", errors="replace") as handle:
            tail = deque(handle, maxlen=lines)
    except OSError as exc:
        return jsonify({"error": str(exc)}), 500
    text = "".join(tail)
    return jsonify(
        {
            "path": str(log_path),
            "lines": text,
            "text": text,
            "line_count": len(tail),
        }
    )


def api_logs_download():
    """Download the complete dashboard log file."""
    if not _LOG_FILE.is_file():
        return jsonify({"error": "log file not found"}), 404
    return send_file(
        _LOG_FILE,
        as_attachment=True,
        download_name="servermonitor.log",
        mimetype="text/plain",
    )


def api_runtime():
    state = read_runtime_state(_RUNTIME_FILE)
    if not state:
        return jsonify({"url": None})
    return jsonify(
        {
            "url": state.get("url"),
            "port": state.get("port"),
            "pid": state.get("pid"),
        }
    )


def register_system(app: Flask) -> None:
    app.add_url_rule('/api/system/host-keys', endpoint='api_system_host_keys', view_func=api_system_host_keys, methods=['GET'])
    app.add_url_rule('/api/system/host-keys/<hostname>', endpoint='api_system_host_key_forget', view_func=api_system_host_key_forget, methods=['DELETE'])
    app.add_url_rule('/api/system/health', endpoint='api_system_health', view_func=api_system_health, methods=['GET'])
    app.add_url_rule('/api/system/storage', endpoint='api_system_storage', view_func=api_system_storage, methods=['GET'])
    app.add_url_rule('/api/system/maintenance', endpoint='api_system_maintenance', view_func=api_system_maintenance, methods=['POST'])
    app.add_url_rule('/api/system/backup', endpoint='api_system_backup', view_func=api_system_backup, methods=['GET'])
    app.add_url_rule('/api/system/restore', endpoint='api_system_restore', view_func=api_system_restore, methods=['POST'])
    app.add_url_rule('/api/system/config-export', endpoint='api_system_config_export', view_func=api_system_config_export, methods=['GET'])
    app.add_url_rule('/api/logs', endpoint='api_logs', view_func=api_logs, methods=['GET'])
    app.add_url_rule('/api/logs/download', endpoint='api_logs_download', view_func=api_logs_download, methods=['GET'])
    app.add_url_rule('/api/runtime', endpoint='api_runtime', view_func=api_runtime, methods=['GET'])
