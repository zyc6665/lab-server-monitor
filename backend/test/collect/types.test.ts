import { describe, it, expect } from 'vitest';

import {
  emptyHostMetrics,
  hottestTemperatureC,
  roundHalfEven,
  type CommandResult,
  type GPUSummaryRow,
  type HostMetrics,
  type ThermalZone,
} from '../../src/collect/types';

function thermal(label: string, celsius: number): ThermalZone {
  return { label, celsius };
}

function gpuRow(temperatureC: number | null): GPUSummaryRow {
  return {
    index: 0,
    name: 'NVIDIA A100',
    utilizationPercent: 0,
    temperatureC,
    memoryUsedMb: 0,
    memoryTotalMb: 0,
  };
}

function metrics(overrides: Partial<HostMetrics>): HostMetrics {
  return { ...emptyHostMetrics(), ...overrides };
}

// ---------------------------------------------------------------------------
// emptyHostMetrics — Python HostMetrics() defaults (models.py:380-401)
// ---------------------------------------------------------------------------
describe('emptyHostMetrics', () => {
  it('fills every HostMetrics field with the Python dataclass default', () => {
    expect(emptyHostMetrics()).toEqual({
      hostname: null,
      osPrettyName: null,
      kernelVersion: null,
      uptime: null,
      collectedAt: null,
      loadAverage: null,
      cpuCoreCount: null,
      cpuUsagePercent: null,
      memory: null,
      diskUsage: [],
      loggedInUsers: [],
      totalProcesses: null,
      processCountsByUser: [],
      topCpuProcesses: [],
      topMemoryProcesses: [],
      gpuSummary: [],
      gpuProcesses: [],
      netRxBytes: null,
      netTxBytes: null,
      containers: [],
      thermalZones: [],
    });
    // 21 fields — no extras, none missing.
    expect(Object.keys(emptyHostMetrics())).toHaveLength(21);
  });

  it('returns a fresh set of independent list instances on every call', () => {
    const first = emptyHostMetrics();
    first.diskUsage.push({
      filesystem: '/dev/sda1',
      size: '1G',
      used: '1M',
      available: '1G',
      percent: '1%',
      mountpoint: '/',
    });
    first.gpuSummary.push(gpuRow(50));
    // A second call must not observe the mutations of the first.
    const second = emptyHostMetrics();
    expect(second.diskUsage).toEqual([]);
    expect(second.gpuSummary).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// roundHalfEven — Python round() is round-half-to-even (banker's rounding)
// ---------------------------------------------------------------------------
describe('roundHalfEven', () => {
  it('rounds exactly-half integer ties to the nearest even integer', () => {
    expect(roundHalfEven(2.5, 0)).toBe(2);
    expect(roundHalfEven(3.5, 0)).toBe(4);
    expect(roundHalfEven(0.5, 0)).toBe(0);
    expect(roundHalfEven(1.5, 0)).toBe(2);
  });

  it('rounds negative halves symmetrically (round half to even)', () => {
    expect(roundHalfEven(-2.5, 0)).toBe(-2);
    expect(roundHalfEven(-3.5, 0)).toBe(-4);
  });

  it('matches Python round(x, 1) on the exact half boundaries', () => {
    // 41.25 is exactly representable -> tie -> even digit (2) => 41.2
    expect(roundHalfEven(41.25, 1)).toBe(41.2);
    // 41.35's nearest double is slightly above 41.35 -> rounds up => 41.4
    expect(roundHalfEven(41.35, 1)).toBe(41.4);
  });

  it('matches Python on values that break naive x10 scaling', () => {
    // 0.15 * 10 === 1.5 in JS, but the double is below 0.15 -> Python round -> 0.1
    expect(roundHalfEven(0.15, 1)).toBe(0.1);
    // 41.15 double is below 41.15 -> 41.1 (naive scaling would give 41.2)
    expect(roundHalfEven(41.15, 1)).toBe(41.1);
    // 2.675 double is below 2.675 -> 2.67 (naive scaling would give 2.68)
    expect(roundHalfEven(2.675, 2)).toBe(2.67);
  });

  it('leaves non-tie values unchanged at the target precision', () => {
    expect(roundHalfEven(41.24, 1)).toBe(41.2);
    expect(roundHalfEven(41.26, 1)).toBe(41.3);
    expect(roundHalfEven(35.2, 1)).toBe(35.2);
    expect(roundHalfEven(62, 1)).toBe(62);
  });
});

// ---------------------------------------------------------------------------
// hottestTemperatureC — port of HostMetrics.hottest_temperature_c
// ---------------------------------------------------------------------------
describe('hottestTemperatureC', () => {
  it('returns null when there is neither thermal nor GPU data', () => {
    expect(hottestTemperatureC(emptyHostMetrics())).toBeNull();
  });

  it('uses the maximum across thermal zones and GPU rows', () => {
    const m = metrics({
      thermalZones: [thermal('cpu', 35.2)],
      gpuSummary: [gpuRow(62)],
    });
    expect(hottestTemperatureC(m)).toBe(62);
  });

  it('picks the thermal zone when it exceeds the GPU temperature', () => {
    const m = metrics({
      thermalZones: [thermal('board', 62.4)],
      gpuSummary: [gpuRow(62)],
    });
    expect(hottestTemperatureC(m)).toBe(62.4);
  });

  it('rounds the thermal maximum to 1 decimal with banker rounding', () => {
    expect(
      hottestTemperatureC(metrics({ thermalZones: [thermal('cpu', 41.24)] })),
    ).toBe(41.2);
    expect(
      hottestTemperatureC(metrics({ thermalZones: [thermal('cpu', 41.25)] })),
    ).toBe(41.2);
    expect(
      hottestTemperatureC(metrics({ thermalZones: [thermal('cpu', 41.35)] })),
    ).toBe(41.4);
  });

  it('takes the max over several zones before rounding', () => {
    const m = metrics({
      thermalZones: [thermal('cpu', 30), thermal('board', 41.25), thermal('ssd', 40)],
    });
    expect(hottestTemperatureC(m)).toBe(41.2);
  });

  it('ignores 0.0 thermal readings (Python truthiness filter)', () => {
    // [zone.celsius for zone in thermal_zones if zone.celsius] drops 0.0
    expect(hottestTemperatureC(metrics({ thermalZones: [thermal('z', 0)] }))).toBeNull();
  });

  it('keeps a 0 GPU temperature (Python checks `is not None`)', () => {
    expect(hottestTemperatureC(metrics({ gpuSummary: [gpuRow(0)] }))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CommandResult — camelCase exitStatus
// ---------------------------------------------------------------------------
describe('CommandResult', () => {
  it('uses the camelCase { stdout, stderr, exitStatus } shape', () => {
    const result: CommandResult = { stdout: 'out', stderr: 'err', exitStatus: 2 };
    expect(result.exitStatus).toBe(2);
    expect(Object.keys(result)).toEqual(['stdout', 'stderr', 'exitStatus']);
  });
});
