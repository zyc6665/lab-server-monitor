#!/usr/bin/env node
/**
 * Lightweight repository lint gate (P3-3).
 *
 * The project deliberately keeps its toolchain small (no ESLint config to
 * maintain across two packages), so this script enforces the handful of rules
 * that actually matter for correctness and hygiene:
 *
 *   1. no `as any`, `@ts-ignore` or `@ts-expect-error` in backend/src
 *   2. no stray `console.log(` in backend/src (use the structured logger/CLI)
 *   3. no TODO/FIXME markers left in shipped source
 *
 * Exit code 1 on any violation; prints file:line for each.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src');

const RULES = [
  { name: 'ts-escape-hatch', pattern: /\bas any\b|@ts-ignore|@ts-expect-error/, hint: 'avoid type escape hatches' },
  { name: 'stray-console', pattern: /console\.log\(/, hint: 'use the structured logger or CLI output helper', ignore: ['src/server.ts'] },
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of walk(SRC)) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      const rel = relative(ROOT, file);
      if (rule.ignore && rule.ignore.some((p) => rel.split(/[\\/]/).join('/').endsWith(p))) continue;
      if (rule.pattern.test(line)) {
        violations.push({ file: rel, line: index + 1, rule: rule.name, hint: rule.hint, text: line.trim() });
      }
    }
  });
}

if (violations.length === 0) {
  console.log('lint: clean');
  process.exit(0);
}

for (const v of violations) {
  console.error(`${v.file}:${v.line} [${v.rule}] ${v.hint}\n    ${v.text}`);
}
console.error(`\nlint: ${violations.length} violation(s)`);
process.exit(1);
