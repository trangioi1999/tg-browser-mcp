/**
 * Cloudflare front door for TG Browser MCP.
 *
 * Internet → this Worker (auth, rate limit, path/method allowlist) → Durable Object →
 * Container running `tg-browser-mcp start --transport http`. Container ports are not publicly
 * reachable, so this Worker is the only ingress.
 */
import { Container, getContainer } from '@cloudflare/containers';

interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  TG_BROWSER: DurableObjectNamespace<TgBrowserContainer>;
  /** Bearer token clients must send. Set with `wrangler secret put TG_BROWSER_TOKEN`. */
  TG_BROWSER_TOKEN: string;
  RATE_LIMITER: RateLimit;
}

const CONTAINER_PORT = 8931;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const CLIENT_IP_HEADER = 'x-tg-client-ip';

export class TgBrowserContainer extends Container<Env> {
  defaultPort = CONTAINER_PORT;
  /** Idle containers stop (and lose browser state) after this period without requests. */
  sleepAfter = '15m';
  /** The browser needs the internet; destination policy is enforced inside the container. */
  enableInternet = true;

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- matches Container's constructor signature
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // The server refuses to start with a token shorter than 24 chars.
    this.envVars = { TG_BROWSER_TOKEN: env.TG_BROWSER_TOKEN ?? '' };
  }

  override onError(error: unknown): unknown {
    console.error('container error', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function json(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  });
}

async function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
}

/** Constant-time comparison independent of the presented token's length. */
async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  if (!expected || expected.length < 24) return false;
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return new Response('ok', { headers: { 'cache-control': 'no-store' } });
    if (url.pathname !== '/mcp') return json(404, 'Not found');
    if (!['POST', 'GET', 'DELETE'].includes(request.method))
      return json(405, 'Method not allowed', { allow: 'POST, GET, DELETE' });

    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) return json(429, 'Rate limit exceeded', { 'retry-after': '60' });

    const auth = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '');
    if (!auth || !(await tokenMatches(auth[1]!, env.TG_BROWSER_TOKEN))) {
      return json(401, 'Unauthorized', { 'www-authenticate': 'Bearer' });
    }

    const len = Number(request.headers.get('content-length') ?? '0');
    if (len > MAX_BODY_BYTES) return json(413, 'Request too large');

    // Forward to the container on its loopback Host (accepted by the server's Host allowlist),
    // overwriting any client-supplied client-IP header.
    const headers = new Headers(request.headers);
    headers.set(CLIENT_IP_HEADER, ip);
    const target = new Request(`http://localhost:${CONTAINER_PORT}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? request.body : null,
    });
    // One shared instance: MCP sessions are stateful and live in that container's memory.
    const res = await getContainer(env.TG_BROWSER, 'main').fetch(target);
    const out = new Response(res.body, res);
    out.headers.set('cache-control', 'no-store');
    out.headers.set('x-content-type-options', 'nosniff');
    return out;
  },
} satisfies ExportedHandler<Env>;
