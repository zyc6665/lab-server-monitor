import express, { type Express } from 'express';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { APP_VERSION } from './version';
import type { AppConfig } from './config/config';

type SqliteDatabase = import('better-sqlite3').Database;

/** Builds the Express app with the P0 system routes. */
export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get('/api/system/health', (_req, res) => {
    res.status(200).json({ status: 'ok', version: APP_VERSION });
  });

  return app;
}

export interface StartServerOptions {
  /** Port to bind; 0 (default) lets the OS pick a free port. */
  port?: number;
  /**
   * Optional path for a runtime handshake file. When given, the file is
   * written (JSON `{ url, port, pid }`, UTF-8) after the server starts
   * listening and removed again by {@link StartedServer.close}.
   */
  runtimePath?: string;
  /**
   * Optional open SQLite handle. When supplied together with {@link config},
   * the server assembles the full P2 web app via `createServerApp` instead of
   * the P0 health-only app. When either is omitted the behaviour is unchanged
   * (health endpoint only) — this keeps the Electron utilityProcess boot and
   * the packaged `main.cjs` smoke test working without a database.
   */
  db?: SqliteDatabase;
  /** Optional resolved runtime config; required alongside {@link db}. */
  config?: AppConfig;
  /**
   * Whether to start the background task scheduler once the full app is
   * composed. Defaults to `true` outside the test environment and `false`
   * under Vitest (`NODE_ENV=test` / `VITEST` set), so unit tests never spawn a
   * 600 s collection loop. Pass `false` to opt out explicitly, or `true` to
   * force it on even under test.
   */
  scheduler?: boolean;
}

/** True when running under the Vitest test runner. */
function isTestEnvironment(): boolean {
  return process.env['NODE_ENV'] === 'test' || process.env['VITEST'] !== undefined;
}

export interface StartedServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Starts the HTTP server on 127.0.0.1 and resolves once it is listening.
 * The returned `close()` shuts the server down and resolves when done.
 */
export async function startServer(opts: StartServerOptions = {}): Promise<StartedServer> {
  const requestedPort = opts.port ?? 0;

  // Full composition when a database + config are injected; otherwise the
  // P0 health-only app (default Electron boot). The composition module is
  // imported lazily so the health-only bundle never loads the native
  // better-sqlite3 / @primno/dpapi modules at startup.
  let app: Express;
  let stopScheduler: (() => void) | null = null;
  if (opts.db && opts.config) {
    const { createServerApp } = await import('./web/composition');
    app = createServerApp({ db: opts.db, config: opts.config });

    // Start the background scheduler on the same db/config assembly path. The
    // wiring module is imported lazily so the health-only bundle never loads
    // the collector/storage stack. Scheduler failures must never prevent the
    // HTTP server from coming up.
    const shouldStartScheduler = opts.scheduler ?? !isTestEnvironment();
    if (shouldStartScheduler) {
      try {
        const { startSchedulerIfConfigured } = await import('./runtime/wiring');
        const handle = startSchedulerIfConfigured({ db: opts.db, config: opts.config });
        if (handle) {
          stopScheduler = handle.stop;
        }
      } catch (err) {
        console.error('[server] failed to start scheduler:', err);
      }
    }
  } else {
    app = createApp();
  }

  const server: Server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, '127.0.0.1');
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('startServer: failed to determine bound address');
  }

  const boundPort = (address as AddressInfo).port;
  const url = `http://127.0.0.1:${boundPort}`;
  const { runtimePath } = opts;

  // Handshake: let a parent process (Electron main) discover the bound port.
  if (runtimePath) {
    await mkdir(path.dirname(runtimePath), { recursive: true });
    const runtime = { url, port: boundPort, pid: process.pid };
    await writeFile(runtimePath, JSON.stringify(runtime), 'utf8');
  }

  return {
    url,
    port: boundPort,
    close: async () => {
      // Stop the scheduler before draining HTTP so no in-flight tick races the
      // shutdown. `stop()` is idempotent.
      if (stopScheduler) {
        stopScheduler();
        stopScheduler = null;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      if (runtimePath) {
        await rm(runtimePath, { force: true });
      }
    },
  };
}

