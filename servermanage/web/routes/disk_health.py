"""Disk health page (M1: split out of ``register_routes``)."""

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
    _anchor,
    _config,
    _db_path,
    _disk_health_summary,
    _drive_sort_key,
    _to_local_iso,
    resolve_timezone,
    storage,
)


def disk_health_page():
    app = current_app._get_current_object()
    config = _config(app)
    db_path = _db_path(app)
    tz = resolve_timezone(config.app.timezone)
    healths = {
        item["host_name"]: item for item in storage.get_all_disk_health(db_path)
    }
    names = []
    for server in config.servers:
        if server.name not in names:
            names.append(server.name)
    for host_name in healths:
        if host_name not in names:
            names.append(host_name)

    addresses = {server.name: server.host for server in config.servers}
    groups = {server.name: (server.group or "未分组") for server in config.servers}
    host_rows: list[dict[str, Any]] = []
    drives: list[dict[str, Any]] = []
    totals = {"healthy": 0, "warning": 0, "critical": 0, "drives": 0}
    severity_rank = {"critical": 0, "warning": 1, "ok": 2, "unknown": 3, "error": 4, "no_storcli": 5}
    for host_name in names:
        health = healths.get(host_name)
        counts = _disk_health_summary(health)
        totals["healthy"] += counts["healthy"]
        totals["warning"] += counts["warning"]
        totals["critical"] += counts["critical"]
        totals["drives"] += counts["healthy"] + counts["warning"] + counts["critical"]
        host_drives: list[dict[str, Any]] = []
        for drive in (health or {}).get("physical_drives") or []:
            if not isinstance(drive, dict):
                continue
            item = dict(drive)
            item["host_name"] = host_name
            drives.append(item)
            host_drives.append(item)
        host_drives.sort(key=_drive_sort_key)
        temperatures = [
            drive["temperature_c"]
            for drive in host_drives
            if isinstance(drive.get("temperature_c"), (int, float))
        ]
        host_rows.append(
            {
                "name": host_name,
                "anchor": _anchor(host_name),
                "host": addresses.get(host_name),
                "group": groups.get(host_name, "未分组"),
                "status": counts["status"],
                "healthy": counts["healthy"],
                "warning": counts["warning"],
                "critical": counts["critical"],
                "needs_attention": bool(
                    counts["warning"]
                    or counts["critical"]
                    or counts["status"] in {"error", "no_storcli"}
                ),
                "controller_count": len((health or {}).get("controllers") or []),
                "vd_count": len((health or {}).get("virtual_drives") or []),
                "pd_count": len((health or {}).get("physical_drives") or []),
                "message": (health or {}).get("message"),
                "temperature_max": max(temperatures) if temperatures else None,
                "collected_at": _to_local_iso((health or {}).get("collected_at"), tz),
                "drives": host_drives,
                # 搜索用：主机、分组、地址加上盘型号/序列号，方便按盘找人。
                "search_text": " ".join(
                    filter(
                        None,
                        [
                            host_name,
                            groups.get(host_name, ""),
                            addresses.get(host_name) or "",
                            " ".join(
                                str(drive.get(key) or "")
                                for drive in host_drives
                                for key in ("model", "serial")
                            ),
                        ],
                    )
                ).lower(),
            }
        )
    # 有问题的主机排在前面，其余按名称排序，方便先看异常盘。
    host_rows.sort(
        key=lambda row: (severity_rank.get(row["status"], 9), row["name"].lower())
    )
    # 每个分组的合计：几台主机、多少块盘健康/告警/严重。
    group_stats: dict[str, dict[str, int]] = {}
    for row in host_rows:
        bucket = group_stats.setdefault(
            row["group"],
            {"hosts": 0, "healthy": 0, "warning": 0, "critical": 0, "max_temp": None},
        )
        bucket["hosts"] += 1
        bucket["healthy"] += row["healthy"]
        bucket["warning"] += row["warning"]
        bucket["critical"] += row["critical"]
        temp = row.get("temperature_max")
        if isinstance(temp, (int, float)) and (
            bucket["max_temp"] is None or temp > bucket["max_temp"]
        ):
            bucket["max_temp"] = float(temp)

    # 主机多于一个分组时，在每组第一台前面插一条分组头，方便按组查看。
    grouped_names = {row["group"] for row in host_rows}
    show_group_headers = len(grouped_names) > 1
    last_group = None
    for row in host_rows:
        row["group_header"] = None
        row["group_size"] = 0
        if not show_group_headers:
            continue
        if row["group"] != last_group:
            row["group_header"] = row["group"]
            row["group_size"] = sum(1 for item in host_rows if item["group"] == row["group"])
            last_group = row["group"]

    hot_temps = [
        drive["temperature_c"]
        for drive in drives
        if isinstance(drive.get("temperature_c"), (int, float))
    ]
    temperature_stats = {
        "max": max(hot_temps) if hot_temps else None,
        "average": round(sum(hot_temps) / len(hot_temps), 1) if hot_temps else None,
        "hot": sum(1 for value in hot_temps if value >= 55),
        "samples": len(hot_temps),
    }
    return render_template(
        "disk_health.html",
        active_page="disk_health",
        hosts=host_rows,
        drives=drives,
        totals=totals,
        temperature_stats=temperature_stats,
        group_stats=group_stats,
        has_groups=any(server.group and server.group != "未分组" for server in config.servers),
    )


def register_disk_health(app: Flask) -> None:
    app.add_url_rule('/disk-health', endpoint='disk_health_page', view_func=disk_health_page, methods=['GET'])
