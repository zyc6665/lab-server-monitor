/**
 * Unit tests for `backend/src/collect/parsers.ts` — the GPU parsers and the
 * `parseHostMetrics` assembly ported from the Python oracle
 * `servermanage/parsers.py` (lines 340-565).
 *
 * Sample stdout strings are transcribed from the Python oracle tests:
 * - `tests/test_parsers.py` (GPU summary row + the full `parse_host_metrics`
 *   structured-payload fixture)
 * - `tests/test_v0230_gpu_processes.py` (GPU process ordering by memory)
 * - `tests/test_v0175_network.py` (network totals through `parse_host_metrics`)
 * plus the "no GPU / not found / garbage" cases the port must survive.
 *
 * Expected values are derived from a direct reading of the Python functions in
 * `servermanage/parsers.py` so the assertions pin its exact semantics
 * (CSV `skipinitialspace`, uuid->index, pid->user/command joins, sorting, and
 * `emptyHostMetrics()` defaults for absent stages).
 */
import { describe, expect, it } from 'vitest';

import {
  parseGpuProcesses,
  parseGpuSummary,
  parseHostMetrics,
  parseNvidiaSmiSummaryWithUuid,
  parsePidUserCommandMap,
} from '../../src/collect/parsers';

const UUID_0 = 'GPU-UUID-0';

const FULL_RAW = {
  hostname: 'gpu-01\n',
  os_release: 'Ubuntu 22.04\n',
  kernel: '5.15.0\n',
  uptime: ' 09:00:00 up 12 days,  2 users,  load average: 2.15, 1.98, 1.76',
  cpu_cores: '16',
  cpu_usage: '9.0',
  memory:
    '              total        used        free      shared  buff/cache   available\n' +
    'Mem:          64000       41000        3000         120       20000       22000\n' +
    'Swap:          8192         512        7680',
  disk: 'Filesystem Size Used Avail Use% Mounted on\n/dev/sda1 300G 120G 180G 40% /',
  who: 'root pts/0 2026-03-25 09:00 (10.0.0.2)',
  total_processes: '123',
  process_counts: '82 root\n46 trainuser',
  pid_user_map:
    '12345 root python train.py\n' +
    '23456 root python eval.py\n' +
    '34567 systemd-networkd /usr/lib/systemd/systemd-networkd',
  docker_containers:
    '3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10\tzhangz-train',
  pid_container_map:
    '12345\t12:devices:/docker/3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10\n' +
    '23456\t12:devices:/docker/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  top_cpu: 'root 12345 311.2 12.4 18:20:11 python train.py',
  top_memory: 'root 23456 111.2 22.4 08:20:11 python eval.py',
  gpu_summary: '0, NVIDIA RTX 4090, 91, 67, 18200, 24564, ' + UUID_0,
  gpu_processes: UUID_0 + ', 12345, 16000, python train.py',
  net: '1048576 2097152\n',
  docker_status: 'zhangz-train\timg:latest\trunning\tUp 2 hours',
  thermal: 'x86_pkg_temp\t45000',
} as const;

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/;

