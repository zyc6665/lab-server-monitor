from servermanage.commands import (
    CPU_CORES_STAGE,
    CPU_USAGE_STAGE,
    DISK_STAGE,
    GPU_PROCESSES_STAGE,
    GPU_SUMMARY_STAGE,
    HOSTNAME_STAGE,
    KERNEL_STAGE,
    MEMORY_STAGE,
    OS_STAGE,
    PID_USER_STAGE,
    PROCESS_COUNTS_STAGE,
    TOP_CPU_STAGE,
    TOP_MEM_STAGE,
    TOTAL_PROCESSES_STAGE,
    UPTIME_STAGE,
    WHO_STAGE,
)
from servermanage.models import AuthConfig, CommandResult, HostConfig
from servermanage.parsers import (
    parse_docker_container_names,
    parse_disk_usage,
    parse_gpu_summary,
    parse_host_metrics,
    parse_memory,
    parse_pid_container_map,
    parse_process_rows,
    parse_uptime,
    parse_who,
)


def test_parse_uptime_extracts_load_average():
    data = parse_uptime(" 09:00:00 up 12 days,  2 users,  load average: 2.15, 1.98, 1.76")
    assert data.load_1 == 2.15
    assert data.load_5 == 1.98
    assert data.load_15 == 1.76


def test_parse_memory_extracts_summary():
    data = parse_memory(
        """
              total        used        free      shared  buff/cache   available
Mem:          64000       41000        3000         120       20000       22000
Swap:          8192         512        7680
""".strip()
    )
    assert data.total_mb == 64000
    assert data.swap_used_mb == 512


def test_parse_disk_usage_extracts_rows():
    rows = parse_disk_usage(
        """
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1       300G  120G  180G  40% /
/dev/sdb1       4.0T  2.1T  1.9T  52% /data
""".strip()
    )
    assert rows[1].mountpoint == "/data"
    assert rows[1].percent == "52%"


def test_parse_disk_usage_skips_localized_header_row():
    rows = parse_disk_usage(
        """
文件系统        容量  已用  可用 已用% 挂载点
/dev/sda1       300G  120G  180G  40% /
/dev/sdb1       4.0T  2.1T  1.9T  52% /data
""".strip()
    )

    assert len(rows) == 2
    assert rows[0].mountpoint == "/"


def test_parse_process_rows_extracts_command():
    rows = parse_process_rows("trainuser 12345 311.2 12.4 18:20:11 python train.py")
    assert rows[0].pid == 12345
    assert rows[0].command == "python train.py"


def test_parse_gpu_summary_extracts_rows():
    rows = parse_gpu_summary("0, NVIDIA RTX 4090, 91, 67, 18200, 24564")
    assert rows[0].index == 0
    assert rows[0].memory_total_mb == 24564


def test_parse_who_supports_month_day_time_format():
    rows = parse_who("root pts/0 Mar 25 09:00 (10.0.0.2)")

    assert rows[0].login_at == "Mar 25 09:00"
    assert rows[0].remote_host == "10.0.0.2"


def test_parse_docker_container_names_maps_full_id_to_name():
    output = (
        "3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10\tzhangz-train\n"
    )

    mapping = parse_docker_container_names(output)

    assert mapping["3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10"] == "zhangz-train"


def test_parse_pid_container_map_extracts_container_id_from_cgroup_lines():
    output = (
        "123\t12:devices:/docker/3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10\n"
        "456\t0::/system.slice/docker-a7b9c2d4e6f8a7b9c2d4e6f8a7b9c2d4e6f8a7b9c2d4e6f8a7b9c2d4e6f8.scope\n"
    )

    mapping = parse_pid_container_map(output)

    assert mapping[123] == "3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10"
    assert mapping[456] == "a7b9c2d4e6f8a7b9c2d4e6f8a7b9c2d4e6f8a7b9c2d4e6f8a7b9c2d4e6f8"


def test_parse_host_metrics_builds_structured_payload():
    host = HostConfig(
        name="gpu-01",
        host="10.0.0.1",
        port=22,
        username="root",
        auth=AuthConfig(type="password", password="secret"),
    )
    results = {
        HOSTNAME_STAGE: CommandResult("gpu-01", "", 0),
        OS_STAGE: CommandResult("Ubuntu 22.04\n", "", 0),
        KERNEL_STAGE: CommandResult("5.15.0", "", 0),
        UPTIME_STAGE: CommandResult(" 09:00:00 up 12 days,  2 users,  load average: 2.15, 1.98, 1.76", "", 0),
        CPU_CORES_STAGE: CommandResult("16", "", 0),
        CPU_USAGE_STAGE: CommandResult("9.0", "", 0),
        MEMORY_STAGE: CommandResult(
            "              total        used        free      shared  buff/cache   available\nMem:          64000       41000        3000         120       20000       22000\nSwap:          8192         512        7680",
            "",
            0,
        ),
        DISK_STAGE: CommandResult("Filesystem Size Used Avail Use% Mounted on\n/dev/sda1 300G 120G 180G 40% /", "", 0),
        WHO_STAGE: CommandResult("root pts/0 2026-03-25 09:00 (10.0.0.2)", "", 0),
        TOTAL_PROCESSES_STAGE: CommandResult("123", "", 0),
        PROCESS_COUNTS_STAGE: CommandResult("82 root\n46 trainuser", "", 0),
        PID_USER_STAGE: CommandResult(
            "12345 root python train.py\n"
            "23456 root python eval.py\n"
            "34567 systemd-networkd /usr/lib/systemd/systemd-networkd",
            "",
            0,
        ),
        "docker_containers": CommandResult(
            "3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10\tzhangz-train",
            "",
            0,
        ),
        "pid_container_map": CommandResult(
            "12345\t12:devices:/docker/3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10\n"
            "23456\t12:devices:/docker/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "",
            0,
        ),
        TOP_CPU_STAGE: CommandResult("root 12345 311.2 12.4 18:20:11 python train.py", "", 0),
        TOP_MEM_STAGE: CommandResult("root 23456 111.2 22.4 08:20:11 python eval.py", "", 0),
        GPU_SUMMARY_STAGE: CommandResult("0, NVIDIA RTX 4090, 91, 67, 18200, 24564, GPU-UUID-0", "", 0),
        GPU_PROCESSES_STAGE: CommandResult("GPU-UUID-0, 12345, 16000, python train.py", "", 0),
    }

    metrics = parse_host_metrics(results, host)

    assert metrics.hostname == "gpu-01"
    assert metrics.cpu_core_count == 16
    assert metrics.cpu_usage_percent == 9.0
    assert metrics.total_processes == 123
    assert any(
        row.container_name == "zhangz-train" and row.username == "root" and row.count == 1
        for row in metrics.process_counts_by_user
    )
    assert metrics.top_cpu_processes[0].container_name == "zhangz-train"
    assert (
        metrics.top_memory_processes[0].container_id
        == "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    )
    assert metrics.gpu_summary[0].name == "NVIDIA RTX 4090"
    assert metrics.gpu_processes[0].username == "root"
