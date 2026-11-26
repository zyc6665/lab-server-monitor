/**
 * Unit tests for `backend/src/collect/container-stats.ts` — the 1:1 TypeScript
 * port of `servermanage/container_stats.py`.
 *
 * Sample strings and expectations are transcribed from the Python oracle test
 * `tests/test_v0190_container_stats.py`, plus the edge cases demanded by the
 * task (empty output, missing columns, illegal percentages, >300-row cap,
 * null-last / descending ordering) and a few extra rounding pins.
 *
 * Every expected value was cross-checked against the Python functions, so these
 * assertions pin Python semantics (banker's rounding, stable sort, Python field
 * names).
 */
import { describe, expect, it } from 'vitest';

import {
  collectContainerStats,
  STATS_COMMAND,
  parseContainerStats,
} from '../../src/collect/container-stats';
import type { ContainerStatRow } from '../../src/collect/container-stats';

/** `servermanage/container_stats.py` STATS_COMMAND, written with real tabs. */
const EXPECTED_STATS_COMMAND =
  "docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemPerc}}\t{{.MemUsage}}' 2>/dev/null";

/** Fake `CommandResult`-shaped object for the collect() tests. */
interface FakeResult {
  stdout?: string | null;
  exitStatus?: number | null;
}

function fakeSsh(result: FakeResult | null | undefined): {
  run: (command: string, timeoutMs: number) => FakeResult | null | undefined;
  calls: Array<{ command: string; timeoutMs: number }>;
} {
  const calls: Array<{ command: string; timeoutMs: number }> = [];
  return {
    calls,
    run(command: string, timeoutMs: number): FakeResult | null | undefined {
      calls.push({ command, timeoutMs });
      return result;
    },
  };
}

