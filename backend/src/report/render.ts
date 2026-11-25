/**
 * 1:1 port of the Jinja2 rendering layer in `servermanage/report.py`
 * (`_build_environment`, `render_report`).
 *
 * The report templates live in `servermanage/templates` and are reused
 * read-only.  Nunjucks is configured to match Jinja2 as closely as possible:
 *
 * - an independent {@link nunjucks.Environment} (nothing shared with the web
 *   templating layer),
 * - `autoescape` enabled for every template (Python's
 *   `select_autoescape(enabled_extensions=("html", "xml", "j2"))` returns
 *   `True` for *all six* report templates — including the `.txt.j2` ones —
 *   because the file name ends with `.j2`),
 * - `trimBlocks` / `lstripBlocks` enabled, mirroring Jinja2,
 * - a custom loader that normalises CRLF -> LF and drops exactly one trailing
 *   newline, mirroring Jinja2's source reading (`keep_trailing_newline=False`)
 *   and universal-newline handling.
 *
 * Because Nunjucks renders empty arrays/objects as truthy while Jinja2 does
 * not, arrays are mapped to `undefined` before rendering (see
 * {@link prepareTemplateData}).  Raw floats printed directly by the templates
 * (`load_average.*`, process `cpu_percent` / `mem_percent`) are rendered with
 * {@link pythonFloatRepr} so they match CPython's `str(float)`.
 */

import * as fs from 'fs';
import * as path from 'path';

import * as nunjucks from 'nunjucks';

import { buildContext, buildExecutiveContext, buildWeeklyContext } from './context';
import type { DailyReport, RenderedReport, WeeklyReport } from './model';
import { toSnakeCaseDeep } from './model';
import { pythonFloatRepr } from './svg';

/** The three report flavours understood by the Python oracle. */
export type ReportVariant = 'technical' | 'executive' | 'weekly';

/** Options for {@link renderReport}. */
export interface RenderReportOptions {
  /**
   * Override the directory that holds the report templates.  Defaults to
   * {@link defaultReportTemplatesDir} (`servermanage/templates`).
   */
  templatesDir?: string;
}

// ---------------------------------------------------------------------------
// Python-compatible numeric helpers (copied from backend/src/web/templating.ts)
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

/**
 * `format` — the printf subset the report templates use (`%s %d %i %f %.Nf
 * %x %X %o`, plus width / zero padding / `%%`).  Kept byte-compatible with
 * the web templating filter of the same name.
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

// ---------------------------------------------------------------------------
// Loader / environment
// ---------------------------------------------------------------------------

/** Raw keys whose values are printed as CPython `str(float)`. */
const RAW_FLOAT_KEYS = new Set([
  'load_1',
  'load_5',
  'load_15',
  'cpu_percent',
  'mem_percent',
  'utilization_percent',
]);

/**
 * Jinja-compatible `selectattr`.  Nunjucks 3.x's built-in `selectattr` ignores
 * its test argument and keeps only truthy attributes
 * (`arr.filter(item => !!item[attr])`), which differs from Jinja2 for the
 * weekly template's `selectattr("gpu_util", "defined")` (a `null` value is
 * *defined* in Jinja2 but falsy in JS).  Re-implementing it here keeps the GPU
 * chart condition identical to the Python oracle.
 */
export function selectAttr(
  values: unknown,
  attr: string,
  test?: string,
  ...testArgs: unknown[]
): unknown[] {
  const list = Array.isArray(values) ? values : [];
  return list.filter((item) => {
    if (item === null || item === undefined) {
      return false;
    }
    const value = (item as Record<string, unknown>)[attr];
    if (test === undefined) {
      return Boolean(value);
    }
    switch (test) {
      case 'defined':
        return value !== undefined;
      case 'undefined':
        return value === undefined;
      case 'none':
        return value === null || value === undefined;
      case 'equalto':
        return value === testArgs[0];
      case 'ne':
        return value !== testArgs[0];
      default:
        return Boolean(value);
    }
  });
}

