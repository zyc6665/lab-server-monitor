/**
 * Nunjucks compatibility layer for the reused Jinja templates under
 * `servermanage/web/templates` (design §6.2, plan Task 7).
 *
 * The Python app renders those templates with Jinja2; this module builds an
 * equivalent Nunjucks {@link nunjucks.Environment}:
 *
 *   - autoescaping on (matching Jinja2's `autoescape=True`),
 *   - the template filters the templates actually use (`stamp`, `anchor`,
 *     `rate`, `format`, `tojson`) implemented to match the oracle byte-for-byte,
 *     plus `min`/`max` which Nunjucks ships without,
 *   - the globals `url_for`, `asset_url` and `csrf_token`,
 *   - a `renderPage(res, template, ctx)` helper that injects `request`,
 *     `session`, `app_version` and `view_mode` and writes a 200 text/html
 *     response.
 *
 * Jinja-specific syntax that Nunjucks cannot evaluate natively is shimmed here
 * (see `installMemberGetShim`); anything still unsupported is reported rather
 * than worked around by editing the read-only templates.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';

import * as nunjucks from 'nunjucks';
import type { Response } from 'express';

import { assetUrl, urlFor, type UrlParams } from './routes/registry';

/** Options for {@link configureNunjucks} / {@link createTemplating}. */
export interface TemplatingOptions {
  /** Absolute path to the template root. Defaults to the reused Jinja tree. */
  templatesDir?: string;
  /** `APP_VERSION` used by the `asset_url` cache-buster global. */
  appVersion?: string;
  /** Force autoescaping on/off. Defaults to `true` (Jinja parity). */
  autoescape?: boolean;
}

/** Default root: the read-only `servermanage/web/templates` tree. */
export function defaultTemplatesDir(): string {
  return path.resolve(__dirname, '../../../servermanage/web/templates');
}

/**
 * Per-render context surfaced to the `csrf_token()` global.
 *
 * The token is produced lazily (and memoised) so that rendering a page which
 * never calls `csrf_token()` does not touch the session / set a cookie — the
 * same behaviour as Flask's on-demand `session["csrf_token"]`.
 */
interface RenderStore {
  csrfToken(): string;
}

const renderStore = new AsyncLocalStorage<RenderStore>();

// ---------------------------------------------------------------------------
// Python-compatible numeric helpers
// ---------------------------------------------------------------------------

/** Python 3 `round()` — round half to even (banker's rounding). */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) {
    return floor + 1;
  }
  if (diff < 0.5) {
    return floor;
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python's `f"{value:.{digits}f}"` (round half to even, fixed notation). */
function formatFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  const negative = value < 0;
  const factor = 10 ** digits;
  const rounded = roundHalfEven(Math.abs(value) * factor);
  let text = String(rounded);
  if (digits > 0) {
    if (text.length <= digits) {
      text = '0'.repeat(digits - text.length + 1) + text;
    }
    text = `${text.slice(0, text.length - digits)}.${text.slice(text.length - digits)}`;
  }
  return negative ? `-${text}` : text;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

// Matches the ISO-8601 shapes `datetime.fromisoformat` accepts in the oracle.
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * `stamp` — format an ISO timestamp as `%m-%d %H:%M`.
 *
 * Mirrors the oracle: falsy values render an em dash; naive timestamps keep
 * their wall clock; timezone-aware timestamps are converted to local time;
 * unparseable strings pass through unchanged.
 */
export function stamp(value: unknown): string {
  if (!value) {
    return '—';
  }
  const text = String(value);
  const match = ISO_RE.exec(text);
  if (!match) {
    return text;
  }
  const [, , month, day, hour = '00', minute = '00', , , tz] = match;
  if (tz) {
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) {
      return text;
    }
    return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }
  return `${month}-${day} ${hour}:${minute}`;
}

