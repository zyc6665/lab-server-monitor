from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
import re

from jinja2 import Environment, FileSystemLoader, select_autoescape

from servermanage.models import DailyReport, HostReport, RenderedReport, WeeklyHostSummary, WeeklyReport


TEMPLATE_DIR = Path(__file__).with_name("templates")
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


def _build_environment() -> Environment:
    return Environment(
        loader=FileSystemLoader(str(TEMPLATE_DIR)),
        autoescape=select_autoescape(enabled_extensions=("html", "xml")),
        trim_blocks=True,
        lstrip_blocks=True,
    )


def _to_gib(value_mb: int | None) -> str:
    if value_mb is None:
        return "N/A"
    return f"{value_mb / 1024:.1f} GiB"


def _format_capacity_gib(value_gib: float | None) -> str:
    if value_gib is None:
        return "N/A"
    if value_gib >= 1024:
        return f"{value_gib / 1024:.1f} TiB"
    return f"{value_gib:.1f} GiB"


def _disk_percent_value(percent: str) -> int:
    digits = "".join(ch for ch in percent if ch.isdigit())
    if not digits:
        return -1
    return int(digits)


def _overview_text(host_report: HostReport) -> str:
    metrics = host_report.metrics
    cpu_text = "N/A" if metrics.cpu_usage_percent is None else f"{metrics.cpu_usage_percent:.1f}%"
    memory_text = "N/A"
    if metrics.memory is not None:
        memory_text = f"{_to_gib(metrics.memory.used_mb)}/{_to_gib(metrics.memory.total_mb)}"

    if metrics.disk_usage:
        disk_focus = max(metrics.disk_usage, key=lambda row: _disk_percent_value(row.percent))
        disk_text = f"{disk_focus.mountpoint} {disk_focus.percent}"
    else:
        disk_text = "N/A"

    gpu_text = "N/A" if not metrics.gpu_summary else f"GPU {len(metrics.gpu_summary)} active"
    return f"CPU {cpu_text} | MEM {memory_text} | DISK {disk_text} | {gpu_text}"


def _percent(used: int | None, total: int | None) -> float | None:
    if used is None or total in (None, 0):
        return None
    return round(used / total * 100, 1)


def _parse_capacity_to_gib(value: str) -> float | None:
    text = value.strip()
    if not text:
        return None
    match = re.fullmatch(r"([0-9]*\.?[0-9]+)\s*([A-Za-z]*)", text)
    if match is None:
        return None
    number = float(match.group(1))
    unit_text = match.group(2).upper()
    unit = ""
    if unit_text:
        unit = unit_text[0]
    factor = {
        "": 1 / (1024**3),
        "B": 1 / (1024**3),
        "K": 1 / (1024**2),
        "M": 1 / 1024,
        "G": 1,
        "T": 1024,
        "P": 1024**2,
        "E": 1024**3,
    }.get(unit)
    if factor is None:
        return None
    return number * factor


def _process_user_label(*, username: str, container_name: str | None = None, container_id: str | None = None) -> str:
    if container_name:
        return f"{container_name} | {username}"
    if container_id:
        return f"{container_id[:12]} | {username}"
    return username


def _process_row_context(rows) -> list[dict[str, object]]:
    return [
        {
            **asdict(row),
            "display_user": _process_user_label(
                username=row.username,
                container_name=getattr(row, "container_name", None),
                container_id=getattr(row, "container_id", None),
            ),
        }
        for row in rows
    ]


def _disk_peak(host_report: HostReport) -> dict[str, object] | None:
    if not host_report.metrics.disk_usage:
        return None
    row = max(host_report.metrics.disk_usage, key=lambda item: _disk_percent_value(item.percent))
    return {
        "mountpoint": row.mountpoint,
        "percent": row.percent,
        "value": _disk_percent_value(row.percent),
    }


def _is_virtual_filesystem(filesystem: str) -> bool:
    return filesystem.strip().lower() in _VIRTUAL_FILESYSTEMS


def _disk_total(host_report: HostReport) -> dict[str, object] | None:
    seen_filesystems: set[str] = set()
    total_gib = 0.0
    used_gib = 0.0
    available_gib = 0.0

    for row in host_report.metrics.disk_usage:
        filesystem = row.filesystem.strip()
        if not filesystem or filesystem in seen_filesystems or _is_virtual_filesystem(filesystem):
            continue
        size_gib = _parse_capacity_to_gib(row.size)
        used_row_gib = _parse_capacity_to_gib(row.used)
        available_row_gib = _parse_capacity_to_gib(row.available)
        if size_gib is None or used_row_gib is None or available_row_gib is None:
            continue
        seen_filesystems.add(filesystem)
        total_gib += size_gib
        used_gib += used_row_gib
        available_gib += available_row_gib

    if total_gib <= 0:
        return None

    used_percent = round(used_gib / total_gib * 100, 1)
    return {
        "total_gib": total_gib,
        "used_gib": used_gib,
        "available_gib": available_gib,
        "used_percent": used_percent,
        "display_text": f"已用 {_format_capacity_gib(used_gib)} / {_format_capacity_gib(total_gib)} ({used_percent:.1f}%)",
    }


