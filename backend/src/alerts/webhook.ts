/**
 * Webhook notification channels, ported from `servermanage/notify_webhook.py`.
 *
 * WeCom (企业微信), DingTalk (钉钉) and Feishu (飞书) robot webhooks receive a
 * platform-specific "text" payload; a generic webhook receives a flat JSON
 * object describing the alert.  {@link sendWebhook} performs the HTTP POST with
 * a bounded timeout and never throws: it returns `true` only for a 2xx response
 * whose JSON body (when present) reports success, so the composite notifier can
 * isolate a failing channel.
 *
 * The webhook URL is resolved from `config.url` first, then from the environment
 * variable named by `config.urlEnv` (Python `url_env`).  Nothing secret is
 * logged: on failure only the exception type / numeric status is reported.
 */

/** Alert fields the webhook payloads read (structural subset of `AlertEvent`). */
export interface WebhookAlertEvent {
  host_name: string;
  severity: string;
  title: string;
  message: string;
  category?: string;
  fingerprint?: string;
}

/** Webhook channel config (`servermanage/models.py:205` `WebhookConfig`). */
export interface WebhookConfig {
  enabled?: boolean;
  type?: string;
  url?: string | null;
  /** camelCase form of Python `url_env`. */
  urlEnv?: string | null;
  /** snake_case form, accepted for direct parity with Python configs. */
  url_env?: string | null;
}

/** Minimal response surface {@link sendWebhook} reads from the fetch result. */
export interface WebhookResponse {
  status: number;
  text?: () => Promise<string>;
}

/** Injectable `fetch` (tests pass a fake; default is the global `fetch`). */
export type FetchLike = (
  url: string,
  init: RequestInit
) => Promise<WebhookResponse>;

export interface SendWebhookOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Clock override for deterministic payload timestamps in tests. */
  now?: () => Date;
}

/** Shared text/markdown-ish robot payload shape (WeCom + DingTalk). */
const TEXT_KINDS = new Set(['wecom', 'dingtalk']);

const DEFAULT_TIMEOUT_MS = 10000;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Local, human-readable ISO-8601 timestamp for alert payloads.
 *
 * Mirrors Python `datetime.now(timezone.utc).astimezone().isoformat(
 * timespec="seconds")`: local wall-clock time with a numeric UTC offset and
 * second precision (e.g. `2026-11-26T00:13:48+08:00`).
 */
export function nowIsoLocal(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  return (
    `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}` +
    `T${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}${offset}`
  );
}

/** Readable text body shared by WeCom and DingTalk. */
function textContent(event: WebhookAlertEvent, now: Date): string {
  return (
    `[${event.severity}] ${event.title}\n` +
    `主机: ${event.host_name}\n` +
    `${event.message}\n` +
    `时间: ${nowIsoLocal(now)}`
  );
}

/**
 * Builds the JSON payload for `kind` from `event`:
 *   - `wecom` / `dingtalk` -> `{ "msgtype": "text", "text": { "content": ... } }`
 *   - `feishu`             -> `{ "msg_type": "text", "content": { "text": ... } }`
 *   - anything else        -> flat `{ host, severity, title, message, timestamp }`
 */
export function buildWebhookPayload(
  kind: string,
  event: WebhookAlertEvent,
  now: Date = new Date()
): Record<string, unknown> {
  const normalized = (kind || '').trim().toLowerCase();
  if (normalized === 'feishu') {
    return { msg_type: 'text', content: { text: textContent(event, now) } };
  }
  if (TEXT_KINDS.has(normalized)) {
    return { msgtype: 'text', text: { content: textContent(event, now) } };
  }
  return {
    host: event.host_name,
    severity: event.severity,
    title: event.title,
    message: event.message,
    timestamp: nowIsoLocal(now),
  };
}

function resolveUrl(config: WebhookConfig): string | null {
  if (config.url) {
    return config.url;
  }
  const envName = config.urlEnv ?? config.url_env;
  if (envName) {
    const value = process.env[envName];
    return value !== undefined && value !== '' ? value : null;
  }
  return null;
}

async function readJsonBody(
  response: WebhookResponse
): Promise<Record<string, unknown> | null> {
  if (typeof response.text !== 'function') {
    return null;
  }
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Checks robot error codes when a channel returns HTTP 2xx with an app error.
 * Feishu reports `code`/`StatusCode`, WeCom/DingTalk report `errcode`; a
 * missing code counts as success.
 */
function webhookBodyOk(kind: string, payload: Record<string, unknown> | null): boolean {
  if (!payload) {
    return true;
  }
  const normalized = (kind || '').trim().toLowerCase();
  let code: unknown;
  if (normalized === 'feishu') {
    code = payload.code ?? payload.StatusCode;
  } else if (TEXT_KINDS.has(normalized)) {
    code = payload.errcode;
  } else {
    return true;
  }
  if (code === undefined || code === null) {
    return true;
  }
  return Number(code) === 0;
}

/**
 * POSTs `event` to `config`'s webhook using `kind`'s payload shape.
 *
 * Returns `true` only on a 2xx response whose body reports success.  Every
 * failure (missing URL, network error, timeout, non-2xx, app error) yields
 * `false`; this function never throws.
 */
export async function sendWebhook(
  kind: string,
  event: WebhookAlertEvent,
  config: WebhookConfig,
  options: SendWebhookOptions = {}
): Promise<boolean> {
  const url = resolveUrl(config);
  if (!url) {
    console.warn(
      `Webhook channel enabled but no URL configured (type=${kind || config.type || ''})`
    );
    return false;
  }

  let payload: Record<string, unknown>;
  try {
    payload = buildWebhookPayload(kind, event, options.now?.() ?? new Date());
  } catch {
    console.error('Failed to build webhook payload');
    return false;
  }

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (typeof fetchImpl !== 'function') {
    console.warn('Webhook POST failed (fetch unavailable)');
    return false;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller =
    typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (controller !== undefined) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller?.signal,
    });
    const status = typeof response.status === 'number' ? response.status : NaN;
    if (status >= 200 && status < 300) {
      const body = await readJsonBody(response);
      if (webhookBodyOk(kind, body)) {
        return true;
      }
      console.warn(
        `Webhook endpoint reported an application error (type=${kind || config.type || ''})`
      );
      return false;
    }
    console.warn(`Webhook endpoint returned non-2xx status: ${status}`);
    return false;
  } catch (err) {
    const name = err instanceof Error ? err.name : typeof err;
    console.warn(`Webhook POST failed (${name})`);
    return false;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
