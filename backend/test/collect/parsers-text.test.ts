/**
 * Unit tests for `backend/src/collect/parsers-text.ts` — the 1:1 TypeScript port
 * of the non-GPU parsers in `servermanage/parsers.py` (lines 55-565).
 *
 * Sample strings are transcribed from the Python oracle tests:
 * - `tests/test_parsers.py` (uptime, free -m, df -hP, who, ps rows, docker names,
 *   pid->container map)
 * - `tests/test_v0178_thermal.py` (thermal zones)
 * - `tests/test_v0176_containers.py` (docker ps)
 * - `tests/test_v0175_network.py` (net totals)
 * plus small malformed / empty inputs.
 *
 * Every expected value below was cross-checked against the real Python
 * functions via a throw-away oracle harness, so these assertions pin Python
 * semantics (including banker's rounding and Python's field names).
 */
import { describe, expect, it } from 'vitest';

import {
  parseCpuUsagePercent,
  parseDiskUsage,
  parseDockerContainerNames,
  parseDockerContainers,
  parseMemory,
  parseMemorySummary,
  parseNetTotals,
  parseOsPrettyName,
  parsePidContainerMap,
  parseProcessCounts,
  parseProcessRows,
  parseThermalZones,
  parseTotalProcesses,
  parseUptime,
  parseUptimeText,
  parseWho,
} from '../../src/collect/parsers-text';

const UPTIME_STANDARD =
  ' 09:00:00 up 12 days,  2 users,  load average: 2.15, 1.98, 1.76';

