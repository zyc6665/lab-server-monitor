"""Alerts, acknowledgements and silences (M1: split out of ``register_routes``)."""

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
    SettingsError,
    _ALERT_RANGE_HOURS,
    _alert_range_since,
    _alert_status_filter,
    _config,
    _db_path,
    _ensure_writable,
    _localize_alerts,
    _settings_or_404,
    _truthy_arg,
    datetime,
    resolve_timezone,
    storage,
    timezone,
)


def api_alerts():
    app = current_app._get_current_object()
    status_filter = _alert_status_filter(request.args.get("status"))
    status = None if status_filter == "all" else status_filter
    range_key = (request.args.get("range") or "").strip()
    if range_key and range_key not in _ALERT_RANGE_HOURS:
        return jsonify({"error": "invalid range"}), 400
    config = _config(app)
    since = _alert_range_since(range_key)
    db_path = _db_path(app)
    rows = storage.list_alerts(db_path, status=status, since=since)
    return jsonify(
        {
            "alerts": _localize_alerts(
                rows, resolve_timezone(config.app.timezone)
            ),
            "counts": storage.count_alerts_by_status(db_path, since=since),
        }
    )


def api_ack_alert(alert_id: int):
    # ``acknowledged`` (not ``active``) so the alert leaves the active list;
    # ``resolved`` stays reserved for the alert engine detecting recovery.
    app = current_app._get_current_object()
    storage.update_alert(
        alert_id,
        _db_path(app),
        status="acknowledged",
        ack_at=datetime.now(timezone.utc).isoformat(),
    )
    return jsonify({"ok": True})


def api_list_silences():
    app = current_app._get_current_object()
    service, error = _settings_or_404(app)
    if error is not None:
        return error
    active_only = _truthy_arg(request.args.get("active_only"), default=True)
    return jsonify(
        {"silences": service.list_silences(active_only=active_only)}
    )


def api_add_silence():
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
        silence_id = service.add_silence(
            scope_type=payload.get("scope_type"),
            scope=payload.get("scope"),
            reason=str(payload.get("reason") or ""),
            starts_at=payload.get("starts_at"),
            ends_at=payload.get("ends_at"),
            created_by=session.get("username"),
        )
    except SettingsError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True, "id": silence_id})


def api_delete_silence(silence_id: int):
    app = current_app._get_current_object()
    service, error = _settings_or_404(app)
    if error is not None:
        return error
    rejection = _ensure_writable(service)
    if rejection is not None:
        return rejection
    if not service.delete_silence(silence_id):
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True})


def alerts_page():
    app = current_app._get_current_object()
    config = _config(app)
    range_key = (request.args.get("range") or "").strip()
    if range_key not in _ALERT_RANGE_HOURS:
        range_key = ""
    alert_status = _alert_status_filter(request.args.get("status"))
    since = _alert_range_since(range_key)
    db_path = _db_path(app)
    alerts = _localize_alerts(
        storage.list_alerts(
            db_path,
            status=None if alert_status == "all" else alert_status,
            since=since,
        ),
        resolve_timezone(config.app.timezone),
    )
    return render_template(
        "alerts.html",
        active_page="alerts",
        alerts=alerts,
        hosts=[host.name for host in config.servers],
        alert_range=range_key,
        alert_status=alert_status,
        alert_counts=storage.count_alerts_by_status(db_path, since=since),
    )


def register_alerts(app: Flask) -> None:
    app.add_url_rule('/api/alerts', endpoint='api_alerts', view_func=api_alerts, methods=['GET'])
    app.add_url_rule('/api/alerts/<int:alert_id>/ack', endpoint='api_ack_alert', view_func=api_ack_alert, methods=['POST'])
    app.add_url_rule('/api/settings/silences', endpoint='api_list_silences', view_func=api_list_silences, methods=['GET'])
    app.add_url_rule('/api/settings/silences', endpoint='api_add_silence', view_func=api_add_silence, methods=['POST'])
    app.add_url_rule('/api/settings/silences/<int:silence_id>', endpoint='api_delete_silence', view_func=api_delete_silence, methods=['DELETE'])
    app.add_url_rule('/alerts', endpoint='alerts_page', view_func=alerts_page, methods=['GET'])
