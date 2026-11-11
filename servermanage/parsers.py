from __future__ import annotations

import csv
import re
from collections import Counter
from datetime import datetime, timezone
from dataclasses import replace

from servermanage.commands import (
    CPU_CORES_STAGE,
    CPU_USAGE_STAGE,
    DISK_STAGE,
    DOCKER_CONTAINERS_STAGE,
    GPU_PROCESSES_STAGE,
    GPU_SUMMARY_STAGE,
    HOSTNAME_STAGE,
    KERNEL_STAGE,
    MEMORY_STAGE,
    NET_STAGE,
    OS_STAGE,
    PID_CONTAINER_STAGE,
    PID_USER_STAGE,
    PROCESS_COUNTS_STAGE,
    TOP_CPU_STAGE,
    TOP_MEM_STAGE,
    TOTAL_PROCESSES_STAGE,
    UPTIME_STAGE,
    WHO_STAGE,
)
from servermanage.models import (
    CommandResult,
    DiskUsageRow,
    GPUProcessRow,
    GPUSummaryRow,
    HostConfig,
    HostMetrics,
    LoadAverage,
    LoggedInUser,
    MemorySummary,
    ProcessRow,
    UserProcessCount,
)

_LOAD_RE = re.compile(r"load average:\s*([0-9]*\.?[0-9]+),?\s*([0-9]*\.?[0-9]+),?\s*([0-9]*\.?[0-9]+)")
_UPTIME_RE = re.compile(r"\bup\s+(.+?),\s+\d+\s+user")
_NUMBER_RE = re.compile(r"-?[0-9]+(?:\.[0-9]+)?")
_CPU_IDLE_RE = re.compile(r"([0-9]*\.?[0-9]+)\s*id")
_CONTAINER_CGROUP_RE = re.compile(r"/docker/([0-9a-f]{12,64})|docker-([0-9a-f]{12,64})\.scope")


def _first_line(value: str) -> str | None:
    text = value.strip()
    if not text:
        return None
    return text.splitlines()[0].strip()


def _to_int(value: str) -> int | None:
    match = _NUMBER_RE.search(value.strip())
    if match is None:
        return None
    try:
        return int(float(match.group(0)))
    except ValueError:
        return None


def _to_float(value: str) -> float | None:
    match = _NUMBER_RE.search(value.strip())
    if match is None:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def _stdout_if_ok(results: dict[str, CommandResult], stage: str) -> str:
    result = results.get(stage)
    if result is None or result.exit_status != 0:
        return ""
    return result.stdout


def _stdout_if_ok_any(results: dict[str, CommandResult], stages: list[str]) -> str:
    for stage in stages:
        output = _stdout_if_ok(results, stage)
        if output:
            return output
    return ""


def parse_uptime(output: str) -> LoadAverage | None:
    match = _LOAD_RE.search(output)
    if match is None:
        return None
    return LoadAverage(
        load_1=float(match.group(1)),
        load_5=float(match.group(2)),
        load_15=float(match.group(3)),
    )


def parse_uptime_text(output: str) -> str | None:
    if not output.strip():
        return None
    match = _UPTIME_RE.search(output)
    if match is not None:
        return match.group(1).strip()
    return output.strip()


def parse_os_pretty_name(output: str) -> str | None:
    line = _first_line(output)
    if line is None:
        return None
    if line.startswith("PRETTY_NAME="):
        value = line.split("=", 1)[1].strip()
        return value.strip('"')
    return line


def parse_memory_summary(output: str) -> MemorySummary | None:
    mem_values: list[int] | None = None
    swap_values: list[int] | None = None
    for line in output.splitlines():
        text = line.strip()
        if text.startswith("Mem:"):
            parts = text.split()
            if len(parts) >= 7:
                ints = [_to_int(part) for part in parts[1:7]]
                if all(value is not None for value in ints):
                    mem_values = [int(value) for value in ints if value is not None]
        elif text.startswith("Swap:"):
            parts = text.split()
            if len(parts) >= 4:
                ints = [_to_int(part) for part in parts[1:4]]
                if all(value is not None for value in ints):
                    swap_values = [int(value) for value in ints if value is not None]
    if mem_values is None:
        return None
    if swap_values is None:
        swap_values = [0, 0, 0]
    return MemorySummary(
        total_mb=mem_values[0],
        used_mb=mem_values[1],
        free_mb=mem_values[2],
        shared_mb=mem_values[3],
        buff_cache_mb=mem_values[4],
        available_mb=mem_values[5],
        swap_total_mb=swap_values[0],
        swap_used_mb=swap_values[1],
        swap_free_mb=swap_values[2],
    )