/** `anchor` — slugify a host name exactly like `servermanage/web/anchors.py`. */
export function anchor(value: unknown): string {
  const text = value ? String(value) : '';
  const slug = text.replace(/[^0-9A-Za-z_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'host';
}

const RATE_UNITS = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'] as const;

/** `rate` — humanise a bytes/second figure like the oracle's `rate` filter. */
export function rate(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  let amount: number;
  if (typeof value === 'number') {
    amount = value;
  } else if (typeof value === 'boolean') {
    amount = value ? 1 : 0;
  } else {
    const trimmed = String(value).trim();
    amount = trimmed === '' ? Number.NaN : Number(trimmed);
  }
  if (Number.isNaN(amount) || amount < 0) {
    return '—';
  }
  let index = 0;
  while (amount >= 1024 && index < RATE_UNITS.length - 1) {
    amount /= 1024;
    index += 1;
  }
  const unit = RATE_UNITS[index];
  if (index === 0) {
    return `${Math.trunc(roundHalfEven(amount))} ${unit}`;
  }
  if (amount >= 100) {
    return `${formatFixed(amount, 0)} ${unit}`;
  }
  return `${formatFixed(amount, 1)} ${unit}`;
}

/**
 * `format` — the printf subset the templates use (`%s %d %i %f %.Nf %x %X %o`,
 * plus width / zero padding / `%%`).
 */
export function format(template: unknown, ...args: unknown[]): string {
  const source = String(template ?? '');
  let argIndex = 0;
  let result = '';
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char !== '%') {
      result += char;
      i += 1;
      continue;
    }
    if (source[i + 1] === '%') {
      result += '%';
      i += 2;
      continue;
    }
    const spec = /^%([-+ 0#]*)(\d*)(?:\.(\d+))?([sdifxXo])/.exec(source.slice(i));
    if (!spec) {
      result += char;
      i += 1;
      continue;
    }
    const [, flags, widthText, precisionText, conversion] = spec;
    const arg = args[argIndex];
    argIndex += 1;
    const precision = precisionText === undefined ? undefined : Number(precisionText);
    let rendered: string;
    switch (conversion) {
      case 'd':
      case 'i': {
        rendered = String(Math.trunc(Number(arg)));
        break;
      }
      case 'f': {
        rendered = formatFixed(Number(arg), precision === undefined ? 6 : precision);
        break;
      }
      case 'x': {
        rendered = Math.trunc(Number(arg)).toString(16);
        break;
      }
      case 'X': {
        rendered = Math.trunc(Number(arg)).toString(16).toUpperCase();
        break;
      }
      case 'o': {
        rendered = Math.trunc(Number(arg)).toString(8);
        break;
      }
      default: {
        rendered = String(arg);
        break;
      }
    }
    const width = widthText ? Number(widthText) : 0;
    if (width > rendered.length) {
      const zeroPad = flags.includes('0') && !flags.includes('-') && conversion !== 's';
      if (zeroPad) {
        const sign = rendered.startsWith('-') ? '-' : '';
        const body = sign ? rendered.slice(1) : rendered;
        rendered = sign + body.padStart(width - sign.length, '0');
      } else if (flags.includes('-')) {
        rendered = rendered.padEnd(width, ' ');
      } else {
        rendered = rendered.padStart(width, ' ');
      }
    }
    result += rendered;
    i += spec[0].length;
  }
  return result;
}

/** `tojson` — HTML-safe JSON, marked safe so autoescape does not escape it. */
export function tojson(value: unknown): nunjucks.runtime.SafeString {
  let json: string;
  try {
    const serialised = JSON.stringify(value);
    json = serialised === undefined ? 'null' : serialised;
  } catch {
    json = 'null';
  }
  json = json.replace(/[<>&']/g, (char) => {
    switch (char) {
      case '<':
        return '\\u003c';
      case '>':
        return '\\u003e';
      case '&':
        return '\\u0026';
      default:
        return '\\u0027';
    }
  });
  return new nunjucks.runtime.SafeString(json);
}

/** `min` — Nunjucks has no built-in; reduce a list or argument list. */
export function minFilter(...values: unknown[]): number {
  const list = values.length === 1 && Array.isArray(values[0]) ? values[0] : values;
  return list.reduce<number>(
    (acc, item) => Math.min(acc, Number(item)),
    Number.POSITIVE_INFINITY,
  );
}

/** `max` — Nunjucks has no built-in; reduce a list or argument list. */
export function maxFilter(...values: unknown[]): number {
  const list = values.length === 1 && Array.isArray(values[0]) ? values[0] : values;
  return list.reduce<number>(
    (acc, item) => Math.max(acc, Number(item)),
    Number.NEGATIVE_INFINITY,
  );
}

// ---------------------------------------------------------------------------
// Jinja `dict.get()` / `session.get()` compatibility
// ---------------------------------------------------------------------------

/**
 * Nunjucks resolves `obj.get(key, default)` against a plain object literal to
 * `undefined` (JS objects have no `.get`). Jinja templates rely on it heavily
 * (`page_titles.get(active_page, '概览')`, `group_stats.get(...)`, ...).
 *
 * We wrap `nunjucks.runtime.memberLookup` so that `.get` on a *plain* object
 * (one without its own `get`) yields a Python-dict-like accessor. Objects that
 * already expose `get` (our injected `request.args` / `session`) are untouched.
 */
export function installMemberGetShim(): void {
  const runtime = (nunjucks as unknown as { runtime?: Record<string, unknown> }).runtime;
  if (!runtime || typeof runtime.memberLookup !== 'function') {
    return;
  }
  if (runtime.__servermonitorGetShim) {
    return;
  }
  const original = runtime.memberLookup as (obj: unknown, val: unknown) => unknown;
  runtime.memberLookup = (obj: unknown, val: unknown): unknown => {
    if (
      val === 'get' &&
      obj !== null &&
      typeof obj === 'object' &&
      !Array.isArray(obj) &&
      !Object.prototype.hasOwnProperty.call(obj, 'get')
    ) {
      const record = obj as Record<string, unknown>;
      return (key: unknown, fallback?: unknown): unknown => {
        const name = String(key);
        if (Object.prototype.hasOwnProperty.call(record, name) && record[name] !== undefined && record[name] !== null) {
          return record[name];
        }
        return fallback === undefined ? '' : fallback;
      };
    }
    return original(obj, val);
  };
  runtime.__servermonitorGetShim = true;
}

// ---------------------------------------------------------------------------
// Environment construction
// ---------------------------------------------------------------------------

function registerFilters(env: nunjucks.Environment): void {
  env.addFilter('stamp', (value: unknown) => stamp(value));
  env.addFilter('anchor', (value: unknown) => anchor(value));
  env.addFilter('rate', (value: unknown) => rate(value));
  env.addFilter('format', (template: unknown, ...args: unknown[]) => format(template, ...args));
  env.addFilter('tojson', (value: unknown) => tojson(value));
  env.addFilter('min', (...values: unknown[]) => minFilter(...values));
  env.addFilter('max', (...values: unknown[]) => maxFilter(...values));
}

function registerGlobals(env: nunjucks.Environment, appVersion: string): void {
  env.addGlobal('url_for', (name: string, params?: UrlParams & { __keywords?: boolean }) => {
    let resolved: UrlParams = params ?? {};
    if (resolved && resolved.__keywords) {
      const { __keywords: _keywords, ...rest } = resolved;
      void _keywords;
      resolved = rest;
    }
    return urlFor(name, resolved);
  });
  env.addGlobal('asset_url', (filename: string) => assetUrl(filename, appVersion));
  env.addGlobal('csrf_token', () => renderStore.getStore()?.csrfToken() ?? '');
}

/**
 * Builds (and configures) the Nunjucks environment used to render the reused
 * Jinja templates.
 */
export function configureNunjucks(opts: TemplatingOptions = {}): nunjucks.Environment {
  const templatesDir = opts.templatesDir ?? defaultTemplatesDir();
  const appVersion = opts.appVersion ?? '0.0.0';
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(templatesDir), {
    autoescape: opts.autoescape ?? true,
    throwOnUndefined: false,
  });
  registerFilters(env);
  registerGlobals(env, appVersion);
  installMemberGetShim();
  return env;
}

// ---------------------------------------------------------------------------
// renderPage
// ---------------------------------------------------------------------------

/** Structural view of the pieces of `res.req`/`app.locals` we rely on. */
interface RenderRequest {
  query?: Record<string, unknown>;
  path?: string;
  originalUrl?: string;
  method?: string;
  app?: {
    locals?: {
      session?: {
        getSession(req: unknown): Record<string, unknown> | null;
        getCsrfToken(req: unknown, res: unknown): string;
      };
      webSettings?: { mode?: string };
    };
  };
}

function sessionView(data: Record<string, unknown> | null): Record<string, unknown> {
  const view: Record<string, unknown> = { ...(data ?? {}) };
  view.get = (key: string, fallback?: unknown): unknown => {
    if (data && Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined) {
      return data[key];
    }
    return fallback === undefined ? '' : fallback;
  };
  return view;
}

function makeArgs(query: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = { ...query };
  args.get = (key: string, fallback?: unknown): unknown => {
    if (Object.prototype.hasOwnProperty.call(query, key) && query[key] !== undefined) {
      return query[key];
    }
    return fallback === undefined ? '' : fallback;
  };
  return args;
}

/** A templating bundle: the environment plus request-aware render helpers. */
export interface Templating {
  env: nunjucks.Environment;
  /** Render a template to a string (no request context). */
  render(template: string, ctx?: Record<string, unknown>): string;
  /** Render a template and write a 200 text/html response. */
  renderPage(res: Response, template: string, ctx?: Record<string, unknown>): void;
}

/** Creates a templating bundle (environment + `render`/`renderPage`). */
export function createTemplating(opts: TemplatingOptions = {}): Templating {
  const env = configureNunjucks(opts);
  const appVersion = opts.appVersion ?? '0.0.0';

  function render(template: string, ctx: Record<string, unknown> = {}): string {
    return renderStore.run({ csrfToken: () => '' }, () => env.render(template, ctx));
  }

  function renderPage(res: Response, template: string, ctx: Record<string, unknown> = {}): void {
    const req = (res.req ?? undefined) as RenderRequest | undefined;
    const locals = req?.app?.locals;
    const manager = locals?.session;
    const sessionData: Record<string, unknown> | null = manager && req ? manager.getSession(req) : null;
    let cachedCsrf: string | undefined;
    const csrfToken = (): string => {
      if (cachedCsrf === undefined) {
        cachedCsrf = manager && req ? manager.getCsrfToken(req, res) ?? '' : '';
      }
      return cachedCsrf;
    };

    const query = (req?.query ?? {}) as Record<string, unknown>;
    const request = {
      query,
      args: makeArgs(query),
      path: req?.path ?? '',
      url: req?.originalUrl ?? '',
      method: req?.method ?? 'GET',
    };
    const viewMode = locals?.webSettings?.mode === 'user' ? 'user' : 'admin';

    const context: Record<string, unknown> = {
      request,
      session: sessionView(sessionData),
      app_version: appVersion,
      view_mode: viewMode,
      ...ctx,
    };

    const html = renderStore.run({ csrfToken }, () => env.render(template, context));
    res.status(200).type('html').send(html);
  }

  return { env, render, renderPage };
}
