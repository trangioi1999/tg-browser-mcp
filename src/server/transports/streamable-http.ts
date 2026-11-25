import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { TgConfig } from '../../config/schema.js';
import { createMcpServer, type McpServerHandle } from '../mcp-server.js';
import { getLogger } from '../../shared/logger.js';
import { TgError } from '../../shared/errors.js';
import { isLoopback } from '../../security/domain-policy.js';

interface HttpSession extends ReapableSession {
  transport: StreamableHTTPServerTransport;
  handle: McpServerHandle;
}

/** Liveness bookkeeping used to decide whether an HTTP MCP session may be reaped or evicted (D17). */
export interface ReapableSession {
  /** Last time a request started or finished (ms epoch). */
  lastSeen: number;
  /** POST requests whose response has not finished yet (a long tool call counts until it returns). */
  inFlight: number;
  /** Workflow runs (e.g. `background=true`) still executing in this session's harness. */
  runs: Set<string>;
}

/** A session is busy while a request is in flight or a workflow is running; busy sessions are never closed. */
export function isBusy(s: ReapableSession): boolean {
  return s.inFlight > 0 || s.runs.size > 0;
}

/** True when the session is not busy and has been quiet for longer than `idleMs`. */
export function isIdle(s: ReapableSession, now: number, idleMs: number): boolean {
  return !isBusy(s) && now - s.lastSeen > idleMs;
}

/**
 * The stalest session that may be evicted to admit a new client: never a busy one, and only when it
 * has been quiet for at least `minIdleMs`. Returns undefined when nobody can be evicted.
 */
export function pickEvictable<K, S extends ReapableSession>(
  sessions: Iterable<[K, S]>,
  now: number,
  minIdleMs: number,
): [K, S] | undefined {
  let best: [K, S] | undefined;
  for (const e of sessions) {
    if (isBusy(e[1]) || now - e[1].lastSeen < minIdleMs) continue;
    if (!best || e[1].lastSeen < best[1].lastSeen) best = e;
  }
  return best;
}

/**
 * Marks one request in flight until its response finishes (or the connection drops), refreshing
 * `lastSeen` at both ends so a long tool call never looks idle.
 */
export function trackRequest(s: ReapableSession, res: { once(event: 'close', cb: () => void): unknown }): void {
  s.inFlight++;
  s.lastSeen = Date.now();
  let done = false;
  res.once('close', () => {
    if (done) return;
    done = true;
    s.inFlight = Math.max(0, s.inFlight - 1);
    s.lastSeen = Date.now();
  });
}

/**
 * Optional Streamable HTTP transport.
 *  - Bearer token required (read from env `http.tokenEnv`, never from config files).
 *  - Binds to 127.0.0.1 by default; DNS-rebinding protection (Host/Origin allowlist) enabled.
 *  - Each MCP session gets its own BrowserHarness (separate browser + contexts): no cross-session leakage.
 *  - Per-IP rate limiting and a cap on concurrent sessions; idle sessions are reaped. Sessions with a
 *    request in flight or a running workflow are never reaped or evicted (D17).
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
      if (isIdle(s, now, config.http.idleTimeoutMinutes * 60_000)) {
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
          trackRequest(s, res);
          return void (await s.transport.handleRequest(req, res, msg));
        }
        if (!sid && isInitializeRequest(msg)) {
          if (sessions.size >= config.http.maxSessions) {
            // Clients that disconnect without DELETE leave sessions behind: reclaim the stalest
            // idle one instead of locking everybody out until the idle timeout.
            // Sessions with requests in flight or running workflows are never evicted.
            const victim = pickEvictable(sessions, Date.now(), config.http.evictIdleAfterSeconds * 1000);
            if (!victim) return send(503, 'Too many active sessions; retry later');
            const [oldestId, oldest] = victim;
            sessions.delete(oldestId);
            void oldest.handle.close();
            log.info({ sessionId: oldestId }, 'evicted idle MCP session to admit a new client');
          }
          const handle = createMcpServer(config);
          const entry: ReapableSession = { lastSeen: Date.now(), inFlight: 0, runs: new Set() };
          trackRequest(entry, res);
          handle.harness.events.on('workflow.started', (e) => entry.runs.add(e.runId));
          handle.harness.events.on('workflow.completed', (e) => entry.runs.delete(e.runId));
          handle.harness.events.on('workflow.failed', (e) => entry.runs.delete(e.runId));
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableDnsRebindingProtection: true,
            allowedHosts,
            ...(config.http.allowedOrigins.length ? { allowedOrigins: config.http.allowedOrigins } : {}),
            onsessioninitialized: (id) => {
              sessions.set(id, Object.assign(entry, { transport, handle }));
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
