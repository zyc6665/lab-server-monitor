import express, { type Express } from 'express';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { APP_VERSION } from './version';

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
  const app = createApp();
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

  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