describe('collect/parsers', () => {
  describe('parseGpuSummary', () => {
    it('parses a single row including the trailing uuid column', () => {
      expect(
        parseGpuSummary('0, NVIDIA RTX 4090, 91, 67, 18200, 24564, ' + UUID_0),
      ).toEqual([
        {
          index: 0,
          name: 'NVIDIA RTX 4090',
          utilizationPercent: 91,
          temperatureC: 67,
          memoryUsedMb: 18200,
          memoryTotalMb: 24564,
        },
      ]);
    });

    it('parses multiple rows preserving input order', () => {
      const rows = parseGpuSummary(
        '0, NVIDIA A100, 50, 40, 1000, 40000, GPU-0\n' +
          '1, NVIDIA A100, 60, 45, 2000, 40000, GPU-1',
      );
      expect(rows.map((row) => row.index)).toEqual([0, 1]);
      expect(rows[0].memoryUsedMb).toBe(1000);
      expect(rows[1].memoryUsedMb).toBe(2000);
    });

    it('keeps a row whose temperature is [N/A] but sets temperatureC to null', () => {
      expect(parseGpuSummary('0, NVIDIA H100, 10, [N/A], 5, 80000')[0]).toEqual({
        index: 0,
        name: 'NVIDIA H100',
        utilizationPercent: 10,
        temperatureC: null,
        memoryUsedMb: 5,
        memoryTotalMb: 80000,
      });
    });

    it('handles a quoted GPU name containing a comma', () => {
      const rows = parseGpuSummary('0, "NVIDIA RTX, Special", 5, 30, 100, 200');
      expect(rows[0].name).toBe('NVIDIA RTX, Special');
    });

    it('returns [] for empty / whitespace-only output', () => {
      expect(parseGpuSummary('')).toEqual([]);
      expect(parseGpuSummary('   \n \n')).toEqual([]);
    });

    it('returns [] when nvidia-smi reports no devices / not found / driver failure', () => {
      expect(parseGpuSummary('No devices were found')).toEqual([]);
      expect(
        parseGpuSummary(
          "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.",
        ),
      ).toEqual([]);
      expect(parseGpuSummary('bash: nvidia-smi: command not found')).toEqual([]);
    });

    it('skips short rows and rows with non-numeric core columns', () => {
      expect(
        parseGpuSummary(
          '0, NVIDIA RTX 4090, 91\n' +
            'not, a, gpu\n' +
            '1, NVIDIA A100, xx, 50, 100, 200',
        ),
      ).toEqual([]);
    });
  });

  describe('parseNvidiaSmiSummaryWithUuid', () => {
    it('returns the rows plus a uuid->index map', () => {
      const { rows, uuidToIndex } = parseNvidiaSmiSummaryWithUuid(
        '0, NVIDIA RTX 4090, 91, 67, 18200, 24564, ' + UUID_0,
      );
      expect(rows).toHaveLength(1);
      expect(uuidToIndex.get(UUID_0)).toBe(0);
    });

    it('omits the uuid when the 7th column is blank', () => {
      const { uuidToIndex } = parseNvidiaSmiSummaryWithUuid(
        '0, NVIDIA RTX 4090, 91, 67, 18200, 24564,',
      );
      expect(uuidToIndex.size).toBe(0);
    });
  });

  describe('parseGpuProcesses', () => {
    it('sorts by GPU index, then memory desc, then pid (v0.1.130 sample)', () => {
      const rows = parseGpuProcesses(
        '0, 100, 800, /usr/bin/a\n0, 101, 4000, /usr/bin/b\n1, 102, 900, /usr/bin/c\n',
      );
      expect(rows.map((row) => row.pid)).toEqual([101, 100, 102]);
      expect(rows[0].memoryUsedMb).toBe(4000);
      expect(rows[0].username).toBeNull();
      expect(rows[0].command).toBe('/usr/bin/b');
    });

    it('maps uuid refs to indices and joins pid->user / pid->command lookups', () => {
      const rows = parseGpuProcesses(UUID_0 + ', 12345, 16000, python train.py', {
        uuidToIndex: new Map([[UUID_0, 0]]),
        pidToUser: new Map([[12345, 'root']]),
        pidToCommand: new Map([[12345, 'fallback-cmd']]),
      });
      expect(rows[0]).toEqual({
        index: 0,
        pid: 12345,
        username: 'root',
        memoryUsedMb: 16000,
        command: 'python train.py',
      });
    });

    it('falls back to pid->command when the process_name column is absent', () => {
      const rows = parseGpuProcesses('0, 100, 800', {
        pidToCommand: new Map([[100, '/usr/bin/a']]),
      });
      expect(rows[0].command).toBe('/usr/bin/a');
      expect(rows[0].username).toBeNull();
    });

    it('uses index -1 for an unrecognised uuid ref', () => {
      const rows = parseGpuProcesses('GPU-UNKNOWN, 100, 800, cmd');
      expect(rows[0].index).toBe(-1);
    });

    it('skips malformed rows and returns [] for empty output', () => {
      expect(parseGpuProcesses('')).toEqual([]);
      expect(parseGpuProcesses('0, 100\nnope')).toEqual([]);
    });
  });

  describe('parsePidUserCommandMap', () => {
    it('splits pid, user, and the remaining command (maxsplit 2)', () => {
      const [users, commands] = parsePidUserCommandMap(
        '12345 root python train.py\n23456  trainuser  python   eval.py',
      );
      expect(users.get(12345)).toBe('root');
      expect(commands.get(12345)).toBe('python train.py');
      expect(users.get(23456)).toBe('trainuser');
      expect(commands.get(23456)).toBe('python   eval.py');
    });

    it('skips blank lines and lines without a user', () => {
      const [users] = parsePidUserCommandMap('12345\n\nnotapid root x');
      expect(users.size).toBe(0);
    });
  });

  describe('parseHostMetrics', () => {
    it('assembles every HostMetrics field from a full payload', () => {
      const metrics = parseHostMetrics(FULL_RAW);

      expect(metrics.hostname).toBe('gpu-01');
      expect(metrics.osPrettyName).toBe('Ubuntu 22.04');
      expect(metrics.kernelVersion).toBe('5.15.0');
      expect(metrics.uptime).toBe('12 days');
      expect(metrics.loadAverage).toEqual({ load1: 2.15, load5: 1.98, load15: 1.76 });
      expect(metrics.cpuCoreCount).toBe(16);
      expect(metrics.cpuUsagePercent).toBe(9.0);
      expect(metrics.memory?.totalMb).toBe(64000);
      expect(metrics.memory?.swapUsedMb).toBe(512);
      expect(metrics.diskUsage).toHaveLength(1);
      expect(metrics.diskUsage[0].mountpoint).toBe('/');
      expect(metrics.loggedInUsers).toEqual([
        {
          username: 'root',
          terminal: 'pts/0',
          loginAt: '2026-03-25 09:00',
          remoteHost: '10.0.0.2',
        },
      ]);
      expect(metrics.totalProcesses).toBe(123);
      expect(metrics.netRxBytes).toBe(1048576);
      expect(metrics.netTxBytes).toBe(2097152);
      expect(metrics.containers).toEqual([
        { name: 'zhangz-train', image: 'img:latest', state: 'running', status: 'Up 2 hours' },
      ]);
      expect(metrics.thermalZones).toEqual([{ label: 'x86_pkg_temp', celsius: 45 }]);
      expect(typeof metrics.collectedAt).toBe('string');
      expect(metrics.collectedAt).toMatch(ISO_UTC_RE);
    });

    it('builds process counts by user from pid_user_map and attaches containers', () => {
      const metrics = parseHostMetrics(FULL_RAW);

      expect(metrics.processCountsByUser).toContainEqual({
        username: 'root',
        count: 1,
        containerId: '3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10',
        containerName: 'zhangz-train',
      });

      expect(metrics.topCpuProcesses[0]).toMatchObject({
        username: 'root',
        pid: 12345,
        command: 'python train.py',
        containerId: '3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10',
        containerName: 'zhangz-train',
      });
      expect(metrics.topMemoryProcesses[0].containerId).toBe(
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      );
      expect(metrics.topMemoryProcesses[0].containerName).toBeNull();
    });

    it('parses GPU summary and GPU processes, joining pid->user', () => {
      const metrics = parseHostMetrics(FULL_RAW);

      expect(metrics.gpuSummary).toHaveLength(1);
      expect(metrics.gpuSummary[0]).toMatchObject({
        index: 0,
        name: 'NVIDIA RTX 4090',
        utilizationPercent: 91,
        temperatureC: 67,
        memoryUsedMb: 18200,
        memoryTotalMb: 24564,
      });
      expect(metrics.gpuProcesses).toEqual([
        {
          index: 0,
          pid: 12345,
          username: 'root',
          memoryUsedMb: 16000,
          command: 'python train.py',
        },
      ]);
    });

    it('fills absent stages with emptyHostMetrics defaults but still stamps collectedAt', () => {
      const metrics = parseHostMetrics({});

      expect(metrics.hostname).toBeNull();
      expect(metrics.osPrettyName).toBeNull();
      expect(metrics.kernelVersion).toBeNull();
      expect(metrics.uptime).toBeNull();
      expect(metrics.loadAverage).toBeNull();
      expect(metrics.cpuCoreCount).toBeNull();
      expect(metrics.cpuUsagePercent).toBeNull();
      expect(metrics.memory).toBeNull();
      expect(metrics.diskUsage).toEqual([]);
      expect(metrics.loggedInUsers).toEqual([]);
      expect(metrics.totalProcesses).toBeNull();
      expect(metrics.processCountsByUser).toEqual([]);
      expect(metrics.topCpuProcesses).toEqual([]);
      expect(metrics.topMemoryProcesses).toEqual([]);
      expect(metrics.gpuSummary).toEqual([]);
      expect(metrics.gpuProcesses).toEqual([]);
      expect(metrics.netRxBytes).toBeNull();
      expect(metrics.netTxBytes).toBeNull();
      expect(metrics.containers).toEqual([]);
      expect(metrics.thermalZones).toEqual([]);
      expect(metrics.collectedAt).toMatch(ISO_UTC_RE);
    });

    it('falls back to process_counts when pid_user_map is absent', () => {
      const metrics = parseHostMetrics({ process_counts: '82 root\n46 trainuser' });
      expect(metrics.processCountsByUser).toEqual([
        { username: 'root', count: 82, containerId: null, containerName: null },
        { username: 'trainuser', count: 46, containerId: null, containerName: null },
      ]);
    });

    it('does not throw on garbage input and degrades to defaults', () => {
      const metrics = parseHostMetrics({
        hostname: '@@@',
        uptime: 'garbage',
        memory: 'garbage',
        disk: 'garbage',
        cpu_cores: 'abc',
        cpu_usage: 'abc',
        total_processes: 'abc',
        who: 'x',
        gpu_summary: 'garbage',
        gpu_processes: 'garbage',
        net: 'nonsense',
        thermal: 'no-tab-here',
      });

      expect(metrics.hostname).toBe('@@@');
      expect(metrics.loadAverage).toBeNull();
      // Python `parse_uptime_text` falls back to the trimmed whole output.
      expect(metrics.uptime).toBe('garbage');
      expect(metrics.memory).toBeNull();
      expect(metrics.diskUsage).toEqual([]);
      expect(metrics.cpuCoreCount).toBeNull();
      expect(metrics.cpuUsagePercent).toBeNull();
      expect(metrics.totalProcesses).toBeNull();
      expect(metrics.loggedInUsers).toEqual([]);
      expect(metrics.gpuSummary).toEqual([]);
      expect(metrics.gpuProcesses).toEqual([]);
      expect(metrics.netRxBytes).toBeNull();
      expect(metrics.netTxBytes).toBeNull();
      expect(metrics.thermalZones).toEqual([]);
    });
  });
});