def _gpu_peak(host_report: HostReport) -> dict[str, object] | None:
    if not host_report.metrics.gpu_summary:
        return None
    row = max(host_report.metrics.gpu_summary, key=lambda item: item.utilization_percent)
    return {
        "index": row.index,
        "name": row.name,
        "utilization_percent": row.utilization_percent,
        "memory_percent": _percent(row.memory_used_mb, row.memory_total_mb),
    }


def _gpu_total(host_report: HostReport) -> dict[str, object] | None:
    if not host_report.metrics.gpu_summary:
        return None
    total_memory_mb = sum(row.memory_total_mb for row in host_report.metrics.gpu_summary)
    used_memory_mb = sum(row.memory_used_mb for row in host_report.metrics.gpu_summary)
    if total_memory_mb <= 0:
        return None
    total_gib = total_memory_mb / 1024
    used_gib = used_memory_mb / 1024
    used_percent = round(used_memory_mb / total_memory_mb * 100, 1)
    return {
        "gpu_count": len(host_report.metrics.gpu_summary),
        "total_gib": total_gib,
        "used_gib": used_gib,
        "used_percent": used_percent,
        "display_text": f"已用 {_format_capacity_gib(used_gib)} / {_format_capacity_gib(total_gib)} ({used_percent:.1f}%)",
    }


def _host_status(host_report: HostReport) -> tuple[str, str]:
    if not host_report.success:
        return "异常", "#c2410c"
    metrics = host_report.metrics
    memory_percent = _percent(metrics.memory.used_mb, metrics.memory.total_mb) if metrics.memory else None
    disk_total = _disk_total(host_report)
    gpu_total = _gpu_total(host_report)
    if (
        host_report.errors
        or (metrics.cpu_usage_percent or 0) >= 85
        or (memory_percent or 0) >= 85
        or (disk_total and disk_total["used_percent"] >= 85)
        or (gpu_total and gpu_total["used_percent"] >= 85)
    ):
        return "关注", "#c2410c"
    return "正常", "#047857"


def _build_risk_items(report: DailyReport) -> list[str]:
    items: list[str] = []
    for host_report in report.reports:
        metrics = host_report.metrics
        if not host_report.success:
            items.append(f"{host_report.host_name}：主机采集失败")
            continue
        if host_report.errors:
            messages = "；".join(error.message for error in host_report.errors if error.message)
            items.append(f"{host_report.host_name}：采集异常：{messages or '未知错误'}")
        if (metrics.cpu_usage_percent or 0) >= 85:
            items.append(f"{host_report.host_name}：CPU 使用率 {metrics.cpu_usage_percent:.1f}%")
        memory_percent = _percent(metrics.memory.used_mb, metrics.memory.total_mb) if metrics.memory else None
        if (memory_percent or 0) >= 85:
            items.append(f"{host_report.host_name}：内存使用率 {memory_percent:.1f}%")
        disk_total = _disk_total(host_report)
        if disk_total and disk_total["used_percent"] >= 85:
            items.append(f"{host_report.host_name}：整体磁盘使用率 {disk_total['used_percent']:.1f}%")
        gpu_total = _gpu_total(host_report)
        if gpu_total and gpu_total["used_percent"] >= 85:
            items.append(f"{host_report.host_name}：整体 GPU 显存使用率 {gpu_total['used_percent']:.1f}%")
    return items[:5]


