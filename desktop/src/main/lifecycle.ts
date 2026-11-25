/**
 * Pure lifecycle helpers for the Electron main process (P6 Task 4).
 *
 * Everything here is deliberately free of Electron/`node:fs` side effects so it
 * can be unit tested in plain Node:
 *
 * - CLI argument parsing (`--data-dir`, `--start-hidden`, login-item args).
 * - Backend `utilityProcess.fork` argv assembly (`buildBackendArgs`).
 * - Child-window visibility decision (`shouldShowWindow`).
 * - First-run legacy-database detection (`legacyDbCandidates`/`detectLegacyImport`).
 * - A description + injectable implementation of the graceful shutdown ladder
 *   (`shutdownPlan`: terminate → wait ≤ timeout → force kill).
 *
 * `main.ts` supplies the real dependencies (filesystem `exists`, `utilityProcess`
 * kill/wait hooks); tests supply fakes.
 */
import * as path from 'node:path';

/** The database file name used by the single-stack backend. */
export const DEFAULT_DB_FILE_NAME = 'servermonitor.db';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/** Flag that keeps the app resident in the tray without showing the window. */
export const START_HIDDEN_FLAG = '--start-hidden';
/** Flag that lets an operator override the resolved data directory. */
export const DATA_DIR_FLAG = '--data-dir';

/**
 * Return the value of `--data-dir` from `argv`, supporting both
 * `--data-dir <value>` and `--data-dir=<value>`. Returns `null` when the flag
 * is absent or has no usable value.
 */
