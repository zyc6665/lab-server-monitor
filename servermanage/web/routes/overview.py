"""Overview dashboard data and pages (M1: split out of ``register_routes``)."""

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
    _build_fleet_report,
    _build_overview,
    _capacity_forecasts_cached,
    _config,
    _db_path,
    _fleet_report_filename,
    _view_mode,
    datetime,
    resolve_timezone,
    storage,
    user_mode,
)


def api_overview():
    app = current_app._get_current_object()
    return jsonify(_build_overview(_config(app), _db_path(app)))


def api_overview_capacity():
    app = current_app._get_current_object()
    try:
        days = int(request.args.get("days", "30"))
    except (TypeError, ValueError):
        return jsonify({"error": "invalid_days"}), 400
    if days not in (7, 30, 90):
        return jsonify({"error": "invalid_days"}), 400
    config = _config(app)
    hosts = _capacity_forecasts_cached(
        config,
        _db_path(app),
        resolve_timezone(config.app.timezone),
        None,
        config.alerts.thresholds,
        days=days,
    )
    thresholds = config.alerts.thresholds
    return jsonify(
        {
            "days": days,
            "thresholds": {
                "memory": thresholds.memory_percent,
                "disk": thresholds.disk_percent,
                "gpu_memory": thresholds.gpu_memory_percent,
            },
            "hosts": hosts,
        }
    )


def api_overview_history():
    app = current_app._get_current_object()
    range_key = request.args.get("range", "24h")
    if range_key not in ("24h", "7d", "30d", "90d"):
        return jsonify({"error": "invalid_range"}), 400
    config = _config(app)
    tz = resolve_timezone(config.app.timezone)
    points = storage.fetch_overview_history(
        _db_path(app),
        range_key=range_key,
        tz=tz,
        host=(request.args.get("host") or "").strip() or None,
    )
    payload: dict[str, Any] = {"range": range_key, "points": points}
    if request.args.get("compare") in ("1", "true", "yes"):
        if range_key == "24h":
            payload["previous"] = []
        else:
            payload["previous"] = storage.fetch_overview_history(
                _db_path(app),
                range_key=range_key,
                tz=tz,
                offset_days={"7d": 7, "30d": 30, "90d": 90}[range_key],
            )
    return jsonify(payload)


def api_overview_alert_history():
    app = current_app._get_current_object()
    range_key = request.args.get("range", "24h")
    if range_key not in ("24h", "7d", "30d"):
        return jsonify({"error": "invalid_range"}), 400
    config = _config(app)
    buckets = storage.fetch_alert_history(
        _db_path(app),
        range_key=range_key,
        tz=resolve_timezone(config.app.timezone),
    )
    return jsonify({"range": range_key, "buckets": buckets})


def api_overview_report():
    app = current_app._get_current_object()
    config = _config(app)
    generated_at = datetime.now(resolve_timezone(config.app.timezone))
    text = _build_fleet_report(config, _db_path(app), generated_at)
    return Response(
        "﻿" + text,
        mimetype="text/plain",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{_fleet_report_filename(generated_at)}"'
            )
        },
    )


def overview_page():
    app = current_app._get_current_object()
    config = _config(app)
    if _view_mode(config) == user_mode.MODE_USER:
        return redirect(url_for("my_page"))
    data = _build_overview(config, _db_path(app))
    return render_template(
        "overview.html",
        active_page="overview",
        summary=data["summary"],
        meta=data["meta"],
        hosts=data["hosts"],
    )


def register_overview(app: Flask) -> None:
    app.add_url_rule('/api/overview', endpoint='api_overview', view_func=api_overview, methods=['GET'])
    app.add_url_rule('/api/overview/capacity', endpoint='api_overview_capacity', view_func=api_overview_capacity, methods=['GET'])
    app.add_url_rule('/api/overview/history', endpoint='api_overview_history', view_func=api_overview_history, methods=['GET'])
    app.add_url_rule('/api/overview/alert-history', endpoint='api_overview_alert_history', view_func=api_overview_alert_history, methods=['GET'])
    app.add_url_rule('/api/overview/report', endpoint='api_overview_report', view_func=api_overview_report, methods=['GET'])
    app.add_url_rule('/', endpoint='overview_page', view_func=overview_page, methods=['GET'])
