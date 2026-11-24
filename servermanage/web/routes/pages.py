"""Lightweight pages (compute / my / terminal) (M1: split out of ``register_routes``)."""

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
    _build_my_summary,
    _config,
    _db_path,
    _member_account,
    _view_mode,
    compute_mod,
    os,
    resolve_timezone,
    storage,
)


def compute_page():
    app = current_app._get_current_object()
    config = _config(app)
    summary = compute_mod.build_compute_summary(
        storage.get_all_host_snapshots(_db_path(app)),
        servers=config.servers,
    )
    return render_template("compute.html", active_page="compute", summary=summary)


def api_compute():
    app = current_app._get_current_object()
    config = _config(app)
    summary = compute_mod.build_compute_summary(
        storage.get_all_host_snapshots(_db_path(app)),
        servers=config.servers,
    )
    return jsonify(summary)


def my_page():
    app = current_app._get_current_object()
    config = _config(app)
    return render_template(
        "my.html",
        active_page="my",
        member=_member_account(config),
        mode=_view_mode(config),
    )


def api_my_summary():
    app = current_app._get_current_object()
    config = _config(app)
    tz = resolve_timezone(config.app.timezone)
    return jsonify(_build_my_summary(config, _db_path(app), tz=tz))


def terminal_page():
    app = current_app._get_current_object()
    config = _config(app)
    hosts = [
        {"name": host.name, "host": host.host, "group": host.group}
        for host in config.servers
    ]
    return render_template(
        "terminal.html",
        active_page="terminal",
        hosts=hosts,
        desktop_mode=os.environ.get("SERVERMONITOR_DESKTOP") == "1",
    )


def register_pages(app: Flask) -> None:
    app.add_url_rule('/compute', endpoint='compute_page', view_func=compute_page, methods=['GET'])
    app.add_url_rule('/api/compute', endpoint='api_compute', view_func=api_compute, methods=['GET'])
    app.add_url_rule('/my', endpoint='my_page', view_func=my_page, methods=['GET'])
    app.add_url_rule('/api/my/summary', endpoint='api_my_summary', view_func=api_my_summary, methods=['GET'])
    app.add_url_rule('/terminal', endpoint='terminal_page', view_func=terminal_page, methods=['GET'])
