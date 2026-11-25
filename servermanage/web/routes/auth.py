"""Authentication and first-run setup (M1: split out of ``register_routes``)."""

from __future__ import annotations

import threading

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
    _LOGIN_FAILURE_LIMIT,
    _LOGIN_FAILURE_WINDOW_SECONDS,
    deque,
    time,
    LOGGER,
    SettingsError,
    _config,
    _ensure_writable,
    _is_loopback,
    _refresh_config,
    _require_csrf,
    _settings_or_404,
    _settings_service,
    hmac,
)


def setup():
    app = current_app._get_current_object()
    if not _is_loopback(request.remote_addr):
        return render_template("setup.html", error="首次设置只允许本机访问"), 403

    if request.method == "POST":
        rejection = _require_csrf()
        if rejection is not None:
            return rejection

    service = _settings_service(app)
    if service is None:
        return render_template("setup.html", error="设置服务不可用"), 500

    if request.method == "GET":
        if not service.setup_required():
            return redirect(url_for("login"))
        return render_template("setup.html")

    username = (request.form.get("username") or "").strip() or "admin"
    password = request.form.get("password", "")
    confirm = request.form.get("confirm", "")

    error = None
    if len(password) < 8:
        error = "密码长度至少 8 位"
    elif password != confirm:
        error = "两次输入的密码不一致"
    else:
        try:
            service.set_admin_password(None, password, username=username)
        except SettingsError as exc:
            error = str(exc)
        else:
            _refresh_config(app)
            return redirect(url_for("login"))

    return render_template("setup.html", error=error, username=username), 400


def login():
    if session.get("logged_in"):
        return redirect("/")
    return render_template("login.html")


def login_submit():
    app = current_app._get_current_object()
    remote_addr = _client_ip()
    if _too_many_failures(remote_addr):
        LOGGER.warning("Dashboard login rate-limited for remote_addr=%r", remote_addr)
        return (
            render_template("login.html", error="尝试过于频繁，请稍后再试"),
            429,
        )

    auth = _config(app).dashboard.auth
    username = request.form.get("username", "")
    password = request.form.get("password", "")

    service = _settings_service(app)
    if service is not None:
        credentials_ok = bool(auth.enabled) and service.verify_admin(username, password)
    else:
        expected_username = auth.username or ""
        expected_password = auth.password or ""

        username_ok = hmac.compare_digest(username, expected_username)
        # An unset configured password must never authenticate (compare_digest
        # against "" would otherwise accept an empty password).
        password_ok = bool(expected_password) and hmac.compare_digest(
            password, expected_password
        )
        credentials_ok = bool(auth.enabled) and username_ok and password_ok

    if credentials_ok:
        _clear_failures(remote_addr)
        session.clear()
        session.permanent = True
        session["logged_in"] = True
        session["username"] = username
        return redirect("/")

    _record_failure(remote_addr)
    LOGGER.warning("Dashboard login failed for username=%r", username)
    return render_template("login.html", error="用户名或密码错误"), 401


def logout():
    session.clear()
    return redirect(url_for("login"))


def api_change_password():
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
        service.set_admin_password(
            payload.get("current_password"),
            payload.get("new_password"),
            username=payload.get("new_username"),
        )
    except SettingsError as exc:
        # SettingsError messages are user-facing and never contain a stack
        # trace or secret material.
        return jsonify({"error": str(exc)}), 400
    _refresh_config(app)
    return jsonify({"ok": True})


# Guards the per-address login-failure map.  Flask may serve the login route on
# multiple worker threads, and the plain dict/deque below are not otherwise safe
# against interleaved reads and writes.
_LOGIN_FAILURE_LOCK = threading.Lock()
# Upper bound on tracked addresses so a spray of rotating/spoofed source IPs
# cannot grow the map without limit.
_LOGIN_FAILURE_MAX_ENTRIES = 4096


def _login_failures() -> dict[str, deque]:
    return current_app.extensions.setdefault("login_failures", {})


def _client_ip() -> str:
    """Best-effort client address used to key the login throttle.

    Behind a local reverse proxy ``request.remote_addr`` is the proxy itself
    (loopback).  In that case trust the first hop of ``X-Forwarded-For`` so each
    real client gets its own bucket.  For a direct connection the header is
    ignored, so a remote client cannot spoof its way out of the throttle.
    """
    remote = request.remote_addr or ""
    if _is_loopback(remote):
        forwarded = request.headers.get("X-Forwarded-For", "")
        first = forwarded.split(",", 1)[0].strip()
        if first:
            return first
    return remote


def _prune_failure_map(failures_map: dict[str, deque], now: float) -> None:
    """Drop expired buckets, then evict the oldest if still over the cap."""
    for key in list(failures_map):
        bucket = failures_map.get(key)
        if bucket is None:
            continue
        while bucket and now - bucket[0] > _LOGIN_FAILURE_WINDOW_SECONDS:
            bucket.popleft()
        if not bucket:
            failures_map.pop(key, None)
    overflow = len(failures_map) - _LOGIN_FAILURE_MAX_ENTRIES
    if overflow > 0:
        ordered = sorted(
            failures_map.items(),
            key=lambda item: item[1][-1] if item[1] else 0.0,
        )
        for key, _bucket in ordered[:overflow]:
            failures_map.pop(key, None)


def _too_many_failures(remote_addr: str) -> bool:
    now = time.monotonic()
    with _LOGIN_FAILURE_LOCK:
        failures = _login_failures().get(remote_addr)
        if failures is None:
            return False
        while failures and now - failures[0] > _LOGIN_FAILURE_WINDOW_SECONDS:
            failures.popleft()
        return len(failures) >= _LOGIN_FAILURE_LIMIT


def _record_failure(remote_addr: str) -> None:
    now = time.monotonic()
    with _LOGIN_FAILURE_LOCK:
        failures_map = _login_failures()
        failures = failures_map.setdefault(remote_addr, deque())
        while failures and now - failures[0] > _LOGIN_FAILURE_WINDOW_SECONDS:
            failures.popleft()
        failures.append(now)
        _prune_failure_map(failures_map, now)


def _clear_failures(remote_addr: str) -> None:
    with _LOGIN_FAILURE_LOCK:
        _login_failures().pop(remote_addr, None)



def register_auth(app: Flask) -> None:
    app.add_url_rule('/setup', endpoint='setup', view_func=setup, methods=['GET', 'POST'])
    app.add_url_rule('/login', endpoint='login', view_func=login, methods=['GET'])
    app.add_url_rule('/login', endpoint='login_submit', view_func=login_submit, methods=['POST'])
    app.add_url_rule('/logout', endpoint='logout', view_func=logout, methods=['POST'])
    app.add_url_rule('/api/settings/password', endpoint='api_change_password', view_func=api_change_password, methods=['POST'])
