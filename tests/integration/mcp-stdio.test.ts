import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFixtureServer } from '../fixtures/app/server.mjs';
import { tmpDir } from '../helpers.js';

const ENTRY = path.resolve('dist/index.js');
let app: ReturnType<typeof createFixtureServer>;
let base: string;
let client: Client;
let stderr = '';

type TextResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
};
const call = async (name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as TextResult;
const textOf = (r: TextResult) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

beforeAll(async () => {
  app = createFixtureServer();
  base = await app.listen();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY, '--transport', 'stdio', '--headless', '--profile', 'testing', '--log-level', 'info'],
    env: { ...process.env, TG_BROWSER_DATA_DIR: tmpDir() } as Record<string, string>,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  client = new Client({ name: 'tg-test-client', version: '1.0.0' });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await app?.close();
});

describe('MCP server over STDIO (spawned process, real client)', () => {
  it('initializes and advertises server info and instructions', () => {
    expect(client.getServerVersion()?.name).toBe('tg-browser-mcp');
    expect(client.getInstructions()).toContain('untrusted');
  });

  it('discovers only the tools of the selected profile', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('browser_navigate');
    expect(names).toContain('workflow_execute');
    expect(names).not.toContain('browser_connect'); // full-profile only
    expect(names).not.toContain('browser_upload_file');
    const nav = tools.find((t) => t.name === 'browser_navigate')!;
    expect(nav.inputSchema.properties).toHaveProperty('url');
    expect(nav.annotations?.readOnlyHint).toBe(false);
  });

  it('runs navigate → snapshot → fill/click by ref → diff', async () => {
    let r = await call('browser_navigate', { url: `${base}/login` });
    expect(r.isError).toBeFalsy();
    let t = textOf(r);
    expect(t).toMatch(/^• Navigated to/);
    expect(t).not.toContain('New tabs opened');
    const user = /textbox "Username" \[required\] \[ref=(e\d+)\]/.exec(t)![1];
    const pw = /textbox "Password" \[required\] \[ref=(e\d+)\]/.exec(t)![1];
    const btn = /button "Sign in" \[ref=(e\d+)\]/.exec(t)![1];
    r = await call('browser_fill', {
      fields: [
        { ref: user, value: 'maker' },
        { ref: pw, value: 'maker123' },
      ],
    });
    expect(textOf(r)).toContain('Filled 2 fields');
    r = await call('browser_click', { ref: btn });
    t = textOf(r);
    expect(t).toContain('heading "Create Request"');
    r = await call('browser_snapshot', { interactiveOnly: true });
    expect(textOf(r)).toContain('button "Submit"');
  });

  it('returns screenshots as MCP image content', async () => {
    const r = await call('browser_screenshot', {});
    const img = r.content.find((c) => c.type === 'image');
    expect(img?.mimeType).toBe('image/jpeg');
    expect(img?.data?.length).toBeGreaterThan(1000);
  });

  it('returns normalized, actionable errors', async () => {
    let r = await call('browser_click', { ref: 'e999999' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/✗ ELEMENT_NOT_FOUND/);
    expect(textOf(r)).toMatch(/Suggestion: .*browser_snapshot/);
    r = await call('browser_navigate', { url: 'http://169.254.169.254/latest/meta-data' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('DOMAIN_NOT_ALLOWED');
    r = await call('browser_navigate', {});
    expect(r.isError).toBe(true);
    r = await call('session_switch', { name: 'nobody' });
    expect(textOf(r)).toContain('SESSION_NOT_FOUND');
  });

  it('supports multi-session tools', async () => {
    let r = await call('session_create', { name: 'checker', url: `${base}/login` });
    expect(textOf(r)).toContain('Session "checker"');
    r = await call('session_list');
    expect(textOf(r)).toMatch(/\* checker/);
    r = await call('browser_get_url', { session: 'default' });
    expect(textOf(r)).toContain('/request/create');
  });

  it('exposes resources and prompts', async () => {
    const res = await client.listResources();
    expect(res.resources.map((r) => r.uri)).toContain('tg-browser://status');
    const st = await client.readResource({ uri: 'tg-browser://status' });
    expect(String((st.contents[0] as { text: string }).text)).toContain('checker');
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual(
      expect.arrayContaining(['debug_frontend', 'multi_user_test']),
    );
  });

  it('keeps stdout clean: logs only on stderr', () => {
    // Any stray stdout output would have broken the JSON-RPC stream above.
    expect(stderr).toContain('tg-browser-mcp ready (stdio)');
    expect(stderr).toContain('"tool":"browser_click"');
    expect(stderr).not.toContain('maker123');
  });
});
