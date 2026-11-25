import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, type McpServerHandle } from '../../src/server/mcp-server.js';
import { parseConfig } from '../../src/config/load-config.js';
import type { AuditEntry } from '../../src/security/audit-logger.js';
import { createFixtureServer } from '../fixtures/app/server.mjs';
import { tmpDir } from '../helpers.js';

let app: ReturnType<typeof createFixtureServer>;
let base: string;
let handle: McpServerHandle;
let client: Client;
let dataDir: string;

beforeAll(async () => {
  app = createFixtureServer();
  base = await app.listen();
  dataDir = tmpDir();
  const cfg = parseConfig({
    dataDir,
    logLevel: 'silent',
    browser: { headless: true },
    tools: { profile: 'full' },
    security: { maxSessions: 10 },
  });
  handle = createMcpServer(cfg);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(a);
  client = new Client({ name: 'audit-test', version: '0.0.0' });
  await client.connect(b);
});
afterAll(async () => {
  await client?.close().catch(() => undefined);
  await handle?.close();
  await app?.close();
});

function audit(): AuditEntry[] {
  const dir = path.join(dataDir, 'audit');
  return fs
    .readdirSync(dir)
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditEntry);
}

const last = (tool: string) => audit().filter((e) => e.tool === tool).at(-1)!;

describe('audit attribution (D20)', () => {
  it('records the session a call targets, not the active session', async () => {
    await client.callTool({ name: 'session_create', arguments: { name: 'maker' } });
    const maker = handle.harness.sessions.find('maker')!;
    expect(last('session_create')).toMatchObject({ sessionId: maker.id, session: 'maker', project: 'default' });

    await client.callTool({ name: 'session_create', arguments: { name: 'checker', project: 'p2' } });
    const checker = handle.harness.sessions.find('checker', 'p2')!;
    // session_create makes the new session active; the entry names it and its own project.
    expect(last('session_create')).toMatchObject({ sessionId: checker.id, session: 'checker', project: 'p2' });

    // The active session is "checker" (p2); a call addressed to "maker" is attributed to maker.
    expect(handle.harness.sessions.active?.name).toBe('checker');
    await client.callTool({ name: 'browser_navigate', arguments: { url: `${base}/login`, session: 'maker' } });
    expect(last('browser_navigate')).toMatchObject({
      sessionId: maker.id,
      session: 'maker',
      project: 'default',
      status: 'ok',
    });

    // Without a session argument the call acts on (and is attributed to) the active session.
    await client.callTool({ name: 'browser_get_url', arguments: {} });
    expect(last('browser_get_url')).toMatchObject({ sessionId: checker.id, session: 'checker', project: 'p2' });

    // An unknown session is recorded by name, without borrowing the active session's id.
    await client.callTool({ name: 'browser_get_url', arguments: { session: 'ghost' } });
    const ghost = last('browser_get_url');
    expect(ghost).toMatchObject({ session: 'ghost', status: 'error', errorCode: 'SESSION_NOT_FOUND' });
    expect(ghost.sessionId).toBeUndefined();

    // session_delete is attributed to the deleted session (resolved before the call).
    await client.callTool({ name: 'session_delete', arguments: { name: 'maker' } });
    expect(last('session_delete')).toMatchObject({ sessionId: maker.id, session: 'maker', status: 'ok' });

    // Tools that do not address a session are not attributed to the active one.
    await client.callTool({ name: 'workflow_list', arguments: {} });
    const wf = last('workflow_list');
    expect(wf.sessionId).toBeUndefined();
    expect(wf.session).toBeUndefined();
  });
});