/**
 * Perform the packaged-desktop startup sequence: resolve the data directory,
 * import a legacy database / config seed on first run, open the database,
 * migrate it behind a pre-migration backup, initialise the schema, assemble the
 * full web app and start listening.
 *
 * All native/storage modules are imported lazily here (never at `server.ts`
 * module load) so the health-only entry point and the bundled `main.cjs` smoke
 * test keep booting without loading `better-sqlite3`/`@primno/dpapi`. Any
 * failure — including a failed pre-migration backup — aborts startup: the
 * database handle is closed and the error is rethrown so the process exits
 * non-zero without ever serving traffic.
 */
async function runBootstrapCli(): Promise<void> {
  const { resolveRuntimePaths, resolveLegacyCandidates, firstRunImport, migrateWithBackup } =
    await import('./runtime/first-run');
  const { openDatabase } = await import('./storage/db');
  const { initSchema } = await import('./storage/schema');
  const { loadConfig } = await import('./config/config');

  const resolved = resolveRuntimePaths(process.argv, process.env);
  await mkdir(resolved.dataDir, { recursive: true });

  const legacyCandidates = resolved.importLegacy
    ? resolveLegacyCandidates(resolved.dataDir, process.env)
    : [];
  const importResult = await firstRunImport({
    dataDir: resolved.dataDir,
    dbPath: resolved.dbPath,
    legacyDbCandidates: legacyCandidates,
    configSeedPath: resolved.configSeedPath,
    env: process.env,
  });
  for (const message of importResult.messages) {
    console.log('[first-run] ' + message);
  }

  // The database is opened only *after* firstRunImport so the atomic legacy
  // copy can replace the file (a SQLite file cannot be renamed over while a
  // handle is open on Windows).
  const db = openDatabase(resolved.dbPath);
  let started: StartedServer;
  try {
    await migrateWithBackup(resolved.dbPath, db);
    initSchema(db);

    const config = loadConfig({
      ...process.env,
      SERVERMONITOR_DATA_DIR: resolved.dataDir,
    });
    if (resolved.port !== undefined) {
      config.port = resolved.port;
    }

    started = await startServer({
      port: resolved.port ?? config.port,
      runtimePath: resolved.runtimePath,
      db,
      config,
    });
  } catch (err) {
    try {
      db.close();
    } catch {
      /* best-effort cleanup; the original error is what matters */
    }
    throw err;
  }

  console.log('SERVER_URL=' + started.url);
}

// CLI entry: when run directly (e.g. `node dist/main.cjs --port 0`), start the
// server and print its URL so the Electron main process can pick it up. The
// full data-directory bootstrap (open DB, first-run import, migrate, compose the
// web app) only runs when a `--data-dir`/`--import-legacy` flag is present; a
// bare `--port`/`--runtime` invocation keeps the historical health-only
// behaviour so the packaged smoke test still passes.
if (require.main === module) {
  const wantsBootstrap = process.argv.some(
    (token) =>
      token === '--data-dir' ||
      token.startsWith('--data-dir=') ||
      token === '--import-legacy',
  );

  if (wantsBootstrap) {
    runBootstrapCli().catch((err) => {
      console.error('[server] startup failed:', err);
      process.exitCode = 1;
    });
  } else {
    const argv = process.argv;
    const portIdx = argv.indexOf('--port');
    const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : 0;
    const runtimeIdx = argv.indexOf('--runtime');
    const runtimePath = runtimeIdx >= 0 ? argv[runtimeIdx + 1] : undefined;
    startServer({ port, runtimePath })
      .then((s) => console.log('SERVER_URL=' + s.url))
      .catch((err) => {
        console.error('[server] startup failed:', err);
        process.exitCode = 1;
      });
  }
}