def parse_memory(output: str) -> MemorySummary | None:
    return parse_memory_summary(output)


def parse_disk_usage(output: str) -> list[DiskUsageRow]:
    rows: list[DiskUsageRow] = []
    for raw in output.splitlines():
        line = raw.strip()
        if not line or line.lower().startswith("filesystem"):
            continue
        parts = line.split(None, 5)
        if len(parts) < 6:
            continue
        if _to_int(parts[4]) is None:
            continue
        rows.append(
            DiskUsageRow(
                filesystem=parts[0],
                size=parts[1],
                used=parts[2],
                available=parts[3],
                percent=parts[4],
                mountpoint=parts[5],
            )
        )
    return rows


def parse_who(output: str) -> list[LoggedInUser]:
    users: list[LoggedInUser] = []
    for raw in output.splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 4:
            continue
        remote_host: str | None = None
        login_parts = parts[2:]
        if parts[-1].startswith("(") and parts[-1].endswith(")"):
            remote_host = parts[-1].strip("()") or None
            login_parts = parts[2:-1]
        users.append(
            LoggedInUser(
                username=parts[0],
                terminal=parts[1],
                login_at=" ".join(login_parts).strip(),
                remote_host=remote_host,
            )
        )
    return users


def parse_process_counts(output: str) -> list[UserProcessCount]:
    counts: list[UserProcessCount] = []
    for raw in output.splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        count = _to_int(parts[0])
        if count is None:
            continue
        username = parts[1].strip()
        if not username:
            continue
        counts.append(UserProcessCount(username=username, count=count))
    return counts


def parse_process_rows(output: str) -> list[ProcessRow]:
    rows: list[ProcessRow] = []
    for raw in output.splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split(None, 5)
        if len(parts) < 6:
            continue
        pid = _to_int(parts[1])
        cpu_percent = _to_float(parts[2])
        mem_percent = _to_float(parts[3])
        if pid is None or cpu_percent is None or mem_percent is None:
            continue
        rows.append(
            ProcessRow(
                username=parts[0],
                pid=pid,
                cpu_percent=cpu_percent,
                mem_percent=mem_percent,
                elapsed=parts[4],
                command=parts[5],
            )
        )
    return rows


def parse_docker_container_names(output: str) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for raw in output.splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split("\t", 1)
        if len(parts) != 2:
            continue
        container_id = parts[0].strip()
        container_name = parts[1].strip()
        if not container_id or not container_name:
            continue
        mapping[container_id] = container_name
    return mapping


def parse_pid_container_map(output: str) -> dict[int, str]:
    mapping: dict[int, str] = {}
    for raw in output.splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split("\t", 1)
        if len(parts) != 2:
            continue
        pid = _to_int(parts[0])
        if pid is None:
            continue
        ref = parts[1].strip()
        if not ref:
            continue
        if re.fullmatch(r"[0-9a-f]{12,64}", ref):
            mapping[pid] = ref
            continue
        match = _CONTAINER_CGROUP_RE.search(ref)
        if match is None:
            continue
        mapping[pid] = match.group(1) or match.group(2)
    return mapping


def parse_nvidia_smi_summary_with_uuid(output: str) -> tuple[list[GPUSummaryRow], dict[str, int]]:
    rows: list[GPUSummaryRow] = []
    uuid_to_index: dict[str, int] = {}
    reader = csv.reader(output.splitlines(), skipinitialspace=True)
    for row in reader:
        if len(row) < 6:
            continue
        index = _to_int(row[0])
        utilization = _to_int(row[2])
        temperature = _to_int(row[3])
        memory_used = _to_int(row[4])
        memory_total = _to_int(row[5])
        if index is None or utilization is None or memory_used is None or memory_total is None:
            continue
        rows.append(
            GPUSummaryRow(
                index=index,
                name=row[1].strip(),
                utilization_percent=utilization,
                temperature_c=temperature,
                memory_used_mb=memory_used,
                memory_total_mb=memory_total,
            )
        )
        if len(row) >= 7 and row[6].strip():
            uuid_to_index[row[6].strip()] = index
    return rows, uuid_to_index


