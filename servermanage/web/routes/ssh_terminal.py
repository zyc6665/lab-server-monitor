"""SSH terminal routes (desktop-only, loopback-only).

M1 split: these functions used to be closures inside ``register_routes()``.
They are now module-level view functions registered with their original bare
endpoint names, so Flask's ``url_for`` and the Electron client stay unchanged.
"""

from __future__ import annotations

import base64

from flask import Flask, Response, jsonify, request, session

from servermanage.ssh_terminal import SessionNotFoundError, TerminalLimitError
from servermanage.web.routes._core import LOGGER
from servermanage.web.routes._state import (
    find_host,
    finish_ssh_audit,
    get_ssh_terminal_manager,
    start_ssh_audit,
    terminal_denied,
    terminal_session_or_none,
)
from servermanage import storage
from servermanage.web.routes._core import _db_path


def create_ssh_session():
    denied = terminal_denied()
    if denied is not None:
        return denied
    from flask import current_app

    app = current_app._get_current_object()
    payload = request.get_json(silent=True) or {}
    host_name = str(payload.get("host_name") or "").strip()
    host = find_host(app, host_name)
    if host is None:
        return jsonify({"error": "host_not_found"}), 404
    try:
        cols = max(20, min(400, int(payload.get("cols", 80))))
        rows = max(5, min(200, int(payload.get("rows", 24))))
    except (TypeError, ValueError):
        return jsonify({"error": "invalid_size"}), 400
    manager = get_ssh_terminal_manager(app)
    try:
        session_id = manager.create(host, cols=cols, rows=rows)
    except TerminalLimitError:
        return jsonify({"error": "terminal_limit"}), 429
    except Exception as exc:  # SSH failures must surface as JSON
        LOGGER.warning("SSH terminal create failed for %s: %s", host_name, exc)
        return jsonify({"error": "ssh_failed", "message": str(exc)}), 502
    audit_id = storage.record_ssh_session_start(
        host_name,
        username=str(session.get("username") or "admin"),
        server_username=host.username,
        remote_addr=request.remote_addr or "127.0.0.1",
        db_path=_db_path(app),
    )
    start_ssh_audit(app, session_id, audit_id)
    return jsonify({"session_id": session_id}), 201


def ssh_terminal_input(session_id: str):
    from flask import current_app

    app = current_app._get_current_object()
    denied = terminal_denied()
    if denied is not None:
        return denied
    if terminal_session_or_none(app, session_id) is None:
        return jsonify({"error": "session_not_found"}), 404
    payload = request.get_json(silent=True) or {}
    data = payload.get("data", "")
    if not isinstance(data, str):
        return jsonify({"error": "invalid_data"}), 400
    try:
        get_ssh_terminal_manager(app).send_input(session_id, data)
    except SessionNotFoundError:
        return jsonify({"error": "session_not_found"}), 404
    return "", 204


def ssh_terminal_resize(session_id: str):
    from flask import current_app

    app = current_app._get_current_object()
    denied = terminal_denied()
    if denied is not None:
        return denied
    if terminal_session_or_none(app, session_id) is None:
        return jsonify({"error": "session_not_found"}), 404
    payload = request.get_json(silent=True) or {}
    try:
        cols = max(20, min(400, int(payload.get("cols", 80))))
        rows = max(5, min(200, int(payload.get("rows", 24))))
    except (TypeError, ValueError):
        return jsonify({"error": "invalid_size"}), 400
    try:
        get_ssh_terminal_manager(app).resize(session_id, cols, rows)
    except SessionNotFoundError:
        return jsonify({"error": "session_not_found"}), 404
    return "", 204


def ssh_terminal_close(session_id: str):
    from flask import current_app

    app = current_app._get_current_object()
    denied = terminal_denied()
    if denied is not None:
        return denied
    manager = get_ssh_terminal_manager(app)
    closed = manager.close(session_id)
    if not closed and terminal_session_or_none(app, session_id) is None:
        return jsonify({"error": "session_not_found"}), 404
    finish_ssh_audit(app, session_id, "closed")
    return "", 204


def ssh_terminal_stream(session_id: str):
    from flask import current_app

    app = current_app._get_current_object()
    denied = terminal_denied()
    if denied is not None:
        return denied
    manager = get_ssh_terminal_manager(app)
    if terminal_session_or_none(app, session_id) is None:
        return jsonify({"error": "session_not_found"}), 404

    def generate():
        outcome = "closed"
        error_text = None
        try:
            for chunk in manager.stream(session_id):
                if chunk:
                    yield b"data: " + base64.b64encode(chunk) + b"\n\n"
                else:
                    yield b": keepalive\n\n"
        except Exception as exc:  # client disconnect / SSH error
            outcome = "error"
            error_text = f"{type(exc).__name__}: {exc}"
            LOGGER.info("SSH terminal stream ended with error: %s", error_text)
        finally:
            try:
                manager.close(session_id)
            finally:
                finish_ssh_audit(app, session_id, outcome, error_text)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


#: (rule, endpoint, view_func, methods) — endpoint names are the original bare
#: names from ``routes.py``; keeping them avoids breaking ``url_for``/Electron.
ROUTES = (
    ("/api/ssh/sessions", "create_ssh_session", create_ssh_session, ["POST"]),
    (
        "/api/ssh/sessions/<session_id>/input",
        "ssh_terminal_input",
        ssh_terminal_input,
        ["POST"],
    ),
    (
        "/api/ssh/sessions/<session_id>/resize",
        "ssh_terminal_resize",
        ssh_terminal_resize,
        ["POST"],
    ),
    (
        "/api/ssh/sessions/<session_id>",
        "ssh_terminal_close",
        ssh_terminal_close,
        ["DELETE"],
    ),
    (
        "/api/ssh/sessions/<session_id>/stream",
        "ssh_terminal_stream",
        ssh_terminal_stream,
        ["GET"],
    ),
)


def register(app: Flask) -> None:
    for rule, endpoint, view_func, methods in ROUTES:
        app.add_url_rule(rule, endpoint, view_func, methods=methods)
