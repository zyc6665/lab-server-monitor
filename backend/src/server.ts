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
  if (opts.db && opts.config) {
    const { createServerApp } = await import('./web/composition');
    app = createServerApp({ db: opts.db, config: opts.config });
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
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      if (runtimePath) {
        await rm(runtimePath, { force: true });
      }
    },
  };
}

// CLI entry: when run directly (e.g. `node dist/main.cjs --port 0`), start the
// server and print its URL so the Electron main process can pick it up.
if (require.main === module) {
  const argv = process.argv;
  const portIdx = argv.indexOf('--port');
  const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : 0;
  const runtimeIdx = argv.indexOf('--runtime');
  const runtimePath = runtimeIdx >= 0 ? argv[runtimeIdx + 1] : undefined;
  startServer({ port, runtimePath }).then((s) => console.log('SERVER_URL=' + s.url));
}
