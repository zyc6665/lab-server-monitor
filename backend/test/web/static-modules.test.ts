import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const staticRoot = path.resolve(__dirname, '../../assets/web/static');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'vendor') { continue; }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, out); } else if (entry.name.endsWith('.js')) { out.push(full); }
  }
  return out;
}

const files = walk(staticRoot);
const sources = new Map<string, string>(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const isModule = (src: string) => /^\s*(?:import|export)\b/m.test(src);

// Map exported function/const name -> defining file (only real ES modules).
const exportedFrom = new Map<string, string>();
for (const [file, src] of sources) {
  if (!isModule(src)) { continue; }
  const re = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) { exportedFrom.set(m[1] || m[2], file); }
}

// Names imported by a module file (all import forms).
function importedNames(src: string): Set<string> {
  const names = new Set<string>();
  const re = /import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1]) { names.add(m[1]); }
    if (m[2]) {
      for (const part of m[2].split(',')) {
        const bits = part.trim().split(/\s+as\s+/);
        if (bits[0]) { names.add(bits[bits.length - 1].trim()); }
      }
    }
  }
  return names;
}

// Names declared locally (function/var/let/const).
function declaredNames(src: string): Set<string> {
  const names = new Set<string>();
  const re = /(?:function|var|let|const)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) { names.add(m[1]); }
  return names;
}

describe('static ES modules integrity', () => {
  it('every cross-module exported helper that is called is imported (module files only)', () => {
    const problems: string[] = [];
    for (const [file, src] of sources) {
      if (!isModule(src)) { continue; } // classic scripts have their own scope
      const available = new Set([...importedNames(src), ...declaredNames(src)]);
      for (const [name, owner] of exportedFrom) {
        if (owner === file) { continue; }
        const used = new RegExp('(^|[^\\w$.])' + name.replace(/\$/g, '\\$') + '\\s*\\(').test(src);
        if (used && !available.has(name)) {
          problems.push(`${path.relative(staticRoot, file)} uses ${name}() from ${path.relative(staticRoot, owner)} without importing it`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('every createElementNS() namespace argument is a declared identifier or literal', () => {
    const problems: string[] = [];
    for (const [file, src] of sources) {
      const re = /createElementNS\(\s*([A-Za-z_$][\w$]*)\s*,/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const id = m[1];
        if (declaredNames(src).has(id) || importedNames(src).has(id)) { continue; }
        problems.push(`${path.relative(staticRoot, file)} calls createElementNS(${id}) but ${id} is not declared or imported`);
      }
    }
    expect(problems).toEqual([]);
  });
});
