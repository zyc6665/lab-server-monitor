import { ConfigError } from './errors';

/**
 * Typed, validated view over the process environment.
 *
 * Only Node runtime configuration is read here (data/log/app directories, the
 * listen host/port, TLS material, an optional servers JSON bootstrap, desktop
 * and SSRF flags). Secret values (SSH/DASHBOARD passwords, webhook URLs) are
 * resolved lazily by the host normaliser from the live environment, matching
 * the Python oracle which reads them via `os.getenv` at config-load time.
 */
export interface ConfigEnv {
  /** Install directory (SERVERMONITOR_APP_DIR). */
  appDir?: string;
  /** Data directory (SERVERMONITOR_DATA_DIR). */
  dataDir?: string;
  /** Log directory override (SERVERMONITOR_LOG_DIR). */
  logDir?: string;
  /** Listen host override (SERVERMONITOR_HOST). */
  host?: string;
  /** Listen port override (SERVERMONITOR_PORT). */
  port?: number;
  /** App version override (SERVERMONITOR_APP_VERSION). */
  appVersion?: string;
  /** TLS certificate path (SERVERMONITOR_TLS_CERT). */
  tlsCert?: string;
  /** TLS private key path (SERVERMONITOR_TLS_KEY). */
  tlsKey?: string;
  /** Optional JSON array of server entries (SERVERMONITOR_SERVERS_JSON). */
  serversJson?: string;
  /** Desktop mode flag (SERVERMONITOR_DESKTOP === '1' | 'true'). */
  desktop: boolean;
  /** Whether private/loopback targets are allowed for probes. */
  allowPrivateTargets: boolean;
}

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const t = value.trim();
  return t === '' ? undefined : t;
}

function envFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function parsePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new ConfigError('SERVERMONITOR_PORT must be an integer between 0 and 65535');
  }
  return n;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): ConfigEnv {
  const portRaw = trimmed(env.SERVERMONITOR_PORT);
  return {
    appDir: trimmed(env.SERVERMONITOR_APP_DIR),
    dataDir: trimmed(env.SERVERMONITOR_DATA_DIR),
    logDir: trimmed(env.SERVERMONITOR_LOG_DIR),
    host: trimmed(env.SERVERMONITOR_HOST),
    port: portRaw === undefined ? undefined : parsePort(portRaw),
    appVersion: trimmed(env.SERVERMONITOR_APP_VERSION),
    tlsCert: trimmed(env.SERVERMONITOR_TLS_CERT),
    tlsKey: trimmed(env.SERVERMONITOR_TLS_KEY),
    serversJson: trimmed(env.SERVERMONITOR_SERVERS_JSON),
    desktop: envFlag(env.SERVERMONITOR_DESKTOP),
    allowPrivateTargets:
      envFlag(env.SERVERMONITOR_ALLOW_PRIVATE_TARGETS) ||
      envFlag(env.SERVERMONITOR_SSRF_ALLOW_PRIVATE),
  };
}
