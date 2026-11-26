/**
 * Minimal real ssh2 server stub for end-to-end collection tests.
 *
 * - Password authentication only (username / secret configurable).
 * - `exec` requests are answered from `commands` by exact match first, then
 *   by longest matching prefix; unknown commands succeed with empty stdout.
 * - A leading `sudo -S -p '' ` is stripped before lookup (the secret is
 *   delivered on stdin by the real client and simply drained here).
 * - Every exec exits 0.
 */
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { Server } from 'ssh2';
import type { Connection, ServerChannel } from 'ssh2';

const PW_KEY = 'password' as const;

export interface FakeSshServerOptions {
  commands: Record<string, string>;
  username?: string;
  password?: string;
}

export interface FakeSshServer {
  port: number;
  /** Commands received over exec, in order (after sudo normalisation). */
  received: string[];
  close(): Promise<void>;
}

const SUDO_PREFIX_RE = /^sudo\s+-S\s+(?:-p\s+(?:''|""|\S+)\s+)?/;

export function normaliseCommand(command: string): string {
  return command.replace(SUDO_PREFIX_RE, '');
}

export function lookupCommand(commands: Record<string, string>, command: string): string {
  const normalised = normaliseCommand(command);
  if (Object.prototype.hasOwnProperty.call(commands, normalised)) {
    return commands[normalised];
  }
  let best: string | null = null;
  for (const key of Object.keys(commands)) {
    if (normalised.startsWith(key) && (best === null || key.length > best.length)) {
      best = key;
    }
  }
  return best === null ? '' : commands[best];
}

export function startFakeSshServer(options: FakeSshServerOptions): Promise<FakeSshServer> {
  const expectedUser = options.username ?? 'tester';
  const want: string = options[PW_KEY] ?? "secret";
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  const received: string[] = [];
  const clients = new Set<Connection>();

  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {
      /* client sockets may reset during teardown */
    });
    client.on('authentication', (ctx) => {
      const supplied = (ctx as unknown as Record<string, unknown>)[PW_KEY];
      if (ctx.method === PW_KEY && ctx.username === expectedUser && supplied === want) {
        ctx.accept();
        return;
      }
      ctx.reject([PW_KEY]);
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('exec', (acceptExec, _reject, info) => {
          const channel: ServerChannel = acceptExec();
          received.push(normaliseCommand(info.command));
          const stdout = lookupCommand(options.commands, info.command);
          channel.on('data', () => undefined);
          if (stdout) {
            channel.write(stdout);
          }
          channel.exit(0);
          channel.end();
        });
      });
    });
  });

  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolveStart({
        port,
        received,
        close: () =>
          new Promise<void>((resolveClose) => {
            for (const client of clients) {
              try {
                client.end();
              } catch {
                /* ignore */
              }
            }
            server.close(() => resolveClose());
          }),
      });
    });
  });
}
