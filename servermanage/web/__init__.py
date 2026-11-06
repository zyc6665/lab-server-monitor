"""Flask application factory for the local server-monitor dashboard.

The web layer is deliberately small: a JSON API consumed by a plain-JS frontend
(Task 11) plus a single-password login.  All state lives in the SQLite database
written by the polling service; this package only reads it (except for alert
acknowledgement).
"""

from __future__ import annotations

import logging
import secrets
from datetime import timedelta
from pathlib import Path

from flask import Flask

from servermanage.models import AppConfig
from servermanage.web.routes import register_routes

__all__ = ["create_app"]

LOGGER = logging.getLogger(__name__)


def create_app(*, config: AppConfig, db_path: Path) -> Flask:
    """Build the dashboard Flask app.

    ``config`` and the resolved ``db_path`` are stored on ``app.config`` under
    the ``CONFIG`` / ``DB_PATH`` keys so route handlers (and later page routes in
    Task 11) share one source of truth.  The session secret always comes from
    configuration; when it is absent a per-process random secret is generated
    instead of ever hard-coding one (sessions simply do not survive a restart).
    """
    app = Flask(__name__, template_folder="templates", static_folder="static")

    secret = config.dashboard.session_secret
    if not secret:
        secret = secrets.token_hex(32)
        LOGGER.warning(
            "dashboard.session_secret/DASHBOARD_SECRET 未配置，已生成进程内随机密钥；"
            "进程重启后登录会话将失效。"
        )
    app.secret_key = secret

    lifetime_hours = config.dashboard.session_lifetime_hours or 12
    app.permanent_session_lifetime = timedelta(hours=lifetime_hours)

    app.config["CONFIG"] = config
    app.config["DB_PATH"] = Path(db_path)
    # Lower-case aliases keep the factory ergonomic for plain ``app.config[...]``
    # lookups (e.g. Task 11 page routes); both point at the same objects.
    app.config["config"] = config
    app.config["db_path"] = Path(db_path)

    register_routes(app)
    return app
