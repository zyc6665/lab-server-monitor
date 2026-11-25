/**
 * SMTP report delivery, ported from the Python oracle `servermanage/mailer.py`.
 *
 * Python builds an `email.message.EmailMessage` and drives `smtplib` directly.
 * Here the transport is abstracted behind {@link MailClient} so tests inject a
 * fake and never open a real socket; the production default wraps a
 * `nodemailer` transporter (`SMTP` / `SMTP_SSL` equivalent via the `secure`
 * flag, STARTTLS negotiated automatically for the plain branch).
 *
 * Retry semantics are 1:1 with Python `send_report`:
 *   - `retries` is the total number of attempts (Python `max_attempts=3`).
 *   - transient network / server-disconnect / connect / timeout errors are
 *     retried with a linear backoff `delayMs * attempt` (3s, 6s, ...).
 *   - authentication failures abort immediately (never retried).
 *   - any other error propagates immediately, as Python only catches
 *     `OSError`, `TimeoutError`, `SMTPServerDisconnected`, `SMTPConnectError`.
 */
import nodemailer from 'nodemailer';

/** Subset of Python `SMTPConfig` (`servermanage/models.py:90`). */
export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  useSsl: boolean;
  fromAddr: string;
  toAddrs: string[];
}

/** A ready-to-send message; the shape `nodemailer` `sendMail` expects. */
export interface MailMessage {
  subject: string;
  from: string;
  to: string;
  text: string;
  html: string;
}

/**
 * Minimal SMTP client surface. `starttls` / `login` are optional because a
 * real `nodemailer` transport performs both internally from its constructor
 * options, while fakes model the Python `smtplib` call sequence.
 */
export interface MailClient {
  sendMail(message: MailMessage): Promise<unknown> | unknown;
  starttls?(): Promise<unknown> | unknown;
  login?(username: string, password: string): Promise<unknown> | unknown;
  close?(): void;
}

/** Builds a fresh client for `(host, port)`. */
export type MailClientFactory = (host: string, port: number) => MailClient;

/** Fields `buildMessage` accepts (mirrors Python keyword args). */
export interface BuildMessageInput {
  subject: string;
  fromAddr: string;
  toAddrs: readonly string[];
  textBody: string;
  htmlBody: string;
}

export interface SendReportOptions {
  /** Plain (STARTTLS) client factory; defaults to a real nodemailer transport. */
  smtpFactory?: MailClientFactory;
  /** SSL client factory; defaults to a real nodemailer transport. */
  smtpSslFactory?: MailClientFactory;
  /** Total send attempts (Python `max_attempts`), clamped to >= 1. */
  retries?: number;
  /** Base retry delay in milliseconds; actual delay is `delayMs * attempt`. */
  delayMs?: number;
  /** Injectable sleep (tests use it to avoid real waits); default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_DELAY_MS = 3000;

/**
 * Builds the message object from its parts.
 *
 * Python `EmailMessage` stores `To` as a comma-joined header and attaches both
 * a plain-text body and an HTML alternative; `nodemailer` produces the same
 * `multipart/alternative` MIME from the equivalent `{ text, html }` options.
 */
export function buildMessage(input: BuildMessageInput): MailMessage {
  return {
    subject: input.subject,
    from: input.fromAddr,
    to: input.toAddrs.join(', '),
    text: input.textBody,
    html: input.htmlBody,
  };
}

function defaultClientFactory(smtp: SmtpConfig): MailClientFactory {
  return (host: string, port: number): MailClient => {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: smtp.useSsl,
      auth:
        smtp.username !== ''
          ? { user: smtp.username, pass: smtp.password }
          : undefined,
    });
    return {
      sendMail: (message: MailMessage) => transporter.sendMail(message),
      close: () => transporter.close(),
    };
  };
}

function asRecord(err: unknown): Record<string, unknown> {
  return typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
}

function errorCode(err: unknown): string {
  const code = asRecord(err).code;
  return typeof code === 'string' ? code : '';
}

function errorName(err: unknown): string {
  const name = asRecord(err).name;
  return typeof name === 'string' ? name : '';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const AUTH_CODES = new Set(['EAUTH', 'EACCES']);
const RETRYABLE_CODES = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);
const RETRYABLE_NAMES = new Set([
  'SMTPServerDisconnected',
  'SMTPConnectError',
  'TimeoutError',
  'ConnectionError',
]);

/** True for SMTP auth failures, which must abort immediately (never retried). */
export function isAuthError(err: unknown): boolean {
  if (AUTH_CODES.has(errorCode(err))) return true;
  if (errorName(err).toLowerCase().includes('authentication')) return true;
  return /authentication|invalid login|535 auth/i.test(errorText(err));
}

/** True for transient network / timeout / server-disconnect errors. */
export function isRetryableError(err: unknown): boolean {
  if (RETRYABLE_CODES.has(errorCode(err))) return true;
  if (RETRYABLE_NAMES.has(errorName(err))) return true;
  return /disconnect|timed out|timeout|socket|network|getaddrinfo|econn/i.test(errorText(err));
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function sendOnce(
  smtp: SmtpConfig,
  message: MailMessage,
  factory: MailClientFactory
): Promise<void> {
  const client = factory(smtp.host, smtp.port);
  try {
    // Python: SSL connections skip starttls(); plain connections upgrade.
    if (!smtp.useSsl && typeof client.starttls === 'function') {
      await client.starttls();
    }
    if (typeof client.login === 'function') {
      await client.login(smtp.username, smtp.password);
    }
    await client.sendMail(message);
  } finally {
    try {
      client.close?.();
    } catch {
      // A close() failure must not mask the original send result.
    }
  }
}

/**
 * Sends `message` over SMTP, retrying transient failures.
 *
 * Resolves on the first successful send; rejects with the last error when all
 * attempts fail, or immediately on an authentication failure.
 */
export async function sendReport(
  smtp: SmtpConfig,
  message: MailMessage,
  options: SendReportOptions = {}
): Promise<void> {
  const factory = smtp.useSsl
    ? options.smtpSslFactory ?? defaultClientFactory(smtp)
    : options.smtpFactory ?? defaultClientFactory(smtp);
  const attempts = Math.max(1, options.retries ?? DEFAULT_RETRIES);
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await sendOnce(smtp, message, factory);
      return;
    } catch (err) {
      if (isAuthError(err) || !isRetryableError(err) || attempt >= attempts) {
        throw err;
      }
      const sleepSeconds = delayMs * attempt;
      console.warn(
        `SMTP send attempt ${attempt}/${attempts} failed: ${errorText(err)}. ` +
          `Retrying in ${sleepSeconds} ms.`
      );
      await sleep(sleepSeconds);
    }
  }
}