def parse_gpu_summary(output: str) -> list[GPUSummaryRow]:
    rows, _ = parse_nvidia_smi_summary_with_uuid(output)
    return rows


def parse_nvidia_smi_summary(output: str) -> list[GPUSummaryRow]:
    rows, _ = parse_nvidia_smi_summary_with_uuid(output)
    return rows


def parse_gpu_summary(output: str) -> list[GPUSummaryRow]:
    return parse_nvidia_smi_summary(output)


def parse_nvidia_smi_processes(
    output: str,
    *,
    uuid_to_index: dict[str, int] | None = None,
    pid_to_user: dict[int, str] | None = None,
    pid_to_command: dict[int, str] | None = None,
) -> list[GPUProcessRow]:
    uuid_to_index = uuid_to_index or {}
    pid_to_user = pid_to_user or {}
    pid_to_command = pid_to_command or {}

    rows: list[GPUProcessRow] = []
    reader = csv.reader(output.splitlines(), skipinitialspace=True)
    for row in reader:
        if len(row) < 3:
            continue
        gpu_ref = row[0].strip()
        pid = _to_int(row[1])
        memory_used = _to_int(row[2])
        if pid is None or memory_used is None:
            continue
        if gpu_ref.isdigit():
            index = int(gpu_ref)
        else:
            index = uuid_to_index.get(gpu_ref, -1)
        command = row[3].strip() if len(row) >= 4 and row[3].strip() else pid_to_command.get(pid, "")
        rows.append(
            GPUProcessRow(
                index=index,
                pid=pid,
                username=pid_to_user.get(pid),
                memory_used_mb=memory_used,
                command=command,
            )
        )
    return rows


def parse_pid_user_command_map(output: str) -> tuple[dict[int, str], dict[int, str]]:
    pid_to_user: dict[int, str] = {}
    pid_to_command: dict[int, str] = {}
    for raw in output.splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split(None, 2)
        if len(parts) < 2:
            continue
        pid = _to_int(parts[0])
        if pid is None:
            continue
        pid_to_user[pid] = parts[1]
        if len(parts) >= 3:
            pid_to_command[pid] = parts[2]
    return pid_to_user, pid_to_command


def parse_total_processes(output: str) -> int | None:
    return _to_int(output)


def parse_cpu_usage_percent(output: str) -> float | None:
    if not output.strip():
        return None
    idle_match = _CPU_IDLE_RE.search(output)
    if idle_match is not None:
        try:
            idle = float(idle_match.group(1))
            return round(100.0 - idle, 1)
        except ValueError:
            return None
    return _to_float(output)


def parse_gpu_uuid_map(output: str) -> dict[str, int]:
    uuid_to_index: dict[str, int] = {}
    for row in csv.reader(output.splitlines(), skipinitialspace=True):
        if len(row) < 2:
            continue
        index = _to_int(row[0])
        uuid = row[1].strip()
        if index is None or not uuid:
            continue
        uuid_to_index[uuid] = index
    return uuid_to_index


def _attach_container_context(
    rows: list[ProcessRow],
    *,
    pid_to_container: dict[int, str],
    container_names: dict[str, str],
) -> list[ProcessRow]:
    enriched: list[ProcessRow] = []
    for row in rows:
        container_id = pid_to_container.get(row.pid)
        enriched.append(
            replace(
                row,
                container_id=container_id,
                container_name=container_names.get(container_id) if container_id else None,
            )
        )
    return enriched


def _build_process_counts_by_user(
    *,
    pid_to_user: dict[int, str],
    pid_to_container: dict[int, str],
    container_names: dict[str, str],
) -> list[UserProcessCount]:
    counter: Counter[tuple[str | None, str | None, str]] = Counter()
    for pid, username in pid_to_user.items():
        container_id = pid_to_container.get(pid)
        counter[(container_id, container_names.get(container_id) if container_id else None, username)] += 1

    rows = [
        UserProcessCount(
            username=username,
            count=count,
            container_id=container_id,
            container_name=container_name,
        )
        for (container_id, container_name, username), count in counter.items()
    ]
    rows.sort(
        key=lambda row: (
            -row.count,
            0 if (row.container_name or row.container_id) else 1,
            row.container_name or row.container_id or "",
            row.username,
        )
    )
    return rows


