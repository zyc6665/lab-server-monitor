import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Resolve the installation directory for the desktop application.
 * Prefers D:\\Tools\\ServerMonitor when a D: drive exists; otherwise falls
 * back to %LOCALAPPDATA%\\Programs\\ServerMonitor.
 */
export function resolveInstallDir(opts: {
  existsDrive: (d: string) => boolean;
  localAppData: string;
}): string {
  if (opts.existsDrive('D:')) {
    return 'D:\\Tools\\ServerMonitor';
  }
  return path.join(opts.localAppData, 'Programs', 'ServerMonitor');
}

/**
 * Resolve the data directory. A non-empty pointer value always wins.
 * Otherwise prefer D:\\ServerMonitorData when a D: drive exists, else
 * %LOCALAPPDATA%\\ServerMonitor.
 */
export function resolveDataDir(opts: {
  installDir: string;
  existsDrive: (d: string) => boolean;
  localAppData: string;
  readDataDirPointer: () => string | null;
}): string {
  const pointer = opts.readDataDirPointer();
  if (pointer) {
    return pointer;
  }
  if (opts.existsDrive('D:')) {
    return 'D:\\ServerMonitorData';
  }
  return path.join(opts.localAppData, 'ServerMonitor');
}

/** Resolve the logs directory under a data directory. */
export function logsDir(dataDir: string): string {
  return path.join(dataDir, 'logs');
}

// ---------------------------------------------------------------------------
// P6 Task 1: data directory resolution (HKCU pointer + default non-C drive)
// ---------------------------------------------------------------------------

/** Registry key that stores the data directory pointer (HKCU). */
export const REGISTRY_KEY = 'HKCU\\Software\\ServerMonitor';
/** Registry value name that stores the data directory pointer. */
export const REGISTRY_VALUE_NAME = 'DataDir';

/**
 * Candidate non-system fixed drives, in preference order. C: (the system
 * drive) is intentionally absent so we never silently write onto it.
 */
export const DEFAULT_DRIVES: readonly string[] = [
  'D:',
  'E:',
  'F:',
  'G:',
  'H:',
  'I:',
  'J:',
  'K:',
  'L:',
  'M:',
  'N:',
  'O:',
  'P:',
  'Q:',
  'R:',
  'S:',
  'T:',
  'U:',
  'V:',
  'W:',
  'X:',
  'Y:',
  'Z:',
];

/** Minimal filesystem surface needed to judge whether a data dir is usable. */
export interface DataDirFs {
  isDirectory: (p: string) => boolean;
  writable: (p: string) => boolean;
}

/** Filesystem surface used by {@link pickDataDir}. */
export interface PickDataDirFs extends DataDirFs {
  /** Optional drive-kind probe; when true the path is treated as removable. */
  isRemovable?: (p: string) => boolean;
  /** Optional reader for the `instance.json` fallback pointer file. */
  readInstanceJson?: (p: string) => string | null;
}

/** Environment slice consumed by the default-directory logic. */
export interface PathsEnv {
  LOCALAPPDATA?: string;
}

interface RunRegResult {
  status: number;
  stdout: string;
}

/** Injected `reg` runner. Receives argv after the `reg` executable. */
export type RunReg = (args: string[]) => RunRegResult;

/** First non-system fixed drive that exists, else %LOCALAPPDATA%\\ServerMonitor. */
export function defaultDataDir(opts: {
  existsDrive: (d: string) => boolean;
  env: PathsEnv;
  drives?: readonly string[];
}): string {
  const drives = (opts.drives ?? DEFAULT_DRIVES).filter(isNonSystemFixedDrive);
  for (const drive of drives) {
    if (opts.existsDrive(drive)) {
      return `${drive}\\ServerMonitorData`;
    }
  }
  return path.join(opts.env.LOCALAPPDATA ?? '', 'ServerMonitor');
}

/** True for a single-letter drive spec that is not the C: system drive. */
function isNonSystemFixedDrive(drive: string): boolean {
  return /^[A-Za-z]:$/.test(drive) && drive.toUpperCase() !== 'C:';
}

/** Path of the fallback pointer file inside the install directory. */
export function instanceJsonPath(installDir: string): string {
  return path.join(installDir, 'instance.json');
}

/** True when `p` is a non-empty path that is an existing, writable directory. */
export function isUsableDataDir(p: string, fsApi: DataDirFs): boolean {
  if (typeof p !== 'string' || p.trim() === '') {
    return false;
  }
  try {
    return fsApi.isDirectory(p) && fsApi.writable(p);
  } catch {
    return false;
  }
}

