from __future__ import annotations

HOSTNAME_STAGE = "hostname"
OS_STAGE = "os_release"
KERNEL_STAGE = "kernel"
UPTIME_STAGE = "uptime"
CPU_CORES_STAGE = "cpu_cores"
CPU_USAGE_STAGE = "cpu_usage"
MEMORY_STAGE = "memory"
DISK_STAGE = "disk"
NET_STAGE = "net"
THERMAL_STAGE = "thermal"
WHO_STAGE = "who"
TOTAL_PROCESSES_STAGE = "total_processes"
PROCESS_COUNTS_STAGE = "process_counts"
TOP_CPU_STAGE = "top_cpu"
TOP_MEM_STAGE = "top_memory"
PID_USER_STAGE = "pid_user_map"
DOCKER_CONTAINERS_STAGE = "docker_containers"
DOCKER_STATUS_STAGE = "docker_status"
PID_CONTAINER_STAGE = "pid_container_map"
GPU_SUMMARY_STAGE = "gpu_summary"
GPU_PROCESSES_STAGE = "gpu_processes"


def build_command_map() -> dict[str, str]:
    return {
        HOSTNAME_STAGE: "hostname",
        OS_STAGE: "awk -F= '/^PRETTY_NAME=/{gsub(/\"/,\"\",$2); print $2}' /etc/os-release",
        KERNEL_STAGE: "uname -r",
        UPTIME_STAGE: "uptime",
        CPU_CORES_STAGE: "nproc",
        CPU_USAGE_STAGE: (
            "sh -c 'read _ u1 n1 s1 i1 io1 ir1 si1 st1 _ < /proc/stat; "
            "sleep 1; "
            "read _ u2 n2 s2 i2 io2 ir2 si2 st2 _ < /proc/stat; "
            "idle=$((i2+io2-i1-io1)); "
            "total=$((u2+n2+s2+i2+io2+ir2+si2+st2-u1-n1-s1-i1-io1-ir1-si1-st1)); "
            "if [ \"$total\" -le 0 ]; then printf \"0.0\\n\"; "
            "else awk -v idle=\"$idle\" -v total=\"$total\" \"BEGIN { printf \\\"%.1f\\\\n\\\", (1 - idle / total) * 100 }\"; fi'"
        ),
        MEMORY_STAGE: "free -m",
        DISK_STAGE: "df -hP",
        NET_STAGE: (
            "awk -F'[: ]+' 'NR>2 && $2 != \"lo\" {rx += $3; tx += $11} "
            "END {printf \"%.0f %.0f\\n\", rx, tx}' /proc/net/dev"
        ),
        THERMAL_STAGE: (
            "for f in /sys/class/thermal/thermal_zone*/temp; do "
            "[ -r \"$f\" ] && printf '%s\t%s\n' "
            "\"$(cat \"$(dirname \"$f\")/type\" 2>/dev/null)\" \"$(cat \"$f\")\"; "
            "done 2>/dev/null"
        ),
        WHO_STAGE: "who",
        TOTAL_PROCESSES_STAGE: "ps -e --no-headers | wc -l",
        PROCESS_COUNTS_STAGE: "ps -eo user= | sort | uniq -c | sort -nr",
        TOP_CPU_STAGE: "ps -eo user=,pid=,%cpu=,%mem=,etime=,args= --sort=-%cpu | head -n 10",
        TOP_MEM_STAGE: "ps -eo user=,pid=,%cpu=,%mem=,etime=,args= --sort=-%mem | head -n 10",
        PID_USER_STAGE: "ps -eo pid=,user=,args=",
        DOCKER_CONTAINERS_STAGE: "docker ps --no-trunc --format '{{.ID}}\t{{.Names}}'",
        DOCKER_STATUS_STAGE: (
            "docker ps --no-trunc --format "
            "'{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}'"
        ),
        PID_CONTAINER_STAGE: (
            "sh -c 'for proc in /proc/[0-9]*; do "
            "pid=${proc#/proc/}; "
            "[ -r \"$proc/cgroup\" ] || continue; "
            "line=$(grep -m1 -E \"/docker/[0-9a-f]{12,64}|docker-[0-9a-f]{12,64}\\\\.scope\" \"$proc/cgroup\" 2>/dev/null || true); "
            "[ -n \"$line\" ] || continue; "
            "printf \"%s\\t%s\\n\" \"$pid\" \"$line\"; "
            "done'"
        ),
        GPU_SUMMARY_STAGE: (
            "nvidia-smi --query-gpu=index,name,utilization.gpu,temperature.gpu,memory.used,memory.total,uuid "
            "--format=csv,noheader,nounits"
        ),
        GPU_PROCESSES_STAGE: (
            "nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory,process_name "
            "--format=csv,noheader,nounits"
        ),
    }


__all__ = [
    "HOSTNAME_STAGE",
    "OS_STAGE",
    "KERNEL_STAGE",
    "UPTIME_STAGE",
    "CPU_CORES_STAGE",
    "CPU_USAGE_STAGE",
    "MEMORY_STAGE",
    "DISK_STAGE",
    "NET_STAGE",
    "THERMAL_STAGE",
    "WHO_STAGE",
    "TOTAL_PROCESSES_STAGE",
    "PROCESS_COUNTS_STAGE",
    "TOP_CPU_STAGE",
    "TOP_MEM_STAGE",
    "PID_USER_STAGE",
    "DOCKER_CONTAINERS_STAGE",
    "DOCKER_STATUS_STAGE",
    "PID_CONTAINER_STAGE",
    "GPU_SUMMARY_STAGE",
    "GPU_PROCESSES_STAGE",
    "build_command_map",
]
