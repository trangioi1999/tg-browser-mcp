import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { TgConfig } from '../../config/schema.js';
import { createMcpServer, type McpServerHandle } from '../mcp-server.js';
import { getLogger } from '../../shared/logger.js';
import { TgError } from '../../shared/errors.js';
import { isLoopback } from '../../security/domain-policy.js';

interface HttpSession {
  transport: StreamableHTTPServerTransport;
  handle: McpServerHandle;
  lastSeen: number;
}

/**
 * Optional Streamable HTTP transport.
 *  - Bearer token required (read from env `http.tokenEnv`, never from config files).
 *  - Binds to 127.0.0.1 by default; DNS-rebinding protection (Host/Origin allowlist) enabled.
 *  - Each MCP session gets its own BrowserHarness (separate browser + contexts): no cross-session leakage.
 *  - Per-IP rate limiting and a cap on concurrent sessions; idle sessions are reaped.
 */
export async function startStreamableHttp(
  config: TgConfig,
): Promise<{ url: string; close(): Promise<void> }> {
  const log = getLogger();
  const token = process.env[config.http.tokenEnv];
  if (!token || token.length < 24) {
    throw new TgError(
      'CONFIG_INVALID',
      `HTTP transport requires a bearer token of ≥24 chars in env ${config.http.tokenEnv}`,
      {
        suggestion: `export ${config.http.tokenEnv}=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")`,
      },
    );
  }
  if (!isLoopback(config.http.host))
    log.warn(
      { host: config.http.host },
      'HTTP transport bound to a non-loopback address; use TLS termination and network controls',
    );

  const sessions = new Map<string, HttpSession>();
  const hits = new Map<string, { n: number; reset: number }>();
  const tokenBuf = Buffer.from(token);
  // The browser and any other child process must not inherit the token.
  delete process.env[config.http.tokenEnv];

  const authorized = (req: http.IncomingMessage): boolean => {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return false;
    const got = Buffer.from(m[1]!.trim());
    return got.length === tokenBuf.length && timingSafeEqual(got, tokenBuf);
  };

  const clientKey = (req: http.IncomingMessage): string => {
    const h = config.http.trustedClientIpHeader;
    const v = h ? req.headers[h.toLowerCase()] : undefined;
    const fromHeader = typeof v === 'string' ? v.split(',')[0]!.trim().slice(0, 64) : '';
    return fromHeader || req.socket.remoteAddress || 'unknown';
  };

  const rateLimited = (ip: string): boolean => {
    const now = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    if (hits.size > 10_000) hits.clear();
    const e = hits.get(ip);
    if (!e || e.reset < now) {
      hits.set(ip, { n: 1, reset: now + 60_000 });
      return false;
    }
    e.n++;
    return e.n > config.http.rateLimitPerMinute;
  };

  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > config.http.idleTimeoutMinutes * 60_000) {
        sessions.delete(id);
        void s.handle.close();
        log.info({ sessionId: id }, 'reaped idle MCP session');
      }
    }
  }, 60_000);
  reaper.unref();

  // Filled in after listen() so an ephemeral port (0) is handled correctly.
  let allowedHosts: string[] = [];

  const server = http.createServer(async (req, res) => {
    const ip = clientKey(req);
    const send = (status: number, msg: string) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: msg }, id: null }));
    };
    try {
      if (!req.url?.startsWith('/mcp')) return send(404, 'Not found');
      // DNS-rebinding defence (also enforced by the SDK transport): only our own Host values.
      if (!allowedHosts.includes(String(req.headers.host ?? '').toLowerCase()))
        return send(403, 'Invalid Host header');
      const origin = req.headers.origin;
      if (origin && config.http.allowedOrigins.length && !config.http.allowedOrigins.includes(origin))
        return send(403, 'Invalid Origin header');
      if (rateLimited(ip)) return send(429, 'Rate limit exceeded');
      if (!authorized(req)) return send(401, 'Unauthorized');
      const sid = req.headers['mcp-session-id'] as string | undefined;

      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4 * 1024 * 1024) return send(413, 'Request too large');
        }
        const msg: unknown = body ? JSON.parse(body) : undefined;
        if (sid && sessions.has(sid)) {
          const s = sessions.get(sid)!;
          s.lastSeen = Date.now();
          return void (await s.transport.handleRequest(req, res, msg));
        }
        if (!sid && isInitializeRequest(msg)) {
          if (sessions.size >= config.http.maxSessions) {
            // Clients that disconnect without DELETE leave sessions behind: reclaim the stalest
            // idle one instead of locking everybody out until the idle timeout.
            const [oldestId, oldest] = [...sessions.entries()].sort(
              (a, b) => a[1].lastSeen - b[1].lastSeen,
            )[0]!;
            if (Date.now() - oldest.lastSeen < config.http.evictIdleAfterSeconds * 1000)
              return send(503, 'Too many active sessions; retry later');
            sessions.delete(oldestId);
            void oldest.handle.close();
            log.info({ sessionId: oldestId }, 'evicted idle MCP session to admit a new client');
          }
          const handle = createMcpServer(config);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableDnsRebindingProtection: true,
            allowedHosts,
            ...(config.http.allowedOrigins.length ? { allowedOrigins: config.http.allowedOrigins } : {}),
            onsessioninitialized: (id) => {
              sessions.set(id, { transport, handle, lastSeen: Date.now() });
              log.info({ sessionId: id }, 'MCP HTTP session started');
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
            void handle.close();
          };
          await handle.server.connect(transport);
          return void (await transport.handleRequest(req, res, msg));
        }
        return send(400, 'Bad Request: missing or unknown session');
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        const s = sid ? sessions.get(sid) : undefined;
        if (!s) return send(400, 'Unknown session');
        s.lastSeen = Date.now();
        return void (await s.transport.handleRequest(req, res));
      }
      return send(405, 'Method not allowed');
    } catch (e) {
      log.error({ err: (e as Error).message }, 'http transport error');
      if (!res.headersSent) send(500, 'Internal error');
    }
  });

  await new Promise<void>((resolve) => server.listen(config.http.port, config.http.host, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.http.port;
  allowedHosts = [
    `${config.http.host}:${port}`,
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    ...config.http.allowedHosts.map((h) => h.toLowerCase()),
  ];
  const url = `http://${config.http.host}:${port}/mcp`;
  log.info({ url }, 'tg-browser-mcp ready (streamable http)');
  return {
    url,
    async close() {
      clearInterval(reaper);
      await Promise.all([...sessions.values()].map((s) => s.handle.close()));
      sessions.clear();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
