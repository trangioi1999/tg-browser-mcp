# Deploy to Cloudflare Containers

```text
Client (AI agent / your project)
   │  HTTPS + Authorization: Bearer <token>
   ▼
Worker  deploy/cloudflare/src/index.ts   ← only public ingress
   │  path/method allowlist · per-IP rate limit (before auth) · constant-time token check · 4 MB body cap
   ▼
Durable Object "main" → Container (Dockerfile)
   tg-browser-mcp start --transport http   (non-root, read-only /app, headless Chromium with sandbox)
   config: deploy/cloudflare/tg-browser.cloud.json
```

## Requirements

- Cloudflare **Workers Paid** plan (Containers are not available on the free plan).
- Docker running locally (Wrangler builds the `linux/amd64` image and pushes it to Cloudflare's registry).
- `npx wrangler login`.

## Check the image locally (optional)

CI builds the image and runs `doctor` on every push (`docker` job). To check before deploying:

```bash
docker build -t tg-browser-mcp .
docker run --rm tg-browser-mcp node /app/dist/index.js doctor --config /app/tg-browser.cloud.json
```

All checks, including `Browser launch`, should pass. Wrangler builds `linux/amd64`; on Apple Silicon add `--platform linux/amd64` to test the same architecture.

## Deploy

```bash
cd deploy/cloudflare
npm install
# 1. Create the client token (kept locally in .dev.vars, mode 0600, gitignored)
umask 077; node -e "console.log('TG_BROWSER_TOKEN=' + require('crypto').randomBytes(32).toString('hex'))" > .dev.vars
# 2. Build + deploy Worker and container image
npx wrangler deploy
# 3. Store the token as a Worker secret (read from the file, never typed on the command line)
grep '^TG_BROWSER_TOKEN=' .dev.vars | cut -d= -f2- | npx wrangler secret put TG_BROWSER_TOKEN
```

The endpoint is `https://tg-browser-mcp.<your-subdomain>.workers.dev/mcp`. The first request after idle starts the container (cold start ≈ 10–30 s); it sleeps after 15 minutes without traffic and **loses all browser sessions** when it does.

Rotate the token: write a new value to `.dev.vars`, repeat step 3. The container picks it up on its next start (`npx wrangler deploy` forces a restart).

## Connect

Claude Code:

```bash
claude mcp add --transport http tg-browser https://tg-browser-mcp.<sub>.workers.dev/mcp --header "Authorization: Bearer $TG_TOKEN"
```

Any MCP-aware project (TypeScript): see [examples/remote-client.ts](../examples/remote-client.ts).

```ts
const client = new Client({ name: 'my-project', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(process.env.TG_BROWSER_URL!), {
    requestInit: { headers: { authorization: `Bearer ${process.env.TG_BROWSER_TOKEN}` } },
  }),
);
const r = await client.callTool({
  name: 'browser_navigate',
  arguments: { url: 'https://staging.example.com' },
});
// … always end with: await transport.terminateSession(); await client.close();
```

## Cloud configuration (differences from local defaults)

| Setting                                                             | Cloud                                                                                     | Why                                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `security.allowLocalhost`                                           | `false`                                                                                   | pages must not reach services inside the container (incl. the MCP port) |
| `security.fileAccess.allowedRoots`                                  | data dir only                                                                             | `/app` must not be writable through `path` arguments                    |
| `security.approval.highRisk`                                        | `deny`                                                                                    | remote SDK clients cannot answer approval prompts                       |
| tools disabled                                                      | upload, connect, traces                                                                   | no host filesystem or CDP access remotely                               |
| `browser.chromiumSandbox`                                           | `true` (override with env `TG_BROWSER_CHROMIUM_SANDBOX=false` if the platform refuses it) | renderer isolation for untrusted pages                                  |
| `http.trustedClientIpHeader`                                        | `x-tg-client-ip` (set by the Worker, client value overwritten)                            | per-client rate limits behind the front door                            |
| `http.maxSessions` / `idleTimeoutMinutes` / `evictIdleAfterSeconds` | 3 / 10 / 120                                                                              | 4 GiB instance; abandoned sessions are reclaimed                        |

To reach internal or staging hosts, add them to `security.allowedDomains` in `tg-browser.cloud.json` and redeploy. The container cannot reach your laptop's `localhost`.

## Operational limits

- One container instance (`max_instances: 1`): all clients share it; MCP sessions are in-memory. Scale vertically (`instance_type: standard-2`), not horizontally, unless session routing is added.
- Container egress is Cloudflare's network: corporate proxies, corporate CAs and intranet hosts are not available unless you add connectivity (e.g. Cloudflare Tunnel) — use an on-premise deployment for those.
- Logs: `npx wrangler tail` (Worker) and the Containers dashboard (server stderr, JSON). Tokens and typed values are never logged.
