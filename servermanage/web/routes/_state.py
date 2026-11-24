"""Shared state helpers lifted out of the old ``register_routes`` closure.

The M1 split moves each route into a per-domain module.  Anything that used to
be captured by the enclosing ``app`` closure is now an explicit function of
``app``.  State itself still lives on ``app.extensions`` (or at module level),
so promoting these helpers does not change runtime behaviour.
"""

from __future__ import annotations

from typing import Any

from flask import Flask, jsonify

from servermanage import storage
from servermanage.models import HostConfig
from servermanage.ssh_terminal import (
    SessionNotFoundError,
    SshTerminalManager,
)
from servermanage.web.routes._core import get_ssh_terminal_manager  # noqa: F401


def terminal_request_allowed() -> bool:
    """Desktop-only terminal: require desktop launch and a loopback request."""
    import os

    from flask import request

    from servermanage.web.routes._core import _is_loopback  # noqa: F401

    if os.environ.get("SERVERMONITOR_DESKTOP") != "1":
        return False
    return _is_loopback(request.remote_addr)


def terminal_denied():
    if not terminal_request_allowed():
        return jsonify({"error": "forbidden", "message": "SSH 终端仅限本机桌面客户端"}), 403
    return None


def find_host(app: Flask, name: str) -> HostConfig | None:
    for host in app.config["CONFIG"].servers:
        if host.name == name:
            return host
    return None


def terminal_session_or_none(app: Flask, session_id: str):
    manager = get_ssh_terminal_manager(app)
    try:
        return manager.get_session(session_id)
    except SessionNotFoundError:
        return None


def finish_ssh_audit(
    app: Flask, session_id: str, status: str, error: str | None = None
) -> None:
    audit_id = app.extensions.get("ssh_audit", {}).pop(session_id, None)
    if audit_id is None:
        return
    try:
        storage.record_ssh_session_end(
            audit_id,
            status=status,
            error=error,
            db_path=app.config["DB_PATH"],
        )
    except Exception:  # auditing must never break the session close
        from servermanage.web.routes._core import LOGGER

        LOGGER.exception("Failed to finalise SSH audit row %s", audit_id)


def start_ssh_audit(app: Flask, session_id: str, audit_id: Any) -> None:
    app.extensions.setdefault("ssh_audit", {})[session_id] = audit_id
