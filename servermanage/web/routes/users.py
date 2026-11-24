"""Server-user monitoring and provisioning (M1: split out of ``register_routes``)."""

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
    LOGGER,
    _EXECUTE_JOBS,
    _EXECUTE_JOBS_LOCK,
    _EXECUTE_JOB_TTL_SECONDS,
    _as_int,
    _build_user_rows,
    _build_users_payload,
    _config,
    _db_path,
    _monitor_service,
    _plan_cache,
    _resolve_user_present_alert,
    _run_execute_job,
    _view_mode,
    admin,
    datetime,
    resolve_timezone,
    secrets,
    storage,
    threading,
    time,
    timezone,
    user_mode,
)


def api_users():
    app = current_app._get_current_object()
    config = _config(app)
    payload = _build_users_payload(
        config,
        _db_path(app),
        host=request.args.get("host") or "",
        query=request.args.get("q") or "",
        status=(request.args.get("status") or "all").strip().lower(),
        tz=resolve_timezone(config.app.timezone),
    )
    return jsonify(payload)


def api_users_refresh():
    """Trigger a background user scan (Task 4 owns the worker)."""
    app = current_app._get_current_object()
    service = _monitor_service(app)
    refresh = getattr(service, "refresh_users", None)
    if not callable(refresh):
        return jsonify({"error": "unavailable"}), 503
    payload = request.get_json(silent=True)
    force_usage = bool(
        (payload or {}).get("usage") if isinstance(payload, dict) else False
    )
    try:
        result = refresh(force_usage=force_usage)
    except TypeError:  # pragma: no cover - legacy service without the kwarg
        result = refresh()
    except Exception:  # pragma: no cover - defensive, the caller sees JSON
        LOGGER.exception("refresh_users() failed")
        return jsonify({"error": "refresh_failed"}), 500
    if not isinstance(result, dict):
        result = {"ok": True}
    return jsonify(result), 200


def api_users_history():
    """Per-account usage history used by the 30-day sparkline."""
    app = current_app._get_current_object()
    host_name = (request.args.get("host") or "").strip()
    if not host_name:
        return jsonify({"error": "host_required"}), 400
    try:
        days = max(1, min(90, int(request.args.get("days") or 30)))
    except (TypeError, ValueError):
        return jsonify({"error": "invalid_days"}), 400
    series = storage.get_user_usage_series(
        host_name, _db_path(app), days=days
    )
    return jsonify({"host": host_name, "days": days, "accounts": series})


def api_users_top():
    """Rank accounts by usage growth across all monitored hosts."""
    app = current_app._get_current_object()
    try:
        days = max(1, min(90, int(request.args.get("days") or 7)))
    except (TypeError, ValueError):
        return jsonify({"error": "invalid_days"}), 400
    try:
        limit = max(1, min(20, int(request.args.get("limit") or 8)))
    except (TypeError, ValueError):
        return jsonify({"error": "invalid_limit"}), 400
    items = storage.top_user_growth(_db_path(app), days=days, limit=limit)
    return jsonify({"days": days, "items": items})


def api_users_refresh_status():
    """Poll the background user scan without ever failing the page."""
    app = current_app._get_current_object()
    service = _monitor_service(app)
    status = getattr(service, "user_scan_status", None)
    if not callable(status):
        return jsonify({"running": False, "error": "unavailable"})
    try:
        payload = status()
    except Exception:  # pragma: no cover - status must always be JSON
        LOGGER.exception("user_scan_status() failed")
        return jsonify({"running": False, "error": "unavailable"})
    if not isinstance(payload, dict):
        return jsonify({"running": False, "error": "unavailable"})
    return jsonify(payload)


def api_users_baseline_remove():
    """Forget a local baseline account (and resolve its open alert)."""
    app = current_app._get_current_object()
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_payload"}), 400
    host_name = payload.get("host")
    username = payload.get("username")
    if not isinstance(host_name, str) or not isinstance(username, str):
        return jsonify({"error": "invalid_payload"}), 400
    host_name = host_name.strip()
    username = username.strip()
    if not host_name or not username:
        return jsonify({"error": "invalid_payload"}), 400
    if host_name not in {server.name for server in _config(app).servers}:
        return jsonify({"error": "unknown_host"}), 400
    db_path = _db_path(app)
    # Only a *missing* account may be forgotten.  Removing a live account's
    # baseline would make the next scan report it as newly added.
    snapshot_names = {
        str(row.get("username"))
        for row in storage.get_host_user_snapshot(host_name, db_path)
    }
    if username in snapshot_names:
        return (
            jsonify(
                {
                    "error": "account_present",
                    "message": "该账号仍存在于主机上，无法清除基线",
                }
            ),
            409,
        )
    if not storage.delete_user_baseline(host_name, username, db_path):
        return jsonify({"error": "not_found"}), 404
    _resolve_user_present_alert(host_name, username, db_path)
    return jsonify({"ok": True, "removed": 1})


