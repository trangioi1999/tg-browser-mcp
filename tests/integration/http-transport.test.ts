import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startStreamableHttp } from '../../src/server/transports/streamable-http.js';
import { parseConfig } from '../../src/config/load-config.js';
import { tmpDir } from '../helpers.js';

const TOKEN = 'test-token-0123456789abcdef0123';
let srv: Awaited<ReturnType<typeof startStreamableHttp>>;

beforeAll(async () => {
  process.env.TGT_HTTP_TOKEN = TOKEN;
  const cfg = parseConfig({
    dataDir: tmpDir(),
    logLevel: 'silent',
    browser: { headless: true },
    http: { port: 0, tokenEnv: 'TGT_HTTP_TOKEN', rateLimitPerMinute: 50 },
    tools: { profile: 'minimal' },
  });
  srv = await startStreamableHttp(cfg);
});
afterAll(async () => {
  await srv?.close();
});

describe('Streamable HTTP transport', () => {
  it('rejects missing or wrong bearer tokens', async () => {
    const r1 = await fetch(srv.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{}',
    });
    expect(r1.status).toBe(401);
    const r2 = await fetch(srv.url, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r2.status).toBe(401);
  });

  it('serves an authenticated MCP session with isolated tools', async () => {
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(srv.url), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('browser_snapshot');
    expect(tools.length).toBeLessThan(12);
    await client.close();
  });

  it('rejects DNS-rebinding Host headers', async () => {
    // fetch() cannot override Host, so use node:http directly.
    const u = new URL(srv.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: u.hostname,
          port: u.port,
          path: u.pathname,
          method: 'POST',
          headers: {
            host: 'evil.example',
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });

  it('rate limits clients', async () => {
    const results = await Promise.all(
      Array.from({ length: 60 }, () =>
        fetch(srv.url, { method: 'GET', headers: { authorization: `Bearer ${TOKEN}` } }).then(
          (r) => r.status,
        ),
      ),
    );
    expect(results).toContain(429);
  });
});

describe('Streamable HTTP session slots', () => {
  const connect = async (url: string) => {
    const c = new Client({ name: 'slot', version: '1' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    );
    return c;
  };
  const start = (evict: number) => {
    process.env.TGT_HTTP_TOKEN = TOKEN;
    return startStreamableHttp(
      parseConfig({
        dataDir: tmpDir(),
        logLevel: 'silent',
        browser: { headless: true },
        tools: { profile: 'minimal' },
        http: { port: 0, tokenEnv: 'TGT_HTTP_TOKEN', maxSessions: 1, evictIdleAfterSeconds: evict },
      }),
    );
  };

  it('rejects a new client while the only slot is actively used', async () => {
    const s = await start(3600);
    try {
      await connect(s.url); // abandoned without DELETE
      await expect(connect(s.url)).rejects.toThrow(/503|Too many/);
    } finally {
      await s.close();
    }
  });

  it('evicts an abandoned idle session to admit a new client', async () => {
    const s = await start(1);
    try {
      await connect(s.url); // abandoned without DELETE
      await new Promise((r) => setTimeout(r, 1200));
      const b = await connect(s.url);
      expect((await b.listTools()).tools.length).toBeGreaterThan(0);
      await b.close();
    } finally {
      await s.close();
    }
  });
});
