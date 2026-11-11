"""按需读取 Docker 容器资源占用（只读）。

只在用户点击「刷新占用」时执行一次 ``docker stats --no-stream``，结果不落库、
不进入轮询，避免给被监控主机增加持续负载。
"""

from __future__ import annotations

from typing import Any

from servermanage.models import HostConfig

STATS_COMMAND = (
    "docker stats --no-stream --format "
    "'{{.Name}}\t{{.CPUPerc}}\t{{.MemPerc}}\t{{.MemUsage}}' 2>/dev/null"
)


def _percent(text: str) -> float | None:
    """``"3.42%"`` -> ``3.42``; 无法解析时返回 ``None``。"""
    raw = (text or "").strip().rstrip("%")
    if not raw:
        return None
    try:
        return round(float(raw), 1)
    except ValueError:
        return None


def parse_container_stats(output: str | None) -> list[dict[str, Any]]:
    """把 ``docker stats`` 的制表符输出解析成占用量列表。"""
    rows: list[dict[str, Any]] = []
    for line in (output or "").splitlines():
        parts = line.split("\t")
        if not parts or not parts[0].strip():
            continue
        name = parts[0].strip()
        cpu = _percent(parts[1]) if len(parts) > 1 else None
        memory_percent = _percent(parts[2]) if len(parts) > 2 else None
        memory_usage = parts[3].strip() if len(parts) > 3 else ""
        rows.append(
            {
                "name": name,
                "cpu_percent": cpu,
                "memory_percent": memory_percent,
                "memory_usage": memory_usage,
            }
        )
        if len(rows) >= 300:
            break
    rows.sort(key=lambda row: (row["cpu_percent"] is None, -(row["cpu_percent"] or 0.0)))
    return rows


def collect_container_stats(
    host: HostConfig, ssh: Any, timeout: int = 30
) -> list[dict[str, Any]]:
    """在已连接的主机上执行一次只读统计命令。"""
    result = ssh.run(STATS_COMMAND, timeout=timeout)
    if result is None:
        return []
    if getattr(result, "exit_status", None) not in (0, None):
        return []
    return parse_container_stats(getattr(result, "stdout", ""))