def _executive_host_context(host_report: HostReport) -> dict[str, object]:
    metrics = host_report.metrics
    memory_percent = _percent(metrics.memory.used_mb, metrics.memory.total_mb) if metrics.memory else None
    disk_total = _disk_total(host_report)
    gpu_total = _gpu_total(host_report)
    status_text, status_color = _host_status(host_report)
    ownership = metrics.process_counts_by_user[:3]
    ownership_text = (
        " | ".join(
            f"{_process_user_label(username=row.username, container_name=row.container_name, container_id=row.container_id)}={row.count}"
            for row in ownership
        )
        or "N/A"
    )
    return {
        "host_name": host_report.host_name,
        "host": host_report.host,
        "status_text": status_text,
        "status_color": status_color,
        "cpu_percent": metrics.cpu_usage_percent,
        "memory_percent": memory_percent,
        "disk_total": disk_total,
        "disk_total_text": disk_total["display_text"] if disk_total else "N/A",
        "gpu_total": gpu_total,
        "gpu_total_text": gpu_total["display_text"] if gpu_total else "N/A",
        "top_cpu_owner": (
            _process_user_label(
                username=metrics.top_cpu_processes[0].username,
                container_name=metrics.top_cpu_processes[0].container_name,
                container_id=metrics.top_cpu_processes[0].container_id,
            )
            if metrics.top_cpu_processes
            else "N/A"
        ),
        "top_memory_owner": (
            _process_user_label(
                username=metrics.top_memory_processes[0].username,
                container_name=metrics.top_memory_processes[0].container_name,
                container_id=metrics.top_memory_processes[0].container_id,
            )
            if metrics.top_memory_processes
            else "N/A"
        ),
        "ownership_text": ownership_text,
    }


def _host_context(host_report: HostReport) -> dict[str, object]:
    metrics = host_report.metrics
    metrics_dict = asdict(metrics)
    metrics_dict["top_cpu_processes"] = _process_row_context(metrics.top_cpu_processes)
    metrics_dict["top_memory_processes"] = _process_row_context(metrics.top_memory_processes)
    return {
        "host_name": host_report.host_name,
        "host": host_report.host,
        "success": host_report.success,
        "overview": _overview_text(host_report),
        "metrics": metrics_dict,
        "memory_used_gib": _to_gib(metrics.memory.used_mb) if metrics.memory else "N/A",
        "memory_total_gib": _to_gib(metrics.memory.total_mb) if metrics.memory else "N/A",
        "users_online": ", ".join(user.username for user in metrics.logged_in_users) or "None",
        "process_counts_text": " | ".join(
            f"{_process_user_label(username=row.username, container_name=row.container_name, container_id=row.container_id)}={row.count}"
            for row in metrics.process_counts_by_user
        )
        or "None",
        "errors": [asdict(error) for error in host_report.errors],
        "has_partial_errors": bool(host_report.errors),
    }


def _build_context(report: DailyReport) -> dict[str, object]:
    failed_hosts = [
        {
            "host_name": host_report.host_name,
            "host": host_report.host,
            "reason": "; ".join(error.message for error in host_report.errors) or "Unknown failure",
        }
        for host_report in report.reports
        if not host_report.success
    ]
    successful_count = sum(1 for host_report in report.reports if host_report.success)
    return {
        "subject": f"{report.subject_prefix} {report.generated_at:%Y-%m-%d}",
        "generated_at": report.generated_at.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "summary": {
            "total_hosts": len(report.reports),
            "success_count": successful_count,
            "failed_count": len(report.reports) - successful_count,
        },
        "failed_hosts": failed_hosts,
        "hosts": [_host_context(host_report) for host_report in report.reports],
    }


def _build_executive_context(report: DailyReport) -> dict[str, object]:
    executive_hosts = [_executive_host_context(host_report) for host_report in report.reports]
    risk_count = sum(1 for host in executive_hosts if host["status_text"] != "正常")
    return {
        "subject": f"{report.subject_prefix} {report.generated_at:%Y-%m-%d}",
        "generated_at": report.generated_at.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "summary": {
            "total_hosts": len(report.reports),
            "success_count": sum(1 for host_report in report.reports if host_report.success),
            "failed_count": sum(1 for host_report in report.reports if not host_report.success),
            "risk_count": risk_count,
        },
        "risk_items": _build_risk_items(report),
        "hosts": executive_hosts,
    }