def api_users_plan():
    """Preview an account operation; the returned plan contains no secrets."""
    app = current_app._get_current_object()
    config = _config(app)
    server, error = _user_write_host(config)
    if error is not None:
        return error
    payload = request.get_json(silent=True) or {}
    db_path = _db_path(app)
    try:
        account = admin.validate_account_name(payload.get("account"))
        operation = str(payload.get("operation") or "").strip()
        rows = _build_user_rows(server.name, db_path, None, server)
        account_exists = any(
            row.get("username") == account and row.get("state") == "present"
            for row in rows
        )
        groups = next(
            (row.get("groups") or [] for row in rows if row.get("username") == account),
            [],
        )
        docker_group = bool(groups) or True
        plan = admin.build_plan(
            operation,
            host_name=server.name,
            account=account,
            password=payload.get("password") or None,
            account_exists=account_exists,
            docker_group=docker_group,
            data_supported=True,
            sudo_configured=bool(server.sudo_password),
            with_docker=bool(payload.get("with_docker", True)),
            with_data=bool(payload.get("with_data", True)),
        )
    except admin.AdminPlanError as exc:
        return jsonify({"error": "invalid_request", "message": str(exc)}), 400
    _plan_cache.put(plan)
    return jsonify({"ok": True, "plan": admin.public_plan(plan)})


def api_users_execute():
    """Run a previously previewed plan after the typed confirmation matches."""
    app = current_app._get_current_object()
    config = _config(app)
    payload = request.get_json(silent=True) or {}
    plan_hash = str(payload.get("plan_hash") or "").strip()
    plan = _plan_cache.get(plan_hash)
    if plan is None:
        return (
            jsonify(
                {
                    "error": "plan_expired",
                    "message": "执行计划已过期或不存在，请重新预览。",
                }
            ),
            410,
        )
    # The plan carries its own host; the gates are re-checked *now* so a
    # switch turned off between preview and confirm still blocks execution.
    server, error = _user_write_host(config, plan["host"])
    if error is not None:
        return error
    if plan["host"] != server.name:
        return jsonify({"error": "plan_mismatch", "message": "执行计划与主机不匹配。"}), 400
    if plan.get("blocked"):
        return (
            jsonify(
                {
                    "error": "plan_blocked",
                    "message": "这个执行计划已被判定为不可执行，请按提示处理后重新预览。",
                    "blocked_reasons": plan.get("blocked_reasons") or [],
                }
            ),
            400,
        )
    confirm_host = str(payload.get("confirm_host") or "").strip()
    confirm_account = str(payload.get("confirm_account") or "").strip()
    if confirm_host != plan["host"] or confirm_account != plan["account"]:
        return (
            jsonify(
                {
                    "error": "confirm_mismatch",
                    "message": "确认文本与主机名 / 账号名不一致，操作未执行。",
                }
            ),
            400,
        )
    actor = str(session.get("username") or "admin")
    started = datetime.now(timezone.utc)
    db_path = _db_path(app)
    host_config = next(
        (item for item in _config(app).servers if item.name == server.name), None
    )
    if host_config is None:
        return jsonify({"error": "unknown_host"}), 404

    masked = [
        {key: value for key, value in step.items() if key != "stdin"}
        for step in plan["steps"]
    ]
    job_id = secrets.token_hex(16)
    job: dict[str, Any] = {
        "id": job_id,
        "host": plan["host"],
        "account": plan["account"],
        "operation": plan["operation"],
        "actor": actor,
        "state": "running",
        "ok": None,
        "error": "",
        "steps": masked,
        "started_at": started.isoformat(),
        "finished_at": None,
        "_ts": time.monotonic(),
    }
    with _EXECUTE_JOBS_LOCK:
        stale = [
            key
            for key, item in _EXECUTE_JOBS.items()
            if time.monotonic() - item["_ts"] > _EXECUTE_JOB_TTL_SECONDS
        ]
        for key in stale:
            _EXECUTE_JOBS.pop(key, None)
        _EXECUTE_JOBS[job_id] = job
    # 计划在入队时立即作废：就算工作线程还没开始跑，重复提交也会被拒。
    _plan_cache.drop(plan_hash)
    threading.Thread(
        target=_run_execute_job,
        name="user-execute-job",
        daemon=True,
        kwargs=dict(
            app=app,
            job=job,
            plan=plan,
            plan_hash=plan_hash,
            host_config=host_config,
            connect_timeout=config.ssh.connect_timeout,
            actor=actor,
            started=started,
            db_path=db_path,
        ),
    ).start()
    return jsonify({"ok": True, "job_id": job_id})