function normalizePointer(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function dataDirKind(
  p: string,
  fsApi: { isRemovable?: (p: string) => boolean },
): 'network' | 'removable' | 'fixed' {
  if (p.startsWith('\\\\') || p.startsWith('//')) {
    return 'network';
  }
  if (fsApi.isRemovable && fsApi.isRemovable(p)) {
    return 'removable';
  }
  return 'fixed';
}

/**
 * Choose the effective data directory.
 *
 * - pointer non-empty and usable  -> use it (`source: 'pointer'`)
 * - pointer present but unusable  -> fall back to the default (`source: 'fallback'`) + warning
 * - no pointer                    -> default (`source: 'default'`)
 *
 * Network (UNC) or removable drives are still allowed but reported via `warning`.
 */
export function pickDataDir(opts: {
  pointer: string | null | undefined;
  installDir: string;
  env: PathsEnv;
  existsDrive: (d: string) => boolean;
  fsApi: PickDataDirFs;
  drives?: readonly string[];
}): { dataDir: string; source: 'pointer' | 'default' | 'fallback'; warning?: string } {
  let candidate = normalizePointer(opts.pointer);

  if (!candidate && opts.fsApi.readInstanceJson) {
    candidate = normalizePointer(
      opts.fsApi.readInstanceJson(instanceJsonPath(opts.installDir)),
    );
  }

  if (candidate) {
    if (isUsableDataDir(candidate, opts.fsApi)) {
      const kind = dataDirKind(candidate, opts.fsApi);
      if (kind === 'network') {
        return {
          dataDir: candidate,
          source: 'pointer',
          warning: `数据目录位于网络盘，可能出现访问缓慢或断连：${candidate}`,
        };
      }
      if (kind === 'removable') {
        return {
          dataDir: candidate,
          source: 'pointer',
          warning: `数据目录位于可移动盘，拔出后数据将不可用：${candidate}`,
        };
      }
      return { dataDir: candidate, source: 'pointer' };
    }
    const fallback = defaultDataDir({
      existsDrive: opts.existsDrive,
      env: opts.env,
      drives: opts.drives,
    });
    return {
      dataDir: fallback,
      source: 'fallback',
      warning: `数据目录指针不可用（${candidate}），已回退到默认目录：${fallback}`,
    };
  }

  return {
    dataDir: defaultDataDir({
      existsDrive: opts.existsDrive,
      env: opts.env,
      drives: opts.drives,
    }),
    source: 'default',
  };
}

/** Run the Windows `reg` executable, never throwing on a non-zero exit. */
function defaultRunReg(args: string[]): RunRegResult {
  const result = spawnSync('reg', args, { encoding: 'utf8', windowsHide: true });
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
  };
}

function resolveRunReg(runReg?: RunReg): RunReg | null {
  if (runReg) {
    return runReg;
  }
  if (process.platform === 'win32') {
    return defaultRunReg;
  }
  return null;
}

/**
 * Read the data directory pointer from `HKCU\\Software\\ServerMonitor\\DataDir`.
 * Returns null when absent/unreadable or when not running on Windows (and no
 * injected runner is supplied).
 */
export function readDataDirPointer(opts: { runReg?: RunReg } = {}): string | null {
  const reg = resolveRunReg(opts.runReg);
  if (!reg) {
    return null;
  }
  const { status, stdout } = reg(['query', REGISTRY_KEY, '/v', REGISTRY_VALUE_NAME]);
  if (status !== 0) {
    return null;
  }
  return parseRegQueryValue(stdout, REGISTRY_VALUE_NAME);
}

/** Extract a REG_SZ value from `reg query` output. */
function parseRegQueryValue(stdout: string, valueName: string): string | null {
  const lineRe = new RegExp(`^\\s*${valueName}\\s+REG_SZ(?:\\s+(.*))?$`, 'i');
  for (const line of stdout.split(/\r?\n/)) {
    const match = lineRe.exec(line);
    if (match) {
      return normalizePointer(match[1]);
    }
  }
  return null;
}

/**
 * Write the data directory pointer to `HKCU\\Software\\ServerMonitor\\DataDir`.
 * No-op on non-Windows when no injected runner is supplied.
 */
export function writeDataDirPointer(p: string, opts: { runReg?: RunReg } = {}): void {
  if (typeof p !== 'string' || p.trim() === '') {
    throw new TypeError('data dir pointer must be a non-empty string');
  }
  const reg = resolveRunReg(opts.runReg);
  if (!reg) {
    return;
  }
  const { status } = reg([
    'add',
    REGISTRY_KEY,
    '/v',
    REGISTRY_VALUE_NAME,
    '/t',
    'REG_SZ',
    '/d',
    p,
    '/f',
  ]);
  if (status !== 0) {
    throw new Error(`reg add failed to write data dir pointer (exit ${status})`);
  }
}
