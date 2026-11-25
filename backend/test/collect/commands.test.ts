import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { STAGES, buildCommandMap } from '../../src/collect/commands';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

/**
 * The 21 command strings, transcribed from `servermanage/commands.py`.
 * Kept inline so the assertions still ran even where no Python exists; the
 * oracle test below re-derives the same map from the Python source itself.
 */
const EXPECTED: Record<string, string> = {
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

/** First interpreter that can `import sys`, or null if none is available. */
function findPython(): string | null {
  const candidates = [process.env.PYTHON, 'python', 'python3'].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-c', 'import sys'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const python = findPython();

describe('collect/commands', () => {
  it('exposes exactly the 21 recognised stages', () => {
    expect(Object.keys(STAGES)).toHaveLength(21);
    // keys and values coincide: STAGES is a self-describing enum.
    expect(Object.entries(STAGES).every(([key, value]) => key === value)).toBe(true);
    expect(Object.keys(buildCommandMap())).toHaveLength(21);
    expect(Object.keys(buildCommandMap()).sort()).toEqual([...Object.values(STAGES)].sort());
  });

  it('matches the command strings embedded from commands.py byte for byte', () => {
    expect(buildCommandMap()).toEqual(EXPECTED);
  });

  const oracle = python ? it : it.skip;
  oracle('is byte-for-byte identical to Python build_command_map()', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'commands-oracle-'));
    const script = path.join(dir, 'dump_commands.py');
    writeFileSync(
      script,
      [
        'import json',
        'from servermanage.commands import build_command_map',
        'print(json.dumps(build_command_map(), ensure_ascii=False))',
        '',
      ].join('\n'),
      { encoding: 'utf-8' },
    );
    try {
      const pythonPath = process.env.PYTHONPATH
        ? `${repoRoot}${path.delimiter}${process.env.PYTHONPATH}`
        : repoRoot;
      const stdout = execFileSync(python, [script], {
        cwd: repoRoot,
        encoding: 'utf-8',
        env: { ...process.env, PYTHONPATH: pythonPath, PYTHONIOENCODING: 'utf-8' },
        maxBuffer: 8 * 1024 * 1024,
      });
      const fromPython = JSON.parse(stdout.trim()) as Record<string, string>;
      expect(fromPython).toEqual(EXPECTED);
      expect(buildCommandMap()).toEqual(fromPython);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
