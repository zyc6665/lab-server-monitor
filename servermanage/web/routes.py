"""JSON API and authentication routes for the server-monitor dashboard.

Route contract (Task 10):

* ``GET  /api/overview``                 – summary + one row per host
* ``GET  /api/host/<name>``              – latest host snapshot + disk health
* ``GET  /api/alerts?status=active``     – alerts (newest first)
* ``POST /api/alerts/<int:alert_id>/ack``– acknowledge an alert
* ``GET/POST /login``, ``POST /logout``  – single-admin password login

``register_routes(app)`` registers everything on the app created by
:func:`servermanage.web.create_app`; Task 11 extends the same function with the
HTML page routes.
"""

from __future__ import annotations

import hmac
import logging
from datetime import datetime, timezone
from typing import Any

from flask import (
    Flask,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

from servermanage import storage
from servermanage.timeutil import resolve_timezone

LOGGER = logging.getLogger(__name__)

# Same filtering rule as storage._extract_disk_used_percent: only real block
# devices count towards the "disk usage" gauge, never tmpfs/proc/overlay mounts.
_VIRTUAL_FILESYSTEMS = {
    "tmpfs",
    "devtmpfs",
    "overlay",
    "squashfs",
    "nsfs",
    "proc",
    "sysfs",
    "cgroup",
    "cgroup2",
    "mqueue",
    "shm",
}

# ---------------------------------------------------------------------------
# Small value helpers
# ---------------------------------------------------------------------------


def _config(app: Flask):
    return app.config["CONFIG"]


def _db_path(app: Flask):
    return app.config["DB_PATH"]


def _parse_iso(value: Any) -> datetime | None:
    """Parse a stored ISO timestamp; naive values are treated as UTC."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _to_local_iso(value: Any, tz) -> Any:
    """Render a stored ISO UTC timestamp in *tz* with an explicit offset.

    Non-timestamp values (``None`` / already formatted strings that cannot be
    parsed) are returned unchanged so the templates keep degrading gracefully.
    """
    parsed = _parse_iso(value)
    if parsed is None:
        return value
    return parsed.astimezone(tz).isoformat()


def _localize_alerts(rows: list[dict[str, Any]], tz) -> list[dict[str, Any]]:
    """Render alert ``created_at`` values in the configured local timezone."""
    localized = []
    for row in rows:
        item = dict(row)
        item["created_at"] = _to_local_iso(item.get("created_at"), tz)
        localized.append(item)
    return localized


def _as_float(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _percent_int(value: Any) -> int | None:
    """Convert ``"45%"`` / ``45`` / ``45.0`` into ``45``; missing -> ``None``."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        digits = "".join(ch for ch in value if ch.isdigit())
        if digits:
            return int(digits)
    return None


def _memory_percent(metrics: dict[str, Any]) -> float | None:
    memory = metrics.get("memory") or {}
    total = _as_float(memory.get("total_mb"))
    used = _as_float(memory.get("used_mb"))
    if total is None or used is None or total <= 0:
        return None
    return round(used / total * 100.0, 2)


def _disk_percent(metrics: dict[str, Any]) -> float | None:
    rows = metrics.get("disk_usage") or []
    percents: list[int] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        if row.get("filesystem") in _VIRTUAL_FILESYSTEMS:
            continue
        percent = _percent_int(row.get("percent"))
        if percent is not None and percent >= 0:
            percents.append(percent)
    if not percents:
        return None
    return float(max(percents))


def _gpu_memory_percent(metrics: dict[str, Any]) -> float | None:
    gpus = metrics.get("gpu_summary") or []
    used_total = 0.0
    memory_total = 0.0
    found = False
    for gpu in gpus:
        if not isinstance(gpu, dict):
            continue
        total = _as_float(gpu.get("memory_total_mb"))
        used = _as_float(gpu.get("memory_used_mb"))
        if total is None or used is None:
            continue
        found = True
        memory_total += total
        used_total += used
    if not found or memory_total <= 0:
        return None
    return round(used_total / memory_total * 100.0, 2)


def _disk_health_summary(health: dict[str, Any] | None) -> dict[str, Any]:
    """Overall disk status plus per-drive health counts from the latest batch."""
    counts = {"healthy": 0, "warning": 0, "critical": 0}
    if not health:
        return {"status": "unknown", **counts}
    for drive in health.get("physical_drives") or []:
        if not isinstance(drive, dict):
            continue
        value = str(drive.get("health") or "").lower()
        if value in counts:
            counts[value] += 1
    return {"status": str(health.get("status") or "unknown"), **counts}


def _is_online(snapshot: dict[str, Any], poll_interval_seconds: int, now: datetime) -> bool:
    """A host is online when its last snapshot succeeded recently.

    Rule: ``success`` must be true **and** ``collected_at`` must be no older than
    ``3 × poll_interval_seconds`` (default 30 minutes for a 600 s poll).  The 3×
    window tolerates one missed/slow poll cycle; anything older (or a failed
    collection) is shown offline.  A snapshot timestamp in the future is treated
    as fresh rather than offline.
    """
    if not snapshot.get("success"):
        return False
    collected = _parse_iso(snapshot.get("collected_at"))
    if collected is None:
        return False
    max_age = max(int(poll_interval_seconds), 1) * 3
    return (now - collected).total_seconds() <= max_age


def _metrics_payload(metrics: dict[str, Any]) -> dict[str, Any]:
    return {
        "cpu_percent": _as_float(metrics.get("cpu_usage_percent")),
        "memory_percent": _memory_percent(metrics),
        "disk_percent": _disk_percent(metrics),
        "gpu_memory_percent": _gpu_memory_percent(metrics),
    }


def _host_row(
    *,
    name: str,
    host: str | None,
    snapshot: dict[str, Any] | None,
    disk_health: dict[str, Any] | None,
    poll_interval_seconds: int,
    now: datetime,
    tz,
) -> dict[str, Any]:
    if snapshot is None:
        return {
            "name": name,
            "host": host,
            "online": False,
            "collected_at": None,
            "cpu_percent": None,
            "memory_percent": None,
            "disk_percent": None,
            "gpu_memory_percent": None,
            "disk_health": _disk_health_summary(disk_health),
        }
    metrics = snapshot.get("metrics") or {}
    return {
        "name": name,
        "host": host,
        "online": _is_online(snapshot, poll_interval_seconds, now),
        "collected_at": _to_local_iso(snapshot.get("collected_at"), tz),
        **_metrics_payload(metrics),
        "disk_health": _disk_health_summary(disk_health),
    }


def _build_overview(config, db_path) -> dict[str, Any]:
    """Build the ``/api/overview`` payload shared by the JSON API and pages.

    Kept as one function so the server-rendered overview page and the 30 s
    polling refresh always agree on the summary counts and per-host rows.
    """
    now = datetime.now(timezone.utc)
    tz = resolve_timezone(config.app.timezone)

    snapshots = {
        item["host_name"]: item for item in storage.get_all_host_snapshots(db_path)
    }
    disk_reports = {
        item["host_name"]: item for item in storage.get_all_disk_health(db_path)
    }
    addresses = {server.name: server.host for server in config.servers}

    names: list[str] = []
    for server in config.servers:
        if server.name not in names:
            names.append(server.name)
    for host_name in snapshots:
        if host_name not in names:
            names.append(host_name)

    hosts = [
        _host_row(
            name=host_name,
            host=addresses.get(host_name),
            snapshot=snapshots.get(host_name),
            disk_health=disk_reports.get(host_name),
            poll_interval_seconds=config.app.poll_interval_seconds,
            now=now,
            tz=tz,
        )
        for host_name in sorted(names)
    ]

    online = sum(1 for host in hosts if host["online"])
    active_alerts = len(
        storage.list_alerts(db_path, status="active", limit=100_000)
    )
    return {
        "summary": {
            "online": online,
            "offline": len(hosts) - online,
            "active_alerts": active_alerts,
        },
        "hosts": hosts,
    }


def _build_host_detail(name: str, config, db_path) -> dict[str, Any] | None:
    """Build the ``/api/host/<name>`` payload, or ``None`` when unknown."""
    snapshot = storage.get_host_snapshot(name, db_path)
    if snapshot is None:
        return None

    addresses = {server.name: server.host for server in config.servers}
    tz = resolve_timezone(config.app.timezone)
    disk = storage.get_disk_health(name, db_path)
    if disk is not None:
        disk = dict(disk)
        disk["collected_at"] = _to_local_iso(disk.get("collected_at"), tz)
    return {
        "name": name,
        "host": addresses.get(name),
        "collected_at": _to_local_iso(snapshot.get("collected_at"), tz),
        "success": snapshot.get("success"),
        "metrics": snapshot.get("metrics") or {},
        "disk": disk,
    }


def register_routes(app: Flask) -> None:
    """Register auth guards, API routes and the login/logout endpoints."""

    @app.before_request
    def _require_login():
        if request.path == "/login" or request.path.startswith("/static/"):
            return None
        config = _config(app)
        if not config.dashboard.auth.enabled:
            return None
        if session.get("logged_in"):
            return None
        if request.path.startswith("/api/"):
            return jsonify({"error": "unauthorized"}), 401
        return redirect(url_for("login"))

    # -- authentication ----------------------------------------------------

    @app.get("/login")
    def login():
        if session.get("logged_in"):
            return redirect("/")
        return render_template("login.html")

    @app.post("/login")
    def login_submit():
        auth = _config(app).dashboard.auth
        username = request.form.get("username", "")
        password = request.form.get("password", "")
        expected_username = auth.username or ""
        expected_password = auth.password or ""

        username_ok = hmac.compare_digest(username, expected_username)
        # An unset configured password must never authenticate (compare_digest
        # against "" would otherwise accept an empty password).
        password_ok = bool(expected_password) and hmac.compare_digest(
            password, expected_password
        )

        if auth.enabled and username_ok and password_ok:
            session.clear()
            session.permanent = True
            session["logged_in"] = True
            session["username"] = username
            return redirect("/")

        LOGGER.warning("Dashboard login failed for username=%r", username)
        return render_template("login.html", error="用户名或密码错误"), 401

    @app.post("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    # -- JSON API ----------------------------------------------------------

    @app.get("/api/overview")
    def api_overview():
        return jsonify(_build_overview(_config(app), _db_path(app)))

    @app.get("/api/host/<name>")
    def api_host(name: str):
        detail = _build_host_detail(name, _config(app), _db_path(app))
        if detail is None:
            return jsonify({"error": "not found"}), 404
        return jsonify(detail)

    @app.get("/api/alerts")
    def api_alerts():
        status = request.args.get("status") or None
        config = _config(app)
        rows = storage.list_alerts(_db_path(app), status=status)
        return jsonify(
            {"alerts": _localize_alerts(rows, resolve_timezone(config.app.timezone))}
        )

    @app.post("/api/alerts/<int:alert_id>/ack")
    def api_ack_alert(alert_id: int):
        # ``acknowledged`` (not ``active``) so the alert leaves the active list;
        # ``resolved`` stays reserved for the alert engine detecting recovery.
        storage.update_alert(
            alert_id,
            _db_path(app),
            status="acknowledged",
            ack_at=datetime.now(timezone.utc).isoformat(),
        )
        return jsonify({"ok": True})

    # -- HTML pages --------------------------------------------------------
    #
    # Page routes are login-protected by the ``before_request`` gate above: an
    # unauthenticated non-``/api`` request is redirected to ``/login`` (never a
    # 401 JSON body).  Each page renders its initial state server-side so the
    # dashboard is usable without JavaScript; ``app.js`` then refreshes the
    # dynamic parts every 30 s from the JSON API.

    @app.get("/")
    def overview_page():
        data = _build_overview(_config(app), _db_path(app))
        return render_template(
            "overview.html",
            active_page="overview",
            summary=data["summary"],
            hosts=data["hosts"],
        )

    @app.get("/host/<name>")
    def host_page(name: str):
        detail = _build_host_detail(name, _config(app), _db_path(app))
        if detail is None:
            return (
                render_template(
                    "host.html", active_page="overview", name=name, detail=None
                ),
                404,
            )
        return render_template(
            "host.html", active_page="overview", name=name, detail=detail
        )

    @app.get("/alerts")
    def alerts_page():
        config = _config(app)
        alerts = _localize_alerts(
            storage.list_alerts(_db_path(app), status="active"),
            resolve_timezone(config.app.timezone),
        )
        return render_template(
            "alerts.html", active_page="alerts", alerts=alerts
        )

    @app.get("/settings")
    def settings_page():
        return render_template(
            "settings.html", active_page="settings", config=_config(app)
        )