describe('collect/parsers-text', () => {
  describe('parseUptime', () => {
    it('extracts the three load averages', () => {
      expect(parseUptime(UPTIME_STANDARD)).toEqual({
        load1: 2.15,
        load5: 1.98,
        load15: 1.76,
      });
    });

    it('parses minute-scale uptime', () => {
      expect(
        parseUptime(' 14:02:11 up 3 min,  1 user,  load average: 0.52, 0.58, 0.59'),
      ).toEqual({ load1: 0.52, load5: 0.58, load15: 0.59 });
    });

    it('returns null when no load average is present', () => {
      expect(parseUptime('no load info here')).toBeNull();
      expect(parseUptime('')).toBeNull();
    });
  });

  describe('parseUptimeText', () => {
    it('strips the "up ... , N users" wrapper', () => {
      expect(parseUptimeText(UPTIME_STANDARD)).toBe('12 days');
    });

    it('handles hour-scale uptime', () => {
      expect(
        parseUptimeText(' 14:02:11 up 3 hours, 1 user,  load average: 0.52, 0.58, 0.59'),
      ).toBe('3 hours');
    });

    it('falls back to the trimmed whole output when no wrapper matches', () => {
      expect(parseUptimeText('12 days')).toBe('12 days');
    });

    it('uses only the first matching line of multi-line output', () => {
      expect(
        parseUptimeText(
          ' 09:00:00 up 5 days,  1 user,  load average: 0.0, 0.0, 0.0\nsecond line',
        ),
      ).toBe('5 days');
    });

    it('returns null for blank output', () => {
      expect(parseUptimeText('   ')).toBeNull();
    });
  });

  describe('parseOsPrettyName', () => {
    it('unquotes a PRETTY_NAME= first line', () => {
      expect(parseOsPrettyName('PRETTY_NAME="Ubuntu 22.04.4 LTS"')).toBe(
        'Ubuntu 22.04.4 LTS',
      );
    });

    it('returns a plain first line unchanged', () => {
      expect(parseOsPrettyName('Ubuntu 22.04')).toBe('Ubuntu 22.04');
    });

    it('reads only the first line', () => {
      expect(
        parseOsPrettyName('PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian"'),
      ).toBe('Debian GNU/Linux 12 (bookworm)');
    });

    it('returns the raw first line when it is not PRETTY_NAME=', () => {
      expect(parseOsPrettyName('NAME="Debian"\nPRETTY_NAME="Debian 12"')).toBe(
        'NAME="Debian"',
      );
    });

    it('returns null for empty output', () => {
      expect(parseOsPrettyName('')).toBeNull();
    });
  });

  describe('parseMemorySummary / parseMemory', () => {
    const FREE_MODERN =
      '              total        used        free      shared  buff/cache   available\n' +
      'Mem:          64000       41000        3000         120       20000       22000\n' +
      'Swap:          8192         512        7680';

    const FREE_LEGACY =
      '             total       used       free     shared    buffers     cached\n' +
      'Mem:          64000       41000        3000         120       20000       21000\n' +
      'Swap:          8192         512        7680';

    it('parses the modern free -m header (with buff/cache column)', () => {
      expect(parseMemorySummary(FREE_MODERN)).toEqual({
        totalMb: 64000,
        usedMb: 41000,
        freeMb: 3000,
        sharedMb: 120,
        buffCacheMb: 20000,
        availableMb: 22000,
        swapTotalMb: 8192,
        swapUsedMb: 512,
        swapFreeMb: 7680,
      });
    });

    it('parses the legacy free header (buffers + cached instead of buff/cache)', () => {
      // Python reads six numeric columns positionally, so the 6th value
      // (`cached`) lands in availableMb — reproduced 1:1 here.
      expect(parseMemorySummary(FREE_LEGACY)).toEqual({
        totalMb: 64000,
        usedMb: 41000,
        freeMb: 3000,
        sharedMb: 120,
        buffCacheMb: 20000,
        availableMb: 21000,
        swapTotalMb: 8192,
        swapUsedMb: 512,
        swapFreeMb: 7680,
      });
    });

    it('defaults swap to zeros when no Swap: line is present', () => {
      const output =
        '              total        used        free      shared  buff/cache   available\n' +
        'Mem:          16000        2000        9000          50        5000       13500';
      expect(parseMemorySummary(output)).toMatchObject({
        totalMb: 16000,
        swapTotalMb: 0,
        swapUsedMb: 0,
        swapFreeMb: 0,
      });
    });

    it('returns null on garbage / empty output', () => {
      expect(parseMemorySummary('totally not free output')).toBeNull();
      expect(parseMemorySummary('')).toBeNull();
    });

    it('parseMemory is an alias for parseMemorySummary', () => {
      expect(parseMemory(FREE_MODERN)).toEqual(parseMemorySummary(FREE_MODERN));
    });
  });

  describe('parseDiskUsage', () => {
    const DF_HP =
      'Filesystem      Size  Used Avail Use% Mounted on\n' +
      '/dev/sda1       300G  120G  180G  40% /\n' +
      '/dev/sdb1       4.0T  2.1T  1.9T  52% /data';

    it('parses df -hP rows', () => {
      const rows = parseDiskUsage(DF_HP);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toEqual({
        filesystem: '/dev/sdb1',
        size: '4.0T',
        used: '2.1T',
        available: '1.9T',
        percent: '52%',
        mountpoint: '/data',
      });
    });

    it('skips a localized header row without treating it as data', () => {
      const rows = parseDiskUsage(
        '文件系统        容量  已用  可用 已用% 挂载点\n' +
          '/dev/sda1       300G  120G  180G  40% /\n' +
          '/dev/sdb1       4.0T  2.1T  1.9T  52% /data',
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].mountpoint).toBe('/');
    });

    it('keeps tmpfs/overlay rows (Python does NOT filter them here)', () => {
      // tmpfs/overlay filtering lives in report.py / disk_capacity.py, not in
      // parsers.parse_disk_usage. The port mirrors that: they are kept.
      const rows = parseDiskUsage(
        'Filesystem      Size  Used Avail Use% Mounted on\n' +
          'tmpfs           3.2G  1.2M  3.2G   1% /run\n' +
          'overlay          50G   20G   30G  40% /var/lib/docker/overlay2/abc\n' +
          '/dev/sda1       300G  120G  180G  40% /',
      );
      expect(rows.map((r) => r.filesystem)).toEqual(['tmpfs', 'overlay', '/dev/sda1']);
    });

    it('drops rows with fewer than six fields', () => {
      expect(
        parseDiskUsage('Filesystem Size Used Avail Use% Mounted on\n/dev/sda1 300G 120G 180G /'),
      ).toEqual([]);
    });

    it('returns an empty array for empty output', () => {
      expect(parseDiskUsage('')).toEqual([]);
    });
  });

  describe('parseWho', () => {
    it('parses month-day-time logins with a remote host', () => {
      expect(parseWho('root pts/0 Mar 25 09:00 (10.0.0.2)')).toEqual([
        {
          username: 'root',
          terminal: 'pts/0',
          loginAt: 'Mar 25 09:00',
          remoteHost: '10.0.0.2',
        },
      ]);
    });

    it('parses ISO-date logins with a remote host', () => {
      expect(parseWho('root pts/0 2026-03-25 09:00 (10.0.0.2)')[0]).toEqual({
        username: 'root',
        terminal: 'pts/0',
        loginAt: '2026-03-25 09:00',
        remoteHost: '10.0.0.2',
      });
    });

    it('leaves remoteHost null when no "(host)" suffix is present', () => {
      expect(parseWho('trainuser pts/1 2026-03-25 10:15')[0]).toEqual({
        username: 'trainuser',
        terminal: 'pts/1',
        loginAt: '2026-03-25 10:15',
        remoteHost: null,
      });
    });

    it('parses multiple users', () => {
      const rows = parseWho(
        'root pts/0 Mar 25 09:00 (10.0.0.2)\ntrainuser pts/1 Mar 25 10:15 (10.0.0.3)',
      );
      expect(rows.map((r) => r.username)).toEqual(['root', 'trainuser']);
      expect(rows[1].remoteHost).toBe('10.0.0.3');
    });

    it('ignores malformed lines', () => {
      expect(parseWho('root pts/0\n\n  ')).toEqual([]);
    });
  });

  describe('parseProcessCounts', () => {
    it('parses "count username" pairs with defaulted container fields', () => {
      expect(parseProcessCounts('82 root\n46 trainuser')).toEqual([
        { username: 'root', count: 82, containerId: null, containerName: null },
        { username: 'trainuser', count: 46, containerId: null, containerName: null },
      ]);
    });

    it('tolerates extra leading whitespace and long usernames', () => {
      expect(parseProcessCounts('  82    root\n46 trainuser\n3 systemd-networkd')).toEqual([
        { username: 'root', count: 82, containerId: null, containerName: null },
        { username: 'trainuser', count: 46, containerId: null, containerName: null },
        { username: 'systemd-networkd', count: 3, containerId: null, containerName: null },
      ]);
    });

    it('ignores malformed lines', () => {
      expect(parseProcessCounts('root nope\n\n42')).toEqual([]);
    });
  });

  describe('parseProcessRows', () => {
    it('parses a top-cpu row down to the command', () => {
      expect(parseProcessRows('root 12345 311.2 12.4 18:20:11 python train.py')).toEqual([
        {
          username: 'root',
          pid: 12345,
          cpuPercent: 311.2,
          memPercent: 12.4,
          elapsed: '18:20:11',
          command: 'python train.py',
          containerId: null,
          containerName: null,
        },
      ]);
    });

    it('keeps the whole command tail (args with spaces)', () => {
      expect(
        parseProcessRows('trainuser 23456 111.2 22.4 08:20:11 python eval.py --long flag')[0]
          .command,
      ).toBe('python eval.py --long flag');
    });

    it('parses multiple rows in order', () => {
      const rows = parseProcessRows(
        'root 12345 311.2 12.4 18:20:11 python train.py\n' +
          'trainuser 23456 111.2 22.4 08:20:11 python eval.py',
      );
      expect(rows.map((r) => r.pid)).toEqual([12345, 23456]);
    });

    it('raw rows carry null container columns (context is attached separately)', () => {
      const row = parseProcessRows('root 12345 311.2 12.4 18:20:11 python train.py')[0];
      expect(row.containerId).toBeNull();
      expect(row.containerName).toBeNull();
    });

    it('drops rows with non-numeric pid/cpu/mem', () => {
      expect(
        parseProcessRows('root notapid 1.0 2.0 00:01 cmd\nroot 12345 x 2.0 00:01 cmd'),
      ).toEqual([]);
    });
  });

  describe('parseThermalZones', () => {
    it('reads millidegrees, rounds to 0.1C, and sorts by temperature desc', () => {
      const zones = parseThermalZones('x86_pkg_temp\t58000\nacpitz\t27800\nnvme\t41850');
      expect(zones).toEqual([
        { label: 'x86_pkg_temp', celsius: 58.0 },
        { label: 'nvme', celsius: 41.9 }, // round(41.85, 1) == 41.9 in CPython
        { label: 'acpitz', celsius: 27.8 },
      ]);
    });

    it('skips noise, zero, out-of-range, and duplicate labels', () => {
      const zones = parseThermalZones(
        'bad line without tab\n' +
          'coretemp\tnot-a-number\n' +
          'zero\t0\n' +
          'huge\t250000\n' +
          'acpitz\t30000\n' +
          'acpitz\t99000',
      );
      expect(zones).toEqual([{ label: 'acpitz', celsius: 30.0 }]);
    });

    it('skips lines whose label is blank after trimming', () => {
      expect(parseThermalZones('\t45000\nreal\t61000')).toEqual([
        { label: 'real', celsius: 61.0 },
      ]);
    });

    it('caps the result at 20 zones', () => {
      const output = Array.from({ length: 30 }, (_, i) => `zone${i}\t${40000 + i}`).join('\n');
      expect(parseThermalZones(output)).toHaveLength(20);
    });

    it('returns [] for null / empty input', () => {
      expect(parseThermalZones(null)).toEqual([]);
      expect(parseThermalZones('')).toEqual([]);
    });
  });

  describe('parseDockerContainerNames', () => {
    it('maps a full container id to its name', () => {
      const mapping = parseDockerContainerNames(
        '3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10\tzhangz-train',
      );
      expect(
        mapping.get('3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10'),
      ).toBe('zhangz-train');
      expect(mapping.size).toBe(1);
    });

    it('skips lines without a tab or with an empty name', () => {
      const mapping = parseDockerContainerNames(
        'abc123def456\ttrain-py\nfff000aaa111\tjupyter\nnoTabHere\n\tblankName',
      );
      expect(Object.fromEntries(mapping)).toEqual({
        abc123def456: 'train-py',
        fff000aaa111: 'jupyter',
      });
    });

    it('returns an empty map for empty output', () => {
      expect(parseDockerContainerNames('').size).toBe(0);
    });
  });

  describe('parseDockerContainers', () => {
    it('parses tab-separated docker ps rows', () => {
      const containers = parseDockerContainers(
        'train-py\tpytorch/pytorch:2.4-cuda\trunning\tUp 3 days\n' +
          'jupyter\tjupyter/scipy-notebook:latest\trunning\tUp 2 hours (healthy)',
      );
      expect(containers.map((c) => c.name)).toEqual(['train-py', 'jupyter']);
      expect(containers[0]).toEqual({
        name: 'train-py',
        image: 'pytorch/pytorch:2.4-cuda',
        state: 'running',
        status: 'Up 3 days',
      });
      expect(containers[1].status).toBe('Up 2 hours (healthy)');
    });

    it('fills missing columns with empty strings', () => {
      expect(parseDockerContainers('solo\n')).toEqual([
        { name: 'solo', image: '', state: '', status: '' },
      ]);
      expect(parseDockerContainers('name\timage\n')).toEqual([
        { name: 'name', image: 'image', state: '', status: '' },
      ]);
    });

    it('caps the payload at 200 containers', () => {
      const output = Array.from({ length: 260 }, (_, i) => `c${i}\timage\tstate\tstatus`).join(
        '\n',
      );
      expect(parseDockerContainers(output)).toHaveLength(200);
    });

    it('returns [] for null / empty output', () => {
      expect(parseDockerContainers(null)).toEqual([]);
      expect(parseDockerContainers('')).toEqual([]);
    });
  });

  describe('parsePidContainerMap', () => {
    it('extracts container ids from both docker cgroup line forms', () => {
      const mapping = parsePidContainerMap(
        '123\t12:devices:/docker/3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10\n' +
          '456\t0::/system.slice/docker-a7b9c2d4e6f8a7b9c2d4e6f8a7b9c2d4e6f8a7b9c2d4e6f8a7b9c2d4e6f8.scope',
      );
      expect(
        mapping.get(123),
      ).toBe('3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10');
      expect(mapping.get(456)).toBe(
        'a7b9c2d4e6f8a7b9c2d4e6f8a7b9c2d4e6f8a7b9c2d4e6f8a7b9c2d4e6f8',
      );
    });

    it('accepts a raw 64-char container id', () => {
      const id = 'f'.repeat(64);
      expect(parsePidContainerMap(`789\t${id}`).get(789)).toBe(id);
    });

    it('skips lines with no pid / no recognisable ref', () => {
      expect(parsePidContainerMap('123\tdevices\nnotapid\tstuff\n').size).toBe(0);
    });

    it('returns an empty map for empty output', () => {
      expect(parsePidContainerMap('').size).toBe(0);
    });
  });

  describe('parseTotalProcesses', () => {
    it('parses an integer count', () => {
      expect(parseTotalProcesses('123')).toBe(123);
      expect(parseTotalProcesses('  456\n')).toBe(456);
      expect(parseTotalProcesses('0')).toBe(0);
    });

    it('returns null for garbage / empty output', () => {
      expect(parseTotalProcesses('abc')).toBeNull();
      expect(parseTotalProcesses('')).toBeNull();
    });
  });

  describe('parseCpuUsagePercent', () => {
    it('parses a plain percentage', () => {
      expect(parseCpuUsagePercent('9.0')).toBe(9.0);
    });

    it('derives usage from a top-style idle percentage', () => {
      // Matches Python's idle regex ("92.0 id") -> round(100 - 92.0, 1) = 8.0
      expect(parseCpuUsagePercent('%Cpu(s):  5.0 us,  2.0 sy,  0.0 ni, 92.0 id,  0.5 wa')).toBe(
        8.0,
      );
    });

    it('returns null for blank / non-numeric output', () => {
      expect(parseCpuUsagePercent('   ')).toBeNull();
      expect(parseCpuUsagePercent('no numbers')).toBeNull();
    });
  });

  describe('parseNetTotals', () => {
    it('parses aggregates produced by the probe', () => {
      expect(parseNetTotals('123456 654321\n')).toEqual([123456, 654321]);
      expect(parseNetTotals('1048576.0 2097152.0')).toEqual([1048576, 2097152]);
    });

    it('rejects negative, single-token, nonsense, null, and empty input', () => {
      expect(parseNetTotals('-1 -2')).toEqual([null, null]);
      expect(parseNetTotals('123')).toEqual([null, null]);
      expect(parseNetTotals('nonsense')).toEqual([null, null]);
      expect(parseNetTotals(null)).toEqual([null, null]);
      expect(parseNetTotals('  ')).toEqual([null, null]);
    });
  });
});