def api_users_execute_status():
    """Poll a background provisioning job (masked steps only)."""
    app = current_app._get_current_object()
    job_id = (request.args.get("job_id") or "").strip()
    if not job_id:
        return jsonify({"error": "missing_job_id"}), 400
    with _EXECUTE_JOBS_LOCK:
        job = _EXECUTE_JOBS.get(job_id)
        snapshot: dict[str, Any] | None = None
        if job is not None:
            snapshot = {
                "id": job["id"],
                "host": job["host"],
                "account": job["account"],
                "operation": job["operation"],
                "actor": job["actor"],
                "state": job["state"],
                "ok": job["ok"],
                "error": job["error"],
                "steps": [dict(step) for step in job["steps"]],
                "started_at": job["started_at"],
                "finished_at": job["finished_at"],
            }
    if snapshot is None:
        return jsonify({"error": "unknown_job", "message": "任务不存在或已过期。"}), 404
    if _view_mode(_config(app)) == user_mode.MODE_USER and snapshot["actor"] != str(
        session.get("username") or ""
    ):
        return jsonify({"error": "forbidden", "message": "只能查看自己的操作任务。"}), 403
    return jsonify(snapshot)


def api_users_operations():
    """Recent provisioning attempts (audit trail, newest first)."""
    app = current_app._get_current_object()
    config = _config(app)
    host_name = (request.args.get("host") or "").strip()
    if host_name and host_name not in {server.name for server in config.servers}:
        return jsonify({"error": "unknown_host"}), 404
    limit = _as_int(request.args.get("limit"), 20)
    items = storage.list_user_operations(
        _db_path(app), host_name=host_name or None, limit=limit
    )
    return jsonify({"items": items})


def users_page():
    return render_template("users.html", active_page="users")


def _user_write_host(config, host_name: str | None = None):
    """Return ``(server, error)`` for an account-provisioning request.

    Every gate must pass: the global write switch, the per-host switch and a
    stored sudo password.  Failing closed keeps a stolen session from
    creating accounts on a host the administrator never enabled.

    ``host_name`` is passed explicitly by ``/api/users/execute`` (the plan
    already carries it); otherwise it is read from the JSON body.
    """
    if not config.user_monitoring.write_enabled:
        return None, (
            jsonify(
                {
                    "error": "write_disabled",
                    "message": "账号写操作总开关未开启。请到设置 → 服务器用户监控里开启。",
                }
            ),
            403,
        )
    if host_name is None:
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return None, (jsonify({"error": "invalid_payload"}), 400)
        host_name = str(payload.get("host") or "").strip()
    server = next(
        (item for item in config.servers if item.name == host_name), None
    )
    if server is None:
        return None, (jsonify({"error": "unknown_host"}), 404)
    if not server.allow_user_write:
        return None, (
            jsonify(
                {
                    "error": "host_write_disabled",
                    "message": f"{host_name} 未开启“允许账号写操作”，请先在该主机设置里打开。",
                }
            ),
            403,
        )
    if not server.sudo_password:
        return None, (
            jsonify(
                {
                    "error": "sudo_password_missing",
                    "message": "这台主机还没有配置 sudo 密码，无法执行需要 root 的操作。",
                }
            ),
            403,
        )
    return server, None



def register_users(app: Flask) -> None:
    app.add_url_rule('/api/users', endpoint='api_users', view_func=api_users, methods=['GET'])
    app.add_url_rule('/api/users/refresh', endpoint='api_users_refresh', view_func=api_users_refresh, methods=['POST'])
    app.add_url_rule('/api/users/history', endpoint='api_users_history', view_func=api_users_history, methods=['GET'])
    app.add_url_rule('/api/users/top', endpoint='api_users_top', view_func=api_users_top, methods=['GET'])
    app.add_url_rule('/api/users/refresh-status', endpoint='api_users_refresh_status', view_func=api_users_refresh_status, methods=['GET'])
    app.add_url_rule('/api/users/baseline/remove', endpoint='api_users_baseline_remove', view_func=api_users_baseline_remove, methods=['POST'])
    app.add_url_rule('/api/users/plan', endpoint='api_users_plan', view_func=api_users_plan, methods=['POST'])
    app.add_url_rule('/api/users/execute', endpoint='api_users_execute', view_func=api_users_execute, methods=['POST'])
    app.add_url_rule('/api/users/execute/status', endpoint='api_users_execute_status', view_func=api_users_execute_status, methods=['GET'])
    app.add_url_rule('/api/users/operations', endpoint='api_users_operations', view_func=api_users_operations, methods=['GET'])
    app.add_url_rule('/users', endpoint='users_page', view_func=users_page, methods=['GET'])
