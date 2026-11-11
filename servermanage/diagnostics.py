"""基于最近快照的主机健康诊断（只读，不执行任何采集命令）。

页面上的“诊断与操作”只显示原始错误，运维还得自己判断严重程度。这里把快照里的
数据换算成若干条带级别的结论：采集新鲜度、CPU/负载/内存/磁盘/GPU/温度、服务检查、
磁盘阵列、账号异常。每条包含一句结论和一句建议，按严重程度排序，便于一眼扫完。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable

LEVEL_OK = "ok"
LEVEL_WARN = "warn"
LEVEL_CRIT = "crit"

_LEVEL_WEIGHT = {LEVEL_CRIT: 0, LEVEL_WARN: 1, LEVEL_OK: 2}


def _number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(str(value).strip().rstrip("%"))
    except (TypeError, ValueError):
        return None


def _row(key: str, level: str, title: str, detail: str, hint: str = "") -> dict[str, str]:
    return {
        "key": key,
        "level": level,
        "title": title,
        "detail": detail,
        "hint": hint,
    }


def _parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value)
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment


def _freshness_row(detail: dict[str, Any], now: datetime, poll_interval_seconds: int) -> dict[str, str]:
    success = detail.get("success")
    if success is False:
        errors = detail.get("errors") or []
        parts = []
        for err in errors[:2]:
            if isinstance(err, dict):
                parts.append(f"{err.get('stage') or 'unknown'}：{err.get('message') or '—'}")
            else:
                parts.append(str(err))
        message = "；".join(parts)
        return _row(
            "collect",
            LEVEL_CRIT,
            "最近一次采集失败",
            message or "采集没有成功完成",
            "先点「测试连接」确认 SSH 可达，再检查 sudo 密码或采集命令是否被拦截。",
        )
    if success is None:
        return _row(
            "collect",
            LEVEL_WARN,
            "还没有采集数据",
            "这台主机尚未完成首次采集。",
            "确认主机地址、账号与密钥后点「立即采集」。",
        )
    collected = _parse_time(detail.get("collected_at"))
    if collected is None:
        return _row("collect", LEVEL_OK, "采集正常", "采集时间未知，但最近一次采集成功。")
    age = (now - collected).total_seconds()
    if age < 0:
        age = 0
    minutes = int(age // 60)
    limit = max(int(poll_interval_seconds), 60) * 3
    if age > limit:
        return _row(
            "collect",
            LEVEL_WARN,
            "采集数据已过期",
            f"最近一次采集在 {minutes} 分钟前，超过轮询周期的 3 倍。",
            "确认后台调度是否在运行，或检查该主机的 SSH 连接是否超时。",
        )
    return _row(
        "collect",
        LEVEL_OK,
        "采集正常",
        f"最近一次采集在 {minutes} 分钟前。" if minutes else "刚刚完成采集。",
    )


def _usage_rows(metrics: dict[str, Any]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    cpu = _number(metrics.get("cpu_usage_percent"))
    if cpu is not None:
        level = LEVEL_CRIT if cpu >= 97 else (LEVEL_WARN if cpu >= 90 else LEVEL_OK)
        rows.append(
            _row(
                "cpu",
                level,
                "CPU 使用率",
                f"当前 {cpu:.1f}%",
                "查看高占用进程，或确认是否有训练任务把 GPU 机器打满。" if level != LEVEL_OK else "",
            )
        )

    cores = _number(metrics.get("cpu_core_count"))
    load = metrics.get("load_average") or {}
    load_1 = _number(load.get("load_1"))
    if load_1 is not None and cores:
        ratio = load_1 / cores if cores else 0
        level = LEVEL_CRIT if ratio >= 2 else (LEVEL_WARN if ratio >= 1.2 else LEVEL_OK)
        rows.append(
            _row(
                "load",
                level,
                "系统负载",
                f"1 分钟负载 {load_1:.2f}，{int(cores)} 核，平均每核 {ratio:.2f}",
                "负载持续高于核数通常意味着进程排队，结合 CPU 与磁盘 IO 一起看。" if level != LEVEL_OK else "",
            )
        )

    memory = metrics.get("memory") or {}
    used = _number(memory.get("used_mb"))
    total = _number(memory.get("total_mb"))
    if used is not None and total:
        percent = used / total * 100 if total else 0
        level = LEVEL_CRIT if percent >= 95 else (LEVEL_WARN if percent >= 90 else LEVEL_OK)
        rows.append(
            _row(
                "memory",
                level,
                "内存占用",
                f"{percent:.1f}%（{used:.0f} / {total:.0f} MB）",
                "接近上限会导致 OOM，建议确认常驻进程或及时扩容。" if level != LEVEL_OK else "",
            )
        )

    disks = metrics.get("disks") or []
    worst: tuple[float, str] | None = None
    for mount in disks:
        percent = _number(mount.get("used_percent"))
        if percent is None:
            continue
        if worst is None or percent > worst[0]:
            worst = (percent, str(mount.get("mount") or mount.get("path") or "—"))
    if worst is not None:
        percent, mount = worst
        level = LEVEL_CRIT if percent >= 95 else (LEVEL_WARN if percent >= 90 else LEVEL_OK)
        rows.append(
            _row(
                "disk",
                level,
                "磁盘使用率",
                f"最高的挂载点 {mount} 已用 {percent:.1f}%",
                "清理历史数据或日志；本工具自身的日志只保留 24 小时。" if level != LEVEL_OK else "",
            )
        )

    gpus = metrics.get("gpu_summary") or []
    if gpus:
        peak = None
        for gpu in gpus:
            used_mb = _number(gpu.get("memory_used_mb"))
            total_mb = _number(gpu.get("memory_total_mb"))
            if used_mb is None or not total_mb:
                continue
            percent = used_mb / total_mb * 100
            if peak is None or percent > peak[0]:
                peak = (percent, str(gpu.get("index")))
        if peak is not None:
            percent, index = peak
            level = LEVEL_CRIT if percent >= 97 else (LEVEL_WARN if percent >= 90 else LEVEL_OK)
            rows.append(
                _row(
                    "gpu_memory",
                    level,
                    "GPU 显存",
                    f"GPU {index} 显存已用 {percent:.1f}%",
                    "显存打满会让新任务直接 OOM，确认是否有残留进程。" if level != LEVEL_OK else "",
                )
            )
    return rows


def _temperature_row(detail: dict[str, Any]) -> dict[str, str] | None:
    metrics = detail.get("metrics") or {}
    values: list[float] = []
    for zone in metrics.get("thermal_zones") or []:
        value = _number(zone.get("celsius"))
        if value is not None:
            values.append(value)
    for gpu in metrics.get("gpu_summary") or []:
        value = _number(gpu.get("temperature_c"))
        if value is not None:
            values.append(value)
    if not values:
        return None
    hottest = max(values)
    level = LEVEL_CRIT if hottest >= 85 else (LEVEL_WARN if hottest >= 70 else LEVEL_OK)
    return _row(
        "temperature",
        level,
        "温度",
        f"最高 {hottest:.1f} °C",
        "检查风扇与机房温度；持续高温会触发降频。" if level != LEVEL_OK else "",
    )


def _check_row(detail: dict[str, Any]) -> dict[str, str] | None:
    checks = detail.get("checks") or []
    if not checks:
        return None
    failing = [c for c in checks if str(c.get("status")) not in ("ok",)]
    if not failing:
        return _row("checks", LEVEL_OK, "服务检查", f"{len(checks)} 项检查全部正常。")
    names = "、".join(str(c.get("check_name") or c.get("name") or "—") for c in failing[:4])
    return _row(
        "checks",
        LEVEL_WARN,
        "服务检查异常",
        f"{len(failing)} / {len(checks)} 项异常：{names}",
        "确认对应端口/进程是否在运行，必要时手动登录主机排查。",
    )


def _disk_health_row(detail: dict[str, Any]) -> dict[str, str] | None:
    disk = detail.get("disk")
    if not disk:
        return None
    status = str(disk.get("status") or "").lower()
    drives = disk.get("drives") or []
    total = len(drives)
    bad = [
        d
        for d in drives
        if str(d.get("health") or "").lower() not in ("healthy", "ok", "")
        or str(d.get("status") or "").lower() in ("failed", "offline")
    ]
    if status in ("error", "critical") or bad:
        return _row(
            "disk_health",
            LEVEL_CRIT,
            "磁盘阵列异常",
            f"{len(bad) or 1} 块盘状态异常（共 {total} 块）。",
            "尽快在磁盘健康页确认具体槽位，涉及换盘请先备份。",
        )
    if status in ("no_storcli", "unknown"):
        return _row(
            "disk_health",
            LEVEL_WARN,
            "磁盘健康不可用",
            disk.get("message") or "未获取到 storcli 输出。",
            "确认 storcli 路径与 sudo 免密配置；没有阵列卡的主机可忽略。",
        )
    if not drives:
        # 状态是 ok 但没有明细时，说“0 块盘全部健康”会误导，宁可不显示这一行。
        return None
    return _row("disk_health", LEVEL_OK, "磁盘阵列", f"{total} 块盘全部健康。")


def _account_row(detail: dict[str, Any]) -> dict[str, str] | None:
    users = detail.get("users") or []
    if not users:
        return None
    issues = [u for u in users if u.get("issues")]
    if not issues:
        return _row("accounts", LEVEL_OK, "服务器账号", f"{len(users)} 个普通账号无异常。")
    return _row(
        "accounts",
        LEVEL_WARN,
        "服务器账号异常",
        f"{len(issues)} / {len(users)} 个账号存在问题（目录缺失、所有者异常或未加入 docker 组）。",
        "在服务器用户页查看明细，必要时由管理员人工修复。",
    )


def build_host_diagnostics(
    detail: dict[str, Any],
    *,
    now: datetime | None = None,
    poll_interval_seconds: int = 600,
) -> list[dict[str, str]]:
    """Return diagnostic rows for *detail*, most severe first."""

    moment = now or datetime.now(timezone.utc)
    rows: list[dict[str, str]] = [_freshness_row(detail, moment, poll_interval_seconds)]
    if detail.get("success") is not False:
        rows.extend(_usage_rows(detail.get("metrics") or {}))
        for extra in (
            _temperature_row(detail),
            _check_row(detail),
            _disk_health_row(detail),
            _account_row(detail),
        ):
            if extra is not None:
                rows.append(extra)
    rows.sort(key=lambda row: _LEVEL_WEIGHT.get(row["level"], 9))
    return rows


def summarize_diagnostics(rows: Iterable[dict[str, str]]) -> dict[str, int]:
    """Count rows per level for the card badge."""

    counts = {LEVEL_CRIT: 0, LEVEL_WARN: 0, LEVEL_OK: 0}
    for row in rows:
        level = row.get("level")
        if level in counts:
            counts[level] += 1
    counts["attention"] = counts[LEVEL_CRIT] + counts[LEVEL_WARN]
    return counts
