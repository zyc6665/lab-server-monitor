"""Settings API and settings page (M1: split out of ``register_routes``)."""

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
    AlertEvent,
    SSHClientWrapper,
    SettingsError,
    WebhookConfig,
    _ALLOWED_SETTINGS_SECTIONS,
    _RUNTIME_FILE,
    _USER_MODE_SETTINGS_KEYS,
    _as_int,
    _config,
    _ensure_writable,
    _host_config_from_payload,
    _member_account,
    _refresh_config,
    _request_user_refresh,
    _settings_or_404,
    _settings_service,
    _settings_snapshot,
    _view_mode,
    app_version,
    os,
    read_runtime_state,
    send_desktop_notification,
    send_webhook,
    smtplib,
    user_mode,
)


def api_get_settings():
    app = current_app._get_current_object()
    service, error = _settings_or_404(app)
    if error is not None:
        return error
    # ``public_settings`` already carries ``writable``/``setup_required``;
    # secrets are reduced to booleans and never echoed.
    return jsonify(service.public_settings())


def api_put_settings_section(section: str):
    app = current_app._get_current_object()
    service, error = _settings_or_404(app)
    if error is not None:
        return error
    rejection = _ensure_writable(service)
    if rejection is not None:
        return rejection
    if section not in _ALLOWED_SETTINGS_SECTIONS:
        return jsonify({"error": "unknown_section"}), 404
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_payload"}), 400
    if _view_mode(_config(app)) == user_mode.MODE_USER:
        extra = set(payload) - _USER_MODE_SETTINGS_KEYS
        if section != "monitoring" or extra:
            return (
                jsonify(
                    {
                        "error": "admin_only",
                        "message": "用户模式下只能修改使用模式与账号名",
                    }
                ),
                403,
            )
    try:
        service.save_section(section, payload)
    except SettingsError as exc:
        return jsonify({"error": str(exc)}), 400
    _refresh_config(app)
    if section == "user_monitoring":
        # Saving the section is the moment a new sudo password or a new
        # interval takes effect, so refresh sizes right away.
        _request_user_refresh(app, force_usage=True)
    return jsonify({"ok": True, "restart_required": section == "dashboard"})


def api_test_ssh():
    app = current_app._get_current_object()
    service, error = _settings_or_404(app)
    if error is not None:
        return error
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_payload"}), 400
    if not str(payload.get("host") or "").strip():
        return jsonify({"ok": False, "detail": "host 不能为空"})
    config = _config(app)
    try:
        host_config = _host_config_from_payload(payload)
        with SSHClientWrapper(
            host=host_config,
            connect_timeout=config.ssh.connect_timeout,
        ) as ssh:
            result = ssh.run("echo ok", timeout=config.ssh.command_timeout)
        return jsonify({"ok": True, "detail": result.stdout})
    except Exception as exc:  # noqa: BLE001 - report, never leak a traceback
        return jsonify({"ok": False, "detail": str(exc)})


def api_test_email():
    app = current_app._get_current_object()
    service, error = _settings_or_404(app)
    if error is not None:
        return error
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_payload"}), 400
    host = str(payload.get("host") or "").strip()
    if not host:
        return jsonify({"ok": False, "detail": "host 不能为空"})
    port = _as_int(payload.get("port"), 25)
    username = str(payload.get("username") or "")
    password = str(payload.get("password") or "")
    if not password:
        configured = service.load().smtp
        if configured is not None:
            password = configured.password or ""
    use_ssl = bool(payload.get("use_ssl"))
    try:
        # Connectivity probe only: connect and authenticate, never send a mail.
        if use_ssl:
            server = smtplib.SMTP_SSL(host, port, timeout=10)
        else:
            server = smtplib.SMTP(host, port, timeout=10)
        try:
            if username:
                server.login(username, password)
        finally:
            try:
                server.quit()
            except Exception:  # noqa: BLE001 - best-effort teardown
                pass
    except Exception as exc:  # noqa: BLE001 - text-only error surface
        return jsonify({"ok": False, "detail": str(exc)})
    return jsonify({"ok": True, "detail": "SMTP 连接与登录成功"})


def api_test_desktop():
    """Fire one local desktop toast so the channel can be verified."""
    app = current_app._get_current_object()
    service, error = _settings_or_404(app)
    if error is not None:
        return error
    sent = send_desktop_notification(
        "服务器监控 · 测试通知",
        "这是一条来自设置页的桌面通知测试",
    )
    return jsonify(
        {
            "ok": bool(sent),
            "detail": (
                "已发送桌面通知"
                if sent
                else "桌面通知发送失败（可能当前不在 Windows 桌面会话中）"
            ),
        }
    )


def api_test_webhook():
    app = current_app._get_current_object()
    service, error = _settings_or_404(app)
    if error is not None:
        return error
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_payload"}), 400
    url = str(payload.get("url") or "").strip()
    if not url:
        return jsonify({"ok": False, "detail": "url 不能为空"})
    kind = str(payload.get("type") or "generic")
    try:
        webhook = WebhookConfig(enabled=True, type=kind, url=url)
        event = AlertEvent(
            host_name="test",
            category="test",
            severity="info",
            title="Webhook 测试",
            message="这是一条来自设置页的测试通知",
            fingerprint="settings:test-webhook",
        )
        sent = send_webhook(webhook, event)
    except Exception as exc:  # noqa: BLE001 - text-only error surface
        return jsonify({"ok": False, "detail": str(exc)})
    return jsonify(
        {"ok": bool(sent), "detail": "已发送" if sent else "发送失败"}
    )


def settings_page():
    app = current_app._get_current_object()
    config = _config(app)
    if _view_mode(config) == user_mode.MODE_USER:
        return render_template(
            "settings_user.html",
            active_page="settings",
            member=_member_account(config),
            version=app_version,
            desktop_mode=os.environ.get("SERVERMONITOR_DESKTOP") == "1",
        )
    service = _settings_service(app)
    settings = service.public_settings() if service is not None else _settings_snapshot(config)
    runtime = read_runtime_state(_RUNTIME_FILE) or {}
    silences = (
        service.list_silences(active_only=True) if service is not None else []
    )
    return render_template(
        "settings.html",
        active_page="settings",
        config=config,
        settings=settings,
        runtime=runtime,
        silences=silences,
    )


def register_settings_api(app: Flask) -> None:
    app.add_url_rule('/api/settings', endpoint='api_get_settings', view_func=api_get_settings, methods=['GET'])
    app.add_url_rule('/api/settings/<section>', endpoint='api_put_settings_section', view_func=api_put_settings_section, methods=['PUT'])
    app.add_url_rule('/api/settings/test-ssh', endpoint='api_test_ssh', view_func=api_test_ssh, methods=['POST'])
    app.add_url_rule('/api/settings/test-email', endpoint='api_test_email', view_func=api_test_email, methods=['POST'])
    app.add_url_rule('/api/settings/test-desktop', endpoint='api_test_desktop', view_func=api_test_desktop, methods=['POST'])
    app.add_url_rule('/api/settings/test-webhook', endpoint='api_test_webhook', view_func=api_test_webhook, methods=['POST'])
    app.add_url_rule('/settings', endpoint='settings_page', view_func=settings_page, methods=['GET'])
