/**
 * Measures MCP response sizes for the same scenario on TG Browser MCP and Microsoft Playwright MCP.
 * Usage: npx tsx scripts/benchmark-tokens.ts   (requires `npm run build` and @playwright/mcp devDependency)
 *
 * Token counts are estimated as ceil(chars / 4). This is a rough, tokenizer-independent proxy; the
 * raw character counts are reported too so results can be re-evaluated with a real tokenizer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFixtureServer } from '../tests/fixtures/app/server.mjs';

type R = { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean };
const textOf = (r: R) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
const tok = (n: number) => Math.ceil(n / 4);

interface Step {
  label: string;
  chars: number;
}

async function connect(command: string, args: string[]): Promise<Client> {
  const client = new Client({ name: 'bench', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command,
      args,
      env: {
        ...process.env,
        TG_BROWSER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-bench-')),
        TG_LOG_LEVEL: 'silent',
      } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
  return client;
}

const ref = (text: string, re: RegExp): string => {
  const m = re.exec(text);
  if (!m) throw new Error(`ref not found for ${re}\n${text.slice(0, 2000)}`);
  return m[1]!;
};

async function runScenario(
  name: 'tg' | 'pw',
  client: Client,
  base: string,
): Promise<{ steps: Step[]; schemaChars: number; toolCount: number }> {
  const { tools } = await client.listTools();
  const schemaChars = JSON.stringify(tools).length;
  const steps: Step[] = [];
  const call = async (label: string, tool: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name: tool, arguments: args })) as R;
    const t = textOf(r);
    if (r.isError) throw new Error(`${name} ${label} failed: ${t}`);
    steps.push({ label, chars: t.length });
    return t;
  };
  // 1. Open login page
  let t = await call('navigate /login', 'browser_navigate', { url: `${base}/login` });
  if (name === 'pw') t = t.includes('[ref=') ? t : await call('snapshot', 'browser_snapshot', {});
  const user = ref(t, /textbox "Username"[^\n]*\[ref=((?:f\d+)?e\d+)\]/);
  const pw = ref(t, /textbox "Password"[^\n]*\[ref=((?:f\d+)?e\d+)\]/);
  const signIn = ref(t, /button "Sign in"[^\n]*\[ref=((?:f\d+)?e\d+)\]/);
  // 2. Fill credentials + sign in
  if (name === 'tg') {
    await call('fill username', 'browser_fill', { ref: user, value: 'maker' });
    await call('fill password', 'browser_fill', { ref: pw, value: 'maker123' });
    t = await call('click sign in', 'browser_click', { ref: signIn });
  } else {
    await call('fill username', 'browser_type', { element: 'Username', target: user, text: 'maker' });
    await call('fill password', 'browser_type', { element: 'Password', target: pw, text: 'maker123' });
    t = await call('click sign in', 'browser_click', { element: 'Sign in', target: signIn });
  }
  if (!t.includes('Customer Name')) t = await call('snapshot', 'browser_snapshot', {});
  const customer = ref(t, /textbox "Customer Name"[^\n]*\[ref=((?:f\d+)?e\d+)\]/);
  const type = ref(t, /combobox "Request Type"[^\n]*\[ref=((?:f\d+)?e\d+)\]/);
  const submit = ref(t, /button "Submit"[^\n]*\[ref=((?:f\d+)?e\d+)\]/);
  // 3. Fill form + submit
  if (name === 'tg') {
    await call('fill customer', 'browser_fill', { ref: customer, value: 'ACME' });
    await call('select type', 'browser_select_option', { ref: type, values: ['Loan'] });
    await call('click submit', 'browser_click', { ref: submit });
  } else {
    await call('fill customer', 'browser_type', { element: 'Customer Name', target: customer, text: 'ACME' });
    await call('select type', 'browser_select_option', {
      element: 'Request Type',
      target: type,
      values: ['Loan'],
    });
    await call('click submit', 'browser_click', { element: 'Submit', target: submit });
  }
  // 4. Dynamic page: two increments
  t = await call('navigate /dynamic', 'browser_navigate', { url: `${base}/dynamic` });
  if (!t.includes('[ref=')) t = await call('snapshot', 'browser_snapshot', {});
  const inc = ref(t, /button "Increment"[^\n]*\[ref=((?:f\d+)?e\d+)\]/);
  for (let i = 0; i < 2; i++)
    await call(
      `click increment ${i + 1}`,
      'browser_click',
      name === 'tg' ? { ref: inc } : { element: 'Increment', target: inc },
    );
  // 5. Large page snapshot
  await call('navigate /large', 'browser_navigate', { url: `${base}/large` });
  await call('snapshot /large', 'browser_snapshot', {});
  return { steps, schemaChars, toolCount: tools.length };
}

async function main() {
  const app = createFixtureServer();
  const base = await app.listen();
  const results: Record<string, Awaited<ReturnType<typeof runScenario>>> = {};
  const servers: Array<['tg' | 'pw', string, string[]]> = [
    ['tg', process.execPath, [path.resolve('dist/index.js'), '--headless', '--profile', 'developer']],
    [
      'pw',
      process.execPath,
      [
        path.resolve('node_modules/@playwright/mcp/cli.js'),
        '--headless',
        '--isolated',
        '--browser',
        'chrome',
      ],
    ],
  ];
  for (const [name, cmd, args] of servers) {
    const c = await connect(cmd, args);
    try {
      results[name] = await runScenario(name, c, base);
    } finally {
      await c.close();
    }
  }
  await app.close();

  const tg = results.tg!;
  const pw = results.pw!;
  const sum = (s: Step[]) => s.reduce((a, b) => a + b.chars, 0);
  const lines: string[] = [];
  lines.push(`| Step | TG Browser chars | Playwright MCP chars |`, `|---|---:|---:|`);
  const labels = [...new Set([...tg.steps.map((s) => s.label), ...pw.steps.map((s) => s.label)])];
  for (const l of labels) {
    const a = tg.steps.filter((s) => s.label === l).reduce((x, y) => x + y.chars, 0);
    const b = pw.steps.filter((s) => s.label === l).reduce((x, y) => x + y.chars, 0);
    lines.push(`| ${l} | ${a || '—'} | ${b || '—'} |`);
  }
  lines.push(
    `| **Total responses** | **${sum(tg.steps)}** (~${tok(sum(tg.steps))} tok) | **${sum(pw.steps)}** (~${tok(sum(pw.steps))} tok) |`,
  );
  lines.push(`| Tool calls | ${tg.steps.length} | ${pw.steps.length} |`);
  lines.push(`| Tools advertised | ${tg.toolCount} | ${pw.toolCount} |`);
  lines.push(
    `| Tool schema (tools/list JSON) | ${tg.schemaChars} (~${tok(tg.schemaChars)} tok) | ${pw.schemaChars} (~${tok(pw.schemaChars)} tok) |`,
  );
  console.log(lines.join('\n'));
  console.log(`\nResponse size ratio TG/PW: ${(sum(tg.steps) / sum(pw.steps)).toFixed(2)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