export function parseDataDirArg(argv: readonly string[]): string | null {
  const prefix = `${DATA_DIR_FLAG}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== 'string') {
      continue;
    }
    if (token === DATA_DIR_FLAG) {
      const next = argv[i + 1];
      if (typeof next === 'string' && next !== '' && !next.startsWith('--')) {
        return next;
      }
      continue;
    }
    if (token.startsWith(prefix)) {
      const value = token.slice(prefix.length);
      if (value !== '') {
        return value;
      }
    }
  }
  return null;
}

/** True when `argv` requests a hidden tray-only start (`--start-hidden`). */
export function startHidden(argv: readonly string[]): boolean {
  return argv.includes(START_HIDDEN_FLAG);
}

/** Parsed view of the arguments registered for the OS login item. */
export interface LoginItemArgs {
  /** The arguments to pass to `app.setLoginItemSettings({ args })`. */
  args: string[];
  /** True when those arguments request a hidden start. */
  startHidden: boolean;
}

/**
 * Parse the arguments that belong to the OS login item (the reverse of what we
 * register). `main.ts` registers exactly `['--start-hidden']` so an autostart
 * launch stays resident in the tray.
 */
export function parseLoginItemArgs(argv: readonly string[]): LoginItemArgs {
  const args = argv.filter((token): token is string => typeof token === 'string');
  return { args: args.slice(), startHidden: args.includes(START_HIDDEN_FLAG) };
}

/** The exact arguments to register for the login item (autostart, hidden). */
export function buildLoginItemArgs(): string[] {
  return [START_HIDDEN_FLAG];
}

// ---------------------------------------------------------------------------
// Backend argv assembly
// ---------------------------------------------------------------------------

export interface BuildBackendArgsOptions {
  dataDir: string;
  runtimePath: string;
  /** Add `--import-legacy` so the backend imports a legacy DB on first run. */
  importLegacy?: boolean;
}

/**
 * Assemble the argv passed to `utilityProcess.fork(backendEntry, ...)`.
 *
 * Contract (stable order):
 *   `['--data-dir', dataDir, '--port', '0', '--runtime', runtimePath]`
 * plus a trailing `--import-legacy` when requested.
 */
export function buildBackendArgs(opts: BuildBackendArgsOptions): string[] {
  const args = [
    '--data-dir',
    opts.dataDir,
    '--port',
    '0',
    '--runtime',
    opts.runtimePath,
  ];
  if (opts.importLegacy) {
    args.push('--import-legacy');
  }
  return args;
}

// ---------------------------------------------------------------------------
// Window visibility
// ---------------------------------------------------------------------------

/** Whether the ready-to-show handler should actually show the window. */
export function shouldShowWindow(opts: { startHidden: boolean }): boolean {
  return !opts.startHidden;
}

// ---------------------------------------------------------------------------
// First-run legacy import detection
// ---------------------------------------------------------------------------

export interface LegacyCandidatesOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * Candidate locations for a legacy `data/servermonitor.db`, mirroring the
 * backend's own resolution order:
 *
 * 1. `SERVERMONITOR_LEGACY_DB` when set.
 * 2. `<dataDir>/../data/servermonitor.db` (portable install beside its data).
 * 3. `<cwd>/data/servermonitor.db` (source checkout).
 *
 * Duplicates are removed via `path.resolve` so the first existing candidate
 * wins deterministically.
 */
export function legacyDbCandidates(opts: LegacyCandidatesOptions): string[] {
  const env = opts.env ?? {};
  const cwd = opts.cwd ?? process.cwd();

  const raw: string[] = [];
  const explicit = env['SERVERMONITOR_LEGACY_DB']?.trim();
  if (explicit) {
    raw.push(explicit);
  }
  raw.push(path.join(opts.dataDir, '..', 'data', DEFAULT_DB_FILE_NAME));
  if (cwd) {
    raw.push(path.join(cwd, 'data', DEFAULT_DB_FILE_NAME));
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of raw) {
    const resolved = path.resolve(candidate);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      result.push(resolved);
    }
  }
  return result;
}

export interface DetectLegacyImportOptions {
  dataDir: string;
  legacyCandidates: readonly string[];
  exists: (p: string) => boolean;
  dbFileName?: string;
}

/**
 * True only when this looks like a first run (the new DB does not yet exist)
 * *and* at least one legacy DB candidate is present. In every other case the
 * backend must not be told to import (it would be a no-op at best, and risks
 * touching an existing database at worst).
 */
export function detectLegacyImport(opts: DetectLegacyImportOptions): boolean {
  const dbPath = path.join(opts.dataDir, opts.dbFileName ?? DEFAULT_DB_FILE_NAME);
  if (opts.exists(dbPath)) {
    return false;
  }
  return opts.legacyCandidates.some((candidate) => opts.exists(candidate));
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/** The ordered steps of a graceful shutdown (force kill is conditional). */
export type ShutdownStep = 'kill' | 'waitExit' | 'forceKill';

export interface ShutdownDeps {
  /** Ask the backend to terminate (send signal / close stdin, etc.). */
  kill: () => void;
  /** Resolve true when the process exited, false when the timeout elapsed. */
  waitExit: (timeoutMs: number) => Promise<boolean>;
  /** Unconditional kill used only after `waitExit` timed out. */
  forceKill: () => void;
  /** Grace period before force kill; defaults to 7000ms. */
  timeoutMs?: number;
}

export interface ShutdownPlan {
  timeoutMs: number;
  /** Declared order of the ladder (force kill only runs on timeout). */
  steps: readonly ShutdownStep[];
  /**
   * Execute the ladder: kill → wait ≤ timeoutMs → (forceKill if still alive).
   * Never throws; resolves `'graceful'` when the process exited in time and
   * `'forced'` when it had to be killed.
   */
  run: () => Promise<'graceful' | 'forced'>;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 7000;

/**
 * Build an injectable shutdown plan. Tests assert the call order and the
 * timeout→force-kill behaviour; `main.ts` wires the real utilityProcess hooks.
 */
export function shutdownPlan(deps: ShutdownDeps): ShutdownPlan {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  return {
    timeoutMs,
    steps: ['kill', 'waitExit', 'forceKill'],
    async run(): Promise<'graceful' | 'forced'> {
      try {
        deps.kill();
      } catch {
        /* termination signal is best-effort */
      }
      let exited = false;
      try {
        exited = await deps.waitExit(timeoutMs);
      } catch {
        exited = false;
      }
      if (exited) {
        return 'graceful';
      }
      try {
        deps.forceKill();
      } catch {
        /* force kill is best-effort */
      }
      return 'forced';
    },
  };
}
