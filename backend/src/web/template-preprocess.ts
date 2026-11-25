/**
 * Jinja → Nunjucks source preprocessor.
 *
 * The reused Jinja2 templates under `servermanage/web/templates` contain a few
 * constructs Nunjucks cannot parse or would evaluate with different semantics.
 * Because those `.html` files are read-only (the Python app still renders them),
 * the incompatibilities are repaired here, at load time, by rewriting the
 * template **source** into Nunjucks-compilable source. The public entry point is
 * the pure function {@link preprocessTemplate}.
 *
 * Supported rewriters (deliberately narrow — they only touch the exact Jinja
 * idioms the templates actually use, so ordinary `//` or `[index]` is untouched):
 *
 *  1. `{% set NAME = namespace(a=1, b=None) %}` →
 *        `{% set NAME = __ns({a: 1, b: null}) %}`
 *     `__ns` is a global that returns a plain mutable object. Python literals
 *     `None` / `True` / `False` are mapped to `null` / `true` / `false` (only
 *     inside the namespace argument list).
 *
 *  2. `{% set NAME.attr = EXPR %}` → `{{ __setattr(NAME, "attr", EXPR) }}`
 *     `__setattr` mutates the object in place and returns the empty string, so
 *     it renders nothing while letting later `NAME.attr` reads see the value.
 *     `EXPR` may contain parentheses / quotes / nested arithmetic.
 *
 *  3. `EXPR[:N]` (Python slice) → `EXPR|head(N)` — only a trailing `[:<digits>]`
 *     is rewritten; other `:` (e.g. dict literals, `[a:b]` slices, ternaries)
 *     are left alone. `head` is a filter that yields the first N array items.
 *
 *  4. `A * B // C` → `((A * B) / C)|floor`.
 *     Nunjucks binds `//` tighter than `*` (so `36 * 100 // 40` evaluates to
 *     `36 * (100 // 40) = 72`), whereas Jinja/Python have equal precedence and
 *     evaluate left-to-right (`(36 * 100) // 40 = 90`). Only `` * `` … `//`
 *     sequences are rewritten; a *pure* `//` (e.g. `x // 60`) already behaves
 *     correctly and is left untouched. As a safety valve, a `* … //` sequence
 *     that is itself part of a longer operator chain (preceded by `* / + - .`
 *     or an identifier character) is left unchanged rather than risk a wrong
 *     rewrite — a documented limitation, and no template hits it.
 */

/** `{% set NAME = namespace(...) %}`. */
const NAMESPACE_RE = /\{%\s*set\s+([A-Za-z_]\w*)\s*=\s*namespace\s*\(([^)]*)\)\s*%\}/g;

/** `{% set NAME.attr = EXPR %}` (EXPR stops at the closing `%`). */
const SET_ATTR_RE = /\{%\s*set\s+([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=\s*([^%]*?)\s*%\}/g;

/** Trailing Python slice `EXPR[:N]` (N digits only). */
const SLICE_RE = /([A-Za-z_][\w.]*)\[:(\d+)\]/g;

/** A "simple" operand: a shallow parenthesised group, a dotted path, or a number. */
const FLOORDIV_ATOM = String.raw`\([^()]*\)|[A-Za-z_][\w.]*|\d+(?:\.\d+)?`;

/** `A * B // C` with simple operands. */
const FLOORDIV_RE = new RegExp(
  `(${FLOORDIV_ATOM})\\s*\\*\\s*(${FLOORDIV_ATOM})\\s*\\/\\/\\s*(${FLOORDIV_ATOM})`,
  'g',
);

/**
 * Splits `input` on `sep` at the top level only — commas inside quotes, ( ), [ ]
 * or { } are ignored. Used to parse a namespace argument list.
 */
function splitTopLevel(input: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      current += char;
      if (char === quote && input[i - 1] !== '\\') {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
    }
    if (char === sep && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Maps Python scalar literals used by Jinja to their JS/Nunjucks spelling. */
function toJsLiterals(expr: string): string {
  return expr
    .replace(/\bNone\b/g, 'null')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false');
}

/** `root_disk=None, gpu=None` → `{root_disk: null, gpu: null}`. */
function convertNamespaceArgs(args: string): string {
  const trimmed = args.trim();
  if (!trimmed) {
    return '{}';
  }
  const pairs = splitTopLevel(trimmed, ',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const match = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(part);
      if (!match) {
        // Not a `key=value` entry; leave as-is (should not happen in the
        // templates, but keeps the function total).
        return part;
      }
      return `${match[1]}: ${toJsLiterals(match[2].trim())}`;
    });
  return `{${pairs.join(', ')}}`;
}

/** `{% set ns.attr = EXPR %}` → `{{ __setattr(ns, "attr", EXPR) }}`. */
function rewriteSetAttr(src: string): string {
  return src.replace(SET_ATTR_RE, (_match, obj: string, attr: string, expr: string) => {
    return `{{ __setattr(${obj}, "${attr}", ${expr.trim()}) }}`;
  });
}

/** `{% set NAME = namespace(...) %}` → `{% set NAME = __ns({...}) %}`. */
function rewriteNamespace(src: string): string {
  return src.replace(NAMESPACE_RE, (_match, name: string, args: string) => {
    return `{% set ${name} = __ns(${convertNamespaceArgs(args)}) %}`;
  });
}

/** `EXPR[:N]` → `EXPR|head(N)`. */
function rewriteSlices(src: string): string {
  return src.replace(SLICE_RE, (_match, expr: string, count: string) => {
    return `${expr}|head(${count})`;
  });
}

/** `A * B // C` → `((A * B) / C)|floor`, leaving ambiguous chains untouched. */
function rewriteFloorDiv(src: string): string {
  return src.replace(
    FLOORDIV_RE,
    (match, left: string, right: string, divisor: string, offset: number) => {
      const before = src.slice(0, offset).replace(/\s+$/, '');
      const prev = before.slice(-1);
      // If the `* … //` sequence continues another operator chain, skip it:
      // rewriting only a sub-expression would change the meaning. Keeps the
      // rewriter conservative.
      if (prev && /[*/+\-.%\w]/.test(prev)) {
        return match;
      }
      return `(((${left} * ${right}) / ${divisor})|floor)`;
    },
  );
}

/**
 * Rewrites Jinja-specific syntax in `src` into Nunjucks-compilable source.
 * Pure and idempotent-safe for the template set in this repository.
 */
export function preprocessTemplate(src: string): string {
  let out = src;
  out = rewriteSetAttr(out);
  out = rewriteNamespace(out);
  out = rewriteSlices(out);
  out = rewriteFloorDiv(out);
  return out;
}