def render_svg_line_chart(
    data_points: list[tuple[str, float | None]],
    *,
    width: int = 360,
    height: int = 120,
    title: str = "",
    y_max: float = 100.0,
) -> str:
    points = [(label, float(value)) for label, value in data_points if value is not None]
    if len(points) < 2:
        return f'<svg width="{width}" height="{height}" xmlns="http://www.w3.org/2000/svg"><text x="10" y="20" font-size="12" fill="#888">{title or "Chart"}: 数据不足</text></svg>'

    padding_left = 36
    padding_right = 12
    padding_top = 24
    padding_bottom = 28
    chart_width = width - padding_left - padding_right
    chart_height = height - padding_top - padding_bottom

    x_step = chart_width / (len(points) - 1)
    y_max = max(y_max, max(value for _, value in points))

    def _x(index: int) -> float:
        return padding_left + index * x_step

    def _y(value: float) -> float:
        return padding_top + chart_height - (value / y_max * chart_height)

    path_points = " ".join(f"{_x(i)},{_y(value)}" for i, (_, value) in enumerate(points))
    polyline = f'<polyline fill="none" stroke="#3b82f6" stroke-width="2" points="{path_points}" />'

    circle_points = "\n".join(
        f'<circle cx="{_x(i)}" cy="{_y(value)}" r="2.5" fill="#2563eb" />'
        for i, (_, value) in enumerate(points)
    )

    x_labels = "\n".join(
        f'<text x="{_x(i)}" y="{height - 8}" text-anchor="middle" font-size="9" fill="#666">{label[5:] if len(label) >= 5 else label}</text>'
        for i, (label, _) in enumerate(points)
    )

    y_ticks = [0, y_max / 2, y_max]
    y_labels = "\n".join(
        f'<text x="{padding_left - 6}" y="{_y(value) + 4}" text-anchor="end" font-size="9" fill="#666">{int(value)}</text>'
        for value in y_ticks
    )
    grid_lines = "\n".join(
        f'<line x1="{padding_left}" y1="{_y(value)}" x2="{width - padding_right}" y2="{_y(value)}" stroke="#e5e7eb" stroke-width="1" />'
        for value in y_ticks
    )
    axes = f'''
    <line x1="{padding_left}" y1="{padding_top}" x2="{padding_left}" y2="{height - padding_bottom}" stroke="#9ca3af" stroke-width="1" />
    <line x1="{padding_left}" y1="{height - padding_bottom}" x2="{width - padding_right}" y2="{height - padding_bottom}" stroke="#9ca3af" stroke-width="1" />
    '''

    title_text = f'<text x="{padding_left}" y="16" font-size="11" font-weight="bold" fill="#374151">{title}</text>' if title else ""

    return f'''<svg width="{width}" height="{height}" xmlns="http://www.w3.org/2000/svg" style="font-family: ui-sans-serif, system-ui, sans-serif;">
    {title_text}
    {grid_lines}
    {axes}
    {y_labels}
    {x_labels}
    {polyline}
    {circle_points}
</svg>
'''


def _weekly_host_context(host: WeeklyHostSummary) -> dict[str, object]:
    return {
        **asdict(host),
        "cpu_chart": render_svg_line_chart(
            [(str(point["day"]), point["cpu_avg"]) for point in host.daily_points],
            title="CPU 使用率 (%)",
        ),
        "memory_chart": render_svg_line_chart(
            [(str(point["day"]), point["memory_percent"]) for point in host.daily_points],
            title="内存使用率 (%)",
        ),
        "gpu_chart": render_svg_line_chart(
            [(str(point["day"]), point["gpu_util"]) for point in host.daily_points if point.get("gpu_util") is not None],
            title="GPU 利用率 (%)",
        ),
    }


def _build_weekly_context(report: WeeklyReport) -> dict[str, object]:
    with_data_count = sum(1 for host in report.summaries if host.sample_count > 0)
    insufficient_data_count = sum(
        1 for host in report.summaries if 0 < host.sample_count < 3
    )
    no_data_count = sum(1 for host in report.summaries if host.sample_count == 0)

    return {
        "subject": f"{report.subject_prefix} {report.week_start:%Y-%m-%d} ~ {report.week_end:%Y-%m-%d}",
        "generated_at": report.generated_at.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "week_range": f"{report.week_start:%Y-%m-%d} ~ {report.week_end:%Y-%m-%d}",
        "summary": {
            "total_hosts": len(report.summaries),
            "with_data_count": with_data_count,
            "insufficient_data_count": insufficient_data_count,
            "no_data_count": no_data_count,
        },
        "busy_hosts": [_weekly_host_context(host) for host in report.busy_hosts],
        "idle_hosts": [_weekly_host_context(host) for host in report.idle_hosts],
        "hosts": [_weekly_host_context(host) for host in report.summaries],
    }


def render_report(report: DailyReport | WeeklyReport, variant: str = "technical") -> RenderedReport:
    environment = _build_environment()
    if variant == "executive":
        context = _build_executive_context(report)  # type: ignore[arg-type]
        text_body = environment.get_template("report_executive.txt.j2").render(**context)
        html_body = environment.get_template("report_executive.html.j2").render(**context)
    elif variant == "weekly":
        context = _build_weekly_context(report)  # type: ignore[arg-type]
        text_body = environment.get_template("report_weekly.txt.j2").render(**context)
        html_body = environment.get_template("report_weekly.html.j2").render(**context)
    else:
        context = _build_context(report)  # type: ignore[arg-type]
        text_body = environment.get_template("report.txt.j2").render(**context)
        html_body = environment.get_template("report.html.j2").render(**context)
    return RenderedReport(subject=context["subject"], text_body=text_body, html_body=html_body)