describe('collect/container-stats', () => {
  describe('STATS_COMMAND', () => {
    it('is byte-for-byte the read-only Python command (real tabs, single quotes)', () => {
      expect(STATS_COMMAND).toBe(EXPECTED_STATS_COMMAND);
      // Explicit structural checks so a tab/quote regression names the culprit.
      expect(STATS_COMMAND.split('\t')).toHaveLength(4);
      expect(STATS_COMMAND).toContain('--no-stream');
      expect(STATS_COMMAND).toContain("'{{.Name}}");
      expect(STATS_COMMAND).toContain('2>/dev/null');
    });

    it('contains no mutating docker verbs', () => {
      for (const verb of ['start', 'stop', 'restart', 'rm ', 'kill', 'prune', 'exec', 'run ']) {
        expect(STATS_COMMAND).not.toContain(`docker ${verb}`);
      }
    });
  });

  describe('parseContainerStats', () => {
    it('returns [] for empty, null and undefined output', () => {
      expect(parseContainerStats('')).toEqual([]);
      expect(parseContainerStats(null)).toEqual([]);
      expect(parseContainerStats(undefined)).toEqual([]);
    });

    it('converts percentages, keeps memory usage and sorts by cpu descending', () => {
      const output =
        'web\t0.50%\t1.20%\t120MiB / 8GiB\n' +
        'train-py\t312.40%\t48.75%\t3.9GiB / 8GiB\n' +
        'idle\t0.00%\t0.00%\t1MiB / 8GiB\n';

      const rows = parseContainerStats(output);

      expect(rows.map((row) => row.name)).toEqual(['train-py', 'web', 'idle']);
      expect(rows[0]).toEqual({
        name: 'train-py',
        cpuPercent: 312.4,
        memoryPercent: 48.8,
        memoryUsage: '3.9GiB / 8GiB',
      });
    });

    it('tolerates missing columns and blank first columns', () => {
      expect(parseContainerStats('only-name\n\n  \n')).toEqual([
        { name: 'only-name', cpuPercent: null, memoryPercent: null, memoryUsage: '' },
      ]);
    });

    it('parses a partial row where only cpu is present', () => {
      expect(parseContainerStats('c1\t12.5%\n')).toEqual([
        { name: 'c1', cpuPercent: 12.5, memoryPercent: null, memoryUsage: '' },
      ]);
    });

    it('maps illegal percentages to null', () => {
      const rows = parseContainerStats('alpha\tabc%\t0.5%\t1GiB / 2GiB\n');
      expect(rows).toEqual([
        { name: 'alpha', cpuPercent: null, memoryPercent: 0.5, memoryUsage: '1GiB / 2GiB' },
      ]);
    });

    it('treats a bare percent sign (and blank memo field) as null', () => {
      const rows = parseContainerStats('b\t%\t%\t\n');
      expect(rows).toEqual([
        { name: 'b', cpuPercent: null, memoryPercent: null, memoryUsage: '' },
      ]);
    });

    it('strips surrounding whitespace and trailing percent signs', () => {
      const rows = parseContainerStats('  web  \t 3.42 % \t 1.5%\t 10MiB / 1GiB \n');
      expect(rows).toEqual([
        { name: 'web', cpuPercent: 3.4, memoryPercent: 1.5, memoryUsage: '10MiB / 1GiB' },
      ]);
    });

    it('caps parsed rows at 300 before sorting', () => {
      let output = '';
      for (let i = 0; i < 400; i += 1) {
        output += `c${i}\t1.0%\t1.0%\t1MiB / 8GiB\n`;
      }
      expect(parseContainerStats(output)).toHaveLength(300);
    });

    it('sorts exactly like Python: null cpu last, descending, stable ties', () => {
      const output =
        'a\t5.0%\t1.0%\tA\n' +
        'b\tbad\t1.0%\tB\n' +
        'c\t5.0%\t1.0%\tC\n' +
        'd\t10.0%\t1.0%\tD\n';

      const rows = parseContainerStats(output);

      expect(rows.map((row) => row.name)).toEqual(['d', 'a', 'c', 'b']);
      expect(rows[3].cpuPercent).toBeNull();
      // Stable tie: 'a' precedes 'c' because it appeared first.
      expect(rows[1].name).toBe('a');
      expect(rows[2].name).toBe('c');
    });

    it("rounds with banker's rounding at one decimal place", () => {
      const cases: Array<[string, number | null]> = [
        ['48.75%', 48.8], // tie -> even (48.8)
        ['0.25%', 0.2], // tie -> even (0.2)
        ['0.15%', 0.1], // exact binary value is just below the tie
        ['312.44%', 312.4],
        ['312.45%', 312.4], // binary value sits just below the decimal tie
      ];
      for (const [input, expected] of cases) {
        const rows = parseContainerStats(`x\t${input}\t1%\tA\n`);
        expect(rows[0].cpuPercent).toBe(expected);
      }
    });
  });

  describe('collectContainerStats', () => {
    const host = { name: 'a100' };

    it('runs STATS_COMMAND with the default 30000ms timeout and parses stdout', async () => {
      const ssh = fakeSsh({ stdout: 'web\t1.00%\t2.00%\t10MiB / 1GiB\n', exitStatus: 0 });

      const rows = await collectContainerStats(host, ssh);

      expect(rows).toEqual([
        { name: 'web', cpuPercent: 1, memoryPercent: 2, memoryUsage: '10MiB / 1GiB' },
      ]);
      expect(ssh.calls).toEqual([{ command: EXPECTED_STATS_COMMAND, timeoutMs: 30000 }]);
    });

    it('forwards a custom timeout', async () => {
      const ssh = fakeSsh({ stdout: '', exitStatus: 0 });
      await collectContainerStats(host, ssh, 5000);
      expect(ssh.calls[0].timeoutMs).toBe(5000);
    });

    it('returns [] when the ssh run result is null/undefined', async () => {
      expect(await collectContainerStats(host, fakeSsh(null))).toEqual([]);
      expect(await collectContainerStats(host, fakeSsh(undefined))).toEqual([]);
    });

    it('returns [] on a non-zero exit status', async () => {
      const ssh = fakeSsh({ stdout: 'web\t1.0%\t2.0%\t1MiB\n', exitStatus: 127 });
      expect(await collectContainerStats(host, ssh)).toEqual([]);
    });

    it('treats a missing/undefined exit status like Python None (proceeds)', async () => {
      const ssh = fakeSsh({ stdout: 'web\t1.0%\t2.0%\t1MiB\n' });
      const rows: ContainerStatRow[] = await collectContainerStats(host, ssh);
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('web');
    });

    it('treats a null exit status like Python None (proceeds)', async () => {
      const ssh = fakeSsh({ stdout: 'web\t1.0%\t2.0%\t1MiB\n', exitStatus: null });
      expect(await collectContainerStats(host, ssh)).toHaveLength(1);
    });

    it('returns [] when stdout is missing', async () => {
      const ssh = fakeSsh({ exitStatus: 0 });
      expect(await collectContainerStats(host, ssh)).toEqual([]);
    });
  });
});
