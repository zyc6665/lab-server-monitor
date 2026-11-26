#!/usr/bin/env node
/** Generate docs/API.md from the endpoint registry (P3-2). */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(BACKEND);
const registry = readFileSync(join(BACKEND, 'src', 'web', 'routes', 'registry.ts'), 'utf8');

const entries = [];
const re = /^\s{2}([A-Za-z0-9_]+):\s*'([^']+)',?\s*$/gm;
let match;
while ((match = re.exec(registry)) !== null) {
  entries.push({ name: match[1], path: match[2] });
}

const pages = entries.filter((e) => !e.path.startsWith('/api/'));
const api = entries.filter((e) => e.path.startsWith('/api/'));

function table(rows) {
  return [
    '| 名称 | 路径 |',
    '| --- | --- |',
    ...rows.map((r) => `| \`${r.name}\` | \`${r.path}\` |`),
  ].join('\n');
}

const doc = `# HTTP API 文档

> 自动生成，请勿手工编辑。运行 \`pnpm --filter servermonitor-backend run api:doc\` 重新生成。
> 端点注册表来源：\`backend/src/web/routes/registry.ts\`。

- API 端点：${api.length} 个
- 页面路由：${pages.length} 个
- 运行时可通过 \`GET /api/system/endpoints\` 获取 JSON 版本。

## API 端点

${table(api)}

## 页面路由

${table(pages)}
`;

const out = join(ROOT, 'docs', 'API.md');
writeFileSync(out, doc, 'utf8');
console.log(`wrote ${out} (${api.length} api, ${pages.length} pages)`);