/**
 * Filesystem loader that reproduces Jinja2's source normalisation:
 * CRLF/CR -> LF, and strip exactly one trailing newline (Jinja2 defaults to
 * `keep_trailing_newline=False`).
 */
class ReportTemplateLoader extends nunjucks.Loader {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    super();
    this.baseDir = path.resolve(baseDir);
  }

  getSource(name: string): nunjucks.LoaderSource {
    const fullPath = path.resolve(this.baseDir, name);
    const relative = path.relative(this.baseDir, fullPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Template path escapes report templates directory: ${name}`);
    }
    let source = fs.readFileSync(fullPath, 'utf8');
    source = source.replace(/\r\n?/g, '\n');
    if (source.endsWith('\n')) {
      source = source.slice(0, -1);
    }
    source = preprocessTemplate(source);
    return { src: source, path: fullPath, noCache: true };
  }
}

const environmentCache = new Map<string, nunjucks.Environment>();

/** Build (and memoise) the independent report-rendering environment. */
function getEnvironment(templatesDir: string): nunjucks.Environment {
  const resolved = path.resolve(templatesDir);
  const cached = environmentCache.get(resolved);
  if (cached) {
    return cached;
  }
  const environment = new nunjucks.Environment(new ReportTemplateLoader(resolved), {
    autoescape: true,
    trimBlocks: true,
    lstripBlocks: true,
    throwOnUndefined: false,
  });
  environment.addFilter('format', (template: unknown, ...args: unknown[]) => format(template, ...args));
  environment.addFilter('selectattr', (values: unknown, attr: string, test?: string, ...testArgs: unknown[]) =>
    selectAttr(values, attr, test, ...testArgs),
  );
  environmentCache.set(resolved, environment);
  return environment;
}

function* upwardDirectories(start: string): Generator<string> {
  let current = path.resolve(start);
  for (let depth = 0; depth < 12; depth += 1) {
    yield current;
    const parent = path.dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

/**
 * Resolve `servermanage/templates` from the repository root.
 *
 * Both the test runner (`backend/`, cwd may be the repo root or the backend
 * package) and the packaged application (templates copied next to the bundle)
 * need to find the same directory, so we walk upwards from the cwd and from
 * the module directory looking for `servermanage/templates/report.txt.j2`.
 * `SERVERMANAGE_REPORT_TEMPLATES` can override the result explicitly.
 */
export function defaultReportTemplatesDir(): string {
  const override = process.env.SERVERMANAGE_REPORT_TEMPLATES;
  if (override && override.trim() !== '') {
    return path.resolve(override);
  }
  const starts: string[] = [process.cwd()];
  if (typeof __dirname === 'string') {
    starts.push(__dirname);
  }
  for (const start of starts) {
    for (const directory of upwardDirectories(start)) {
      const candidate = path.join(directory, 'servermanage', 'templates');
      if (fs.existsSync(path.join(candidate, 'report.txt.j2'))) {
        return candidate;
      }
    }
  }
  const moduleDir = typeof __dirname === 'string' ? __dirname : process.cwd();
  return path.resolve(moduleDir, '../../../servermanage/templates');
}

// ---------------------------------------------------------------------------
// Context preparation
// ---------------------------------------------------------------------------

/**
 * Prepare a snake_case context for Nunjucks, recursively copying the objects
 * (so the caller's context is not mutated) and, when `stringifyFloats` is set,
 * rendering the raw floats printed directly by the templates exactly like
 * CPython's `str(float)`.
 *
 * Nunjucks and Jinja2 differ on empty containers: Nunjucks treats `[]` as
 * truthy, Jinja2 as falsy.  Rather than rewriting empty arrays to `undefined`
 * (which breaks Nunjucks' `{% for %}...{% else %}` else-branch across repeated
 * loop executions), the templates' only array-`{% if %}` guards
 * (`failed_hosts`, `host.failed_checks`, `busy_hosts`, `idle_hosts`) get an
 * explicit `and <expr>|length` appended by {@link preprocessTemplate}.  Empty
 * arrays are therefore left as `[]`, which both iterates as "empty" and takes
 * the `{% else %}` branch exactly like Jinja2.
 */
function prepareTemplateData(value: unknown, stringifyFloats: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => prepareTemplateData(item, stringifyFloats));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (stringifyFloats && typeof child === 'number' && RAW_FLOAT_KEYS.has(key)) {
        result[key] = pythonFloatRepr(child);
      } else {
        result[key] = prepareTemplateData(child, stringifyFloats);
      }
    }
    return result;
  }
  return value;
}

/**
 * Rewrite the handful of `{% if <array> %}` guards so they use `and
 * <array>|length`, matching Jinja2's "empty list is falsy" semantics under
 * Nunjucks (where `[]` is truthy).  Everything else is left byte-identical.
 */
const ARRAY_IF_GUARDS = ['failed_hosts', 'host.failed_checks', 'busy_hosts', 'idle_hosts'];

function preprocessTemplate(source: string): string {
  let result = source;
  for (const expression of ARRAY_IF_GUARDS) {
    const from = `{% if ${expression} %}`;
    const to = `{% if ${expression} and ${expression}|length %}`;
    result = result.split(from).join(to);
  }
  return result;
}

/**
 * Nunjucks escapes `"` as `&quot;` whereas Jinja2/MarkupSafe escapes it as
 * `&#34;`; normalise the difference so HTML output is byte-identical to the
 * oracle.  `safe` content is emitted verbatim and therefore never contains
 * `&quot;` from escaping.
 */
function normaliseEscapedQuotes(output: string): string {
  return output.replace(/&quot;/g, '&#34;');
}

function renderTemplate(
  environment: nunjucks.Environment,
  templateName: string,
  context: Record<string, unknown>,
): string {
  const rendered = environment.getTemplate(templateName, true).render(context);
  return normaliseEscapedQuotes(rendered);
}

function extractSubject(context: Record<string, unknown>): string {
  const subject = context.subject;
  return subject === undefined || subject === null ? '' : String(subject);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a {@link DailyReport} or {@link WeeklyReport} into subject/text/HTML
 * bodies, mirroring `servermanage.report.render_report`.
 *
 * @param report  the report model (camelCase, see `./model`)
 * @param variant `technical` (default), `executive`, or `weekly`
 * @param options optional template-directory override
 */
export function renderReport(
  report: DailyReport | WeeklyReport,
  variant: ReportVariant = 'technical',
  options: RenderReportOptions = {},
): RenderedReport {
  const templatesDir = options.templatesDir ?? defaultReportTemplatesDir();
  const environment = getEnvironment(templatesDir);

  if (variant === 'executive') {
    const context = prepareTemplateData(
      toSnakeCaseDeep(buildExecutiveContext(report as DailyReport)),
      false,
    ) as Record<string, unknown>;
    return {
      subject: extractSubject(context),
      textBody: renderTemplate(environment, 'report_executive.txt.j2', context),
      htmlBody: renderTemplate(environment, 'report_executive.html.j2', context),
    };
  }

  if (variant === 'weekly') {
    const context = prepareTemplateData(
      toSnakeCaseDeep(buildWeeklyContext(report as WeeklyReport)),
      false,
    ) as Record<string, unknown>;
    return {
      subject: extractSubject(context),
      textBody: renderTemplate(environment, 'report_weekly.txt.j2', context),
      htmlBody: renderTemplate(environment, 'report_weekly.html.j2', context),
    };
  }

  const context = prepareTemplateData(
    toSnakeCaseDeep(buildContext(report as DailyReport)),
    true,
  ) as Record<string, unknown>;
  return {
    subject: extractSubject(context),
    textBody: renderTemplate(environment, 'report.txt.j2', context),
    htmlBody: renderTemplate(environment, 'report.html.j2', context),
  };
}
