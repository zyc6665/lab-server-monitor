/**
 * Runtime helpers for the desktop app: TCP port probing and the runtime-state
 * handshake file.
 *
 * This is a faithful port of `servermanage/runtime.py:157-216`
 * (`find_available_port`, `write_runtime_state`, `read_runtime_state`).
 *
 * The single-instance lock (`InstanceLock` / `acquire_single_instance`, Python
 * lines 37-154: a named Win32 mutex on Windows and `fcntl.flock` on POSIX) is
 * intentionally NOT replicated here. The Electron main process already guards
 * startup with `app.requestSingleInstanceLock()`, so a second backend process
 * can never be spawned from the same data directory; duplicating the mutex
 * would only add a second, conflicting ownership contract.
 *
 * `find_available_port` is inherently asynchronous in Node because binding a
 * port goes through `net.Server#listen`, hence the `Promise<number>` return.
 * The state read/write helpers stay synchronous, exactly like the Python
 * oracle, so they can be injected into synchronous call sites (for example
 * `SystemRouteDeps.readRuntimeState`).
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { createServer } from 'node:net';
import type { Server } from 'node:net';

import { dumpJson } from '../storage/json';

/** A decoded runtime-state document (`{ url, port, pid, ... }`). */
export type RuntimeState = Record<string, unknown>;

/** Fields accepted by {@link writeRuntimeState}. */
export interface RuntimeStateInput {
  url: string;
  port: number;
  /** Owning process id; defaults to `null` (Python's `pid: int | None = None`). */
  pid?: number | null;
}

/** Same predicate the Python reader relies on for `isinstance(data, dict)`. */
function isPlainObject(value: unknown): value is RuntimeState {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolves once a server is listening on `host:port`, or rejects on failure. */
function listenOnce(host: string, port: number): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer();
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** Closes a listening server and resolves once its handle is released. */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Returns the first bindable TCP port in `[preferred, preferred + span)`.
 *
 * Mirrors `servermanage/runtime.py::find_available_port`: probes consecutive
 * candidates, skipping occupied ones, and throws an `Error` (Python raises
 * `OSError`) once the whole window is exhausted.
 */
export async function findAvailablePort(
  host: string,
  preferred: number,
  span = 20,
): Promise<number> {
  let lastError: Error | undefined;
  for (let port = preferred; port < preferred + span; port += 1) {
    try {
      const server = await listenOnce(host, port);
      await closeServer(server);
      return port;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw new Error(
    `No available port in ${preferred}-${preferred + span - 1} on '${host}' ` +
      `(last error: ${lastError?.message ?? 'None'})`,
  );
}

/**
 * Atomically writes the runtime-state JSON (UTF-8) to `filePath`.
 *
 * Port of `servermanage/runtime.py::write_runtime_state`:
 * - the payload keys are exactly `url`, `port`, `pid`;
 * - JSON is serialised with Python's default separators (`", "` / `": "`,
 *   one line, `ensure_ascii=False`) via {@link dumpJson};
 * - a sibling temp file is written, `fsync`-ed (Python `os.fsync`) and then
 *   `rename`-d over the target (Python `os.replace`) so readers never observe
 *   a half-written file. Any failure removes the temp file before rethrowing.
 */
export function writeRuntimeState(filePath: string, state: RuntimeStateInput): void {
  const targetDir = path.dirname(filePath);
  mkdirSync(targetDir, { recursive: true });

  const payload = { url: state.url, port: state.port, pid: state.pid ?? null };
  const serialized = dumpJson(payload);
  const tempPath = path.join(
    targetDir,
    `${path.basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`,
  );

  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx');
    writeFileSync(fd, serialized, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best effort: the original error is more useful to the caller.
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // Temp file may never have been created/replaced; ignore.
    }
    throw error;
  }
}

/**
 * Reads the runtime-state JSON. Returns `null` when the file is missing, not
 * valid UTF-8 JSON, or its top-level value is not a JSON object — the same
 * contract as `servermanage/runtime.py::read_runtime_state`.
 */
export function readRuntimeState(filePath: string): RuntimeState | null {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