def parse_net_totals(text: str | None) -> tuple[int | None, int | None]:
    """Parse aggregated ``rx tx`` byte counters produced by the probe command.

    ``/proc/net/dev`` reports cumulative counters; the rate is derived later by
    comparing two consecutive samples, so this helper only validates the two
    integers and rejects anything unexpected instead of guessing.
    """
    if not text:
        return None, None
    parts = text.split()
    if len(parts) < 2:
        return None, None
    try:
        rx = int(float(parts[0]))
        tx = int(float(parts[1]))
    except (TypeError, ValueError):
        return None, None
    if rx < 0 or tx < 0:
        return None, None
    return rx, tx


def parse_host_metrics(results: dict[str, CommandResult], host: HostConfig) -> HostMetrics:
    uptime_output = _stdout_if_ok(results, UPTIME_STAGE)
    gpu_summary_rows, uuid_to_index = parse_nvidia_smi_summary_with_uuid(
        _stdout_if_ok(results, GPU_SUMMARY_STAGE)
    )
    uuid_to_index.update(parse_gpu_uuid_map(_stdout_if_ok_any(results, ["gpu_uuid_map"])))
    pid_to_user, pid_to_command = parse_pid_user_command_map(
        _stdout_if_ok_any(results, [PID_USER_STAGE, "pid_user_map"])
    )
    container_names = parse_docker_container_names(
        _stdout_if_ok_any(results, [DOCKER_CONTAINERS_STAGE, "docker_containers"])
    )
    pid_to_container = parse_pid_container_map(
        _stdout_if_ok_any(results, [PID_CONTAINER_STAGE, "pid_container_map"])
    )
    top_cpu_processes = _attach_container_context(
        parse_process_rows(_stdout_if_ok_any(results, [TOP_CPU_STAGE, "top_cpu_processes"])),
        pid_to_container=pid_to_container,
        container_names=container_names,
    )
    top_memory_processes = _attach_container_context(
        parse_process_rows(_stdout_if_ok_any(results, [TOP_MEM_STAGE, "top_memory_processes"])),
        pid_to_container=pid_to_container,
        container_names=container_names,
    )
    process_counts = (
        _build_process_counts_by_user(
            pid_to_user=pid_to_user,
            pid_to_container=pid_to_container,
            container_names=container_names,
        )
        if pid_to_user
        else parse_process_counts(_stdout_if_ok_any(results, [PROCESS_COUNTS_STAGE, "process_counts_by_user"]))
    )
    net_rx_bytes, net_tx_bytes = parse_net_totals(
        _stdout_if_ok_any(results, [NET_STAGE, "net_dev"])
    )
    return HostMetrics(
        hostname=_first_line(_stdout_if_ok(results, HOSTNAME_STAGE)) or host.name,
        os_pretty_name=parse_os_pretty_name(_stdout_if_ok(results, OS_STAGE)),
        kernel_version=_first_line(_stdout_if_ok(results, KERNEL_STAGE)),
        uptime=parse_uptime_text(uptime_output),
        collected_at=datetime.now(timezone.utc),
        load_average=parse_uptime(uptime_output),
        cpu_core_count=_to_int(_stdout_if_ok_any(results, [CPU_CORES_STAGE, "cpu_count"])),
        cpu_usage_percent=parse_cpu_usage_percent(_stdout_if_ok(results, CPU_USAGE_STAGE)),
        memory=parse_memory_summary(_stdout_if_ok(results, MEMORY_STAGE)),
        disk_usage=parse_disk_usage(_stdout_if_ok(results, DISK_STAGE)),
        logged_in_users=parse_who(_stdout_if_ok_any(results, [WHO_STAGE, "logged_in_users"])),
        total_processes=parse_total_processes(_stdout_if_ok(results, TOTAL_PROCESSES_STAGE)),
        process_counts_by_user=process_counts,
        top_cpu_processes=top_cpu_processes,
        top_memory_processes=top_memory_processes,
        gpu_summary=gpu_summary_rows,
        gpu_processes=parse_nvidia_smi_processes(
            _stdout_if_ok(results, GPU_PROCESSES_STAGE),
            uuid_to_index=uuid_to_index,
            pid_to_user=pid_to_user,
            pid_to_command=pid_to_command,
        ),
        net_rx_bytes=net_rx_bytes,
        net_tx_bytes=net_tx_bytes,
    )
