/** Generates docs/TOOLS.md from the tool registry: npx tsx scripts/gen-tool-docs.ts */
import fs from 'node:fs';
import { z } from 'zod';
import { ALL_TOOLS } from '../src/tools/index.js';

const order = ['minimal', 'developer', 'testing', 'full'];
const out: string[] = [
  '# MCP tool reference',
  '',
  '> Generated from `src/tools/*` by `scripts/gen-tool-docs.ts`. Do not edit by hand.',
  '',
  'Profiles are cumulative: `minimal` ⊂ `developer` ⊂ `testing` ⊂ `full`. Only tools of the active profile (plus `tools.enabled`, minus `tools.disabled`) are advertised.',
  '',
  '## Element targets',
  '',
  'Page tools accept a target: `ref` (from `browser_snapshot`, preferred) **or** a semantic locator, in priority order `role`+`name` → `label` → `testId` → `placeholder` → `text` → `selector` (CSS). `exact` controls name/text matching, `nth` picks among multiple matches. XPath is rejected.',
  '',
  'Common optional parameters: `session` (default active session), `pageId` (default active tab), `snapshot` = `diff` (default) | `full` | `none`.',
  '',
  '## Output contract',
  '',
  '- Success: first line `✓ <message> · <ms>ms · session=<name> page=<id>`, then the page diff (`Added/Changed/Removed`) or a full snapshot after navigation, warnings (`⚠`), new tabs, and errors observed during the action.',
  '- Failure: `isError: true` and `✗ <ERROR_CODE>: <message>`, `Retry safe: yes|no`, `Suggestion: …`, `Context: {…}`. No stack traces or credentials.',
  '- `output.verbose=true` returns the normalized JSON `ActionResult` instead of text.',
  '- Screenshots are MCP `image` content and/or files (`output.screenshots`).',
  '',
  '| Tool | Profile | Risk | Read-only | Timeout |',
  '|---|---|---|---|---|',
];
const sorted = [...ALL_TOOLS].sort(
  (a, b) => order.indexOf(a.profile) - order.indexOf(b.profile) || a.category.localeCompare(b.category),
);
for (const t of sorted)
  out.push(
    `| [\`${t.name}\`](#${t.name}) | ${t.profile} | ${t.risk} | ${t.readOnly ? 'yes' : 'no'} | ${t.timeoutMs / 1000}s |`,
  );
out.push('');
for (const t of sorted) {
  out.push(
    `### ${t.name}`,
    '',
    `${t.description}`,
    '',
    `Category: ${t.category} · Profile: ${t.profile} · Risk: ${t.risk}`,
    '',
  );
  const schema = z.toJSONSchema(z.object(t.input)) as {
    properties?: Record<string, { type?: unknown; description?: string; enum?: unknown[] }>;
    required?: string[];
  };
  const props = Object.entries(schema.properties ?? {});
  if (props.length) {
    out.push('| Param | Type | Required | Notes |', '|---|---|---|---|');
    for (const [k, v] of props)
      out.push(
        `| \`${k}\` | ${v.enum ? v.enum.map((e) => `\`${String(e)}\``).join(' \\| ') : JSON.stringify(v.type ?? 'object').replace(/"/g, '')} | ${schema.required?.includes(k) ? 'yes' : ''} | ${v.description ?? ''} |`,
      );
    out.push('');
  }
}
fs.writeFileSync('docs/TOOLS.md', `${out.join('\n')}\n`);
console.log(`docs/TOOLS.md: ${ALL_TOOLS.length} tools`);
