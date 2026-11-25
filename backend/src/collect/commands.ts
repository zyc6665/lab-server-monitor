/**
 * Shell command templates for every collection stage.
 *
 * Byte-for-byte port of `servermanage/commands.py` (21 stages). The exact
 * quoting / escaping matters: these strings are executed verbatim on the
 * remote host, so do not reformat them.
 */
export const STAGES = {
  hostname: "hostname",
  os_release: "os_release",
  kernel: "kernel",
  uptime: "uptime",
  cpu_cores: "cpu_cores",
  cpu_usage: "cpu_usage",
  memory: "memory",
  disk: "disk",
  net: "net",
  thermal: "thermal",
  who: "who",
  total_processes: "total_processes",
  process_counts: "process_counts",
  top_cpu: "top_cpu",
  top_memory: "top_memory",
  pid_user_map: "pid_user_map",
  docker_containers: "docker_containers",
  docker_status: "docker_status",
  pid_container_map: "pid_container_map",
  gpu_summary: "gpu_summary",
  gpu_processes: "gpu_processes",
} as const;

/** Union of all collection stage identifiers (keys mirror the Python names). */
export type Stage = keyof typeof STAGES;

/** Returns the shell command template for every collection stage. */
export function buildCommandMap(): Record<Stage, string> {
  return {
    hostname: "hostname",
    os_release: "awk -F= '/^PRETTY_NAME=/{gsub(/\"/,\"\",$2); print $2}' /etc/os-release",
    kernel: "uname -r",
    uptime: "uptime",
    cpu_cores: "nproc",
    cpu_usage: "sh -c 'read _ u1 n1 s1 i1 io1 ir1 si1 st1 _ < /proc/stat; sleep 1; read _ u2 n2 s2 i2 io2 ir2 si2 st2 _ < /proc/stat; idle=$((i2+io2-i1-io1)); total=$((u2+n2+s2+i2+io2+ir2+si2+st2-u1-n1-s1-i1-io1-ir1-si1-st1)); if [ \"$total\" -le 0 ]; then printf \"0.0\\n\"; else awk -v idle=\"$idle\" -v total=\"$total\" \"BEGIN { printf \\\"%.1f\\\\n\\\", (1 - idle / total) * 100 }\"; fi'",
    memory: "free -m",
    disk: "df -hP",
    net: "awk -F'[: ]+' 'NR>2 && $2 != \"lo\" {rx += $3; tx += $11} END {printf \"%.0f %.0f\\n\", rx, tx}' /proc/net/dev",
    thermal: "for f in /sys/class/thermal/thermal_zone*/temp; do [ -r \"$f\" ] && printf '%s\t%s\n' \"$(cat \"$(dirname \"$f\")/type\" 2>/dev/null)\" \"$(cat \"$f\")\"; done 2>/dev/null",
    who: "who",
    total_processes: "ps -e --no-headers | wc -l",
    process_counts: "ps -eo user= | sort | uniq -c | sort -nr",
    top_cpu: "ps -eo user=,pid=,%cpu=,%mem=,etime=,args= --sort=-%cpu | head -n 10",
    top_memory: "ps -eo user=,pid=,%cpu=,%mem=,etime=,args= --sort=-%mem | head -n 10",
    pid_user_map: "ps -eo pid=,user=,args=",
    docker_containers: "docker ps --no-trunc --format '{{.ID}}\t{{.Names}}'",
    docker_status: "docker ps --no-trunc --format '{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}'",
    pid_container_map: "sh -c 'for proc in /proc/[0-9]*; do pid=${proc#/proc/}; [ -r \"$proc/cgroup\" ] || continue; line=$(grep -m1 -E \"/docker/[0-9a-f]{12,64}|docker-[0-9a-f]{12,64}\\\\.scope\" \"$proc/cgroup\" 2>/dev/null || true); [ -n \"$line\" ] || continue; printf \"%s\\t%s\\n\" \"$pid\" \"$line\"; done'",
    gpu_summary: "nvidia-smi --query-gpu=index,name,utilization.gpu,temperature.gpu,memory.used,memory.total,uuid --format=csv,noheader,nounits",
    gpu_processes: "nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory,process_name --format=csv,noheader,nounits",
  };
}
