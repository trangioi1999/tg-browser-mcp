# TG Browser MCP

A lightweight, secure, token-efficient browser automation **MCP server** and **TypeScript harness** for AI agents.
It drives real browsers (Chrome, Edge, Chromium, Firefox, WebKit) through [Playwright](https://playwright.dev) and works with any MCP client — Claude Code, Codex, Kiro, Gemini CLI, Cursor, VS Code — without a browser extension or any AI-provider login.

```text
Page: Create Request
URL: http://localhost:4200/request/create

- heading "Create Request" [level=1] [ref=e21]
- form "Request form" [ref=e22]
  - textbox "Customer Name" [required] [ref=e23]
  - combobox "Request Type" [ref=e24]: "-- choose --"
  - combobox "Priority" [collapsed] [ref=e25]: "Normal"
  - button "Submit" [ref=e29]
- status "Draft" [ref=e30]
```

After `browser_click ref=e29` the agent receives only what changed:

```text
✓ Clicked button "Submit" · 412ms · session=maker page=p1
Changed:
- button "Submit" [ref=e29] (+disabled)
- status "Pending Approval" [ref=e30] (name "Draft" → "Pending Approval")
- alert "Request REQ-1001 submitted successfully" [ref=e31] (name "" → "Request REQ-1001 submitted successfully")
Removed:
- button "Save Draft" [ref=e28]
```

## Features

| Area                | What you get                                                                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Smart snapshots** | Accessibility-based, ref-addressable, iframes + open shadow DOM, sensitive values masked, paginated, scoped (`scope=<ref>`), interactive-only mode, framework detection (Angular / Material / PrimeNG)                                          |
| **Diffs**           | After each action: `Added / Changed / Removed` instead of the whole page; stable refs within a document; stale refs detected (`STALE_ELEMENT_REFERENCE`)                                                                                        |
| **Interaction**     | click, fill (single or batched form), type, press, hover, select (native + ARIA combobox: mat-select, p-select), check, drag, scroll (incl. virtual-scroll containers), upload, dialogs, tabs, frames                                           |
| **Debugging**       | Deduplicated console, JS errors, network with filters, request details (redacted), performance metrics, Playwright traces, CORS / micro-frontend hints                                                                                          |
| **Sessions**        | Isolated contexts per user/role, project namespaces, encrypted storage-state save/restore (cookies, localStorage, IndexedDB), dedicated persistent profiles, CDP attach (localhost)                                                             |
| **Workflows**       | Declarative multi-user workflows (maker → checker → maker), variables + extraction, dependencies, conditions, idempotency-aware retries, assertions, failure screenshots/diagnostics, checkpoints, cancellation, recording                      |
| **Testing**         | Web-first assertions, **Playwright Test generation** (multi-context, semantic locators, secrets from env), Markdown + JUnit reports                                                                                                             |
| **Network**         | HTTP/HTTPS/SOCKS proxies, env (`HTTP(S)_PROXY`, `NO_PROXY`), per-session proxy, credentials from env only, corporate CA status, step-by-step diagnostics (policy → DNS → TCP/proxy → TLS → HTTP)                                                |
| **Security**        | Domain allow/deny lists, cloud-metadata + private-network blocking (incl. redirects, popups, sub-requests, WebSockets, DNS rebinding check), file-root restrictions, approval via MCP elicitation, audit log, redaction, no JS/shell eval tools |
| **Profiles**        | `minimal` (8 tools) · `developer` (40) · `testing` (61) · `full` (69) — only enabled tools are advertised                                                                                                                                       |
| **SDK**             | `BrowserHarness` usable without MCP, typed lifecycle events for TG Studio                                                                                                                                                                       |

## Quick start

Requirements: Node.js ≥ 20.10 and Chrome/Edge installed (or `npx playwright install chromium`).

```bash
git clone <repo> tg-browser-mcp && cd tg-browser-mcp
npm install
npm run build
node dist/index.js doctor          # verify environment
```

### Claude Code

```bash
claude mcp add tg-browser -- node /absolute/path/tg-browser-mcp/dist/index.js --profile developer
```

or `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "tg-browser": {
      "command": "node",
      "args": [
        "/absolute/path/tg-browser-mcp/dist/index.js",
        "--transport",
        "stdio",
        "--profile",
        "developer"
      ]
    }
  }
}
```

Codex, Kiro, Gemini CLI, Cursor and VS Code: see [docs/CLIENTS.md](docs/CLIENTS.md).

### Try it against the bundled demo app

```bash
npm run fixture          # http://127.0.0.1:4321 — users maker/maker123, checker/checker123
```

Then ask your agent: _"Log in as maker on http://127.0.0.1:4321, create a loan request for ACME, then as checker approve it, and generate a Playwright test."_

### Use as a library

```ts
import { BrowserHarness } from 'tg-browser-mcp';

const harness = new BrowserHarness({ browser: { headless: true } });
harness.on('action.completed', (e) => console.log(e.action, e.durationMs));

const session = await harness.createSession({ name: 'frontend-agent', browser: 'chrome' });
await session.navigate('http://localhost:4200');
console.log((await session.snapshot()).text);
await session.click({ role: 'button', name: 'Create' });
await harness.close();
```

## CLI

```text
tg-browser-mcp [start] [--transport stdio|http] [--browser chrome|edge|chromium|firefox|webkit]
               [--headless] [--profile minimal|developer|testing|full] [--config file] [--project name]
tg-browser-mcp init | doctor [--url u] | browsers | sessions | workflows | --help | --version
```

Details: [docs/CLI.md](docs/CLI.md).

## Measured token efficiency

Same 12-step scenario on the bundled fixture app (login → form → submit → dynamic updates → 1,500-item page),
measured with `npm run bench` against `@playwright/mcp` 0.0.86 ([docs/BENCHMARK.md](docs/BENCHMARK.md)):

|                                         |             TG Browser (developer) |             Playwright MCP |
| --------------------------------------- | ---------------------------------: | -------------------------: |
| Tool responses, normal pages (11 steps) |                        3,169 chars |                5,138 chars |
| Snapshot of 1,500-link page             | 11,940 chars (page 1/N, paginated) |       184,900 chars (full) |
| Total responses                         |           27,139 chars (~6.8k tok) | 190,267 chars (~47.6k tok) |
| Tool schema advertised                  |            31,039 chars (40 tools) |    21,199 chars (25 tools) |

Honest notes: most of the total difference comes from paginating very large pages (the full content is still available via `page=N` or `scope=<ref>`). Our `navigate`/`click` responses are larger per call because they embed the snapshot or diff (saving a separate snapshot call). The `developer` profile advertises more tools and therefore a larger schema; `minimal` is ~7.7k chars.

## Documentation

[Architecture](docs/ARCHITECTURE.md) · [Installation](docs/INSTALLATION.md) · [Windows setup](docs/WINDOWS.md) · [Configuration](docs/CONFIGURATION.md) · [CLI](docs/CLI.md) · [Tools](docs/TOOLS.md) · [MCP clients](docs/CLIENTS.md) · [Proxy & enterprise network](docs/PROXY.md) · [Sessions](docs/SESSIONS.md) · [Angular](docs/ANGULAR.md) · [Workflows](docs/WORKFLOWS.md) · [Security model](docs/SECURITY.md) · [Threat model](docs/THREAT_MODEL.md) · [TG Studio](docs/TG_STUDIO.md) · [Benchmark](docs/BENCHMARK.md) · [Deploy to Cloudflare](docs/DEPLOY-CLOUDFLARE.md) · [Roadmap](docs/ROADMAP.md) · [Progress](docs/PROGRESS.md) · [ADRs](docs/adr/) · [Contributing](CONTRIBUTING.md)

## License

Apache-2.0. Built on Playwright (Apache-2.0) and the MCP TypeScript SDK (MIT). No source code was copied from microsoft/playwright-mcp; its public architecture was used as a reference. See [NOTICE](NOTICE).

## Local management dashboard

Run `tg-browser-mcp ui --open` for an offline Vietnamese dashboard with configuration editing, session
timelines, screenshots, video, grouped console/network errors, workflow reports and traces. The command
prints a tokenized localhost URL; settings are validated and backed up before saving. Restart MCP clients
to apply saved changes. Journaling defaults on; video recording defaults off. Settings start from four
presets (Basic, Developer, Testing, Full) showing tool count and estimated context tokens; the Workflows page
lists saved workflows, their steps and run history. See [Dashboard](docs/DASHBOARD.md) for configuration,
retention and security details, and [Windows setup](docs/WINDOWS.md) for PowerShell paths and client config.
