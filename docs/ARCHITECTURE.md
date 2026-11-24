# Architecture

## Goals and constraints

- Local-first, no cloud dependency, no AI-provider coupling; MCP is one consumer of a reusable harness.
- Playwright is the only browser engine (no custom engine, no extension).
- Secure by default; every page byte is untrusted input.
- Token-efficient by construction: semantic snapshots, diffs, bounded and paginated output, deterministic summaries (no LLM post-processing).

## Layers and dependency rules

```text
            ┌──────────────── CLI (src/cli) ────────────────┐
            │  start · init · doctor · browsers · sessions   │
            └───────────────┬────────────────────────────────┘
                            ▼
┌─────────────── MCP Transport Layer (src/server) ───────────────┐
│ mcp-server.ts  tool-registry.ts  transports/stdio|streamable-http│
│ - profile filtering, Zod validation, timeouts, audit, approvals │
└───────────────┬────────────────────────────────────────────────┘
                ▼   (tools/* are thin adapters: args → harness calls → text)
┌──────────── Browser Automation Harness (src/harness) ──────────┐
│ BrowserHarness (public SDK) · ActionExecutor · target resolver │
│ typed events (shared/events.ts)                                │
└──┬──────────────┬──────────────┬─────────────┬────────────────┘
   ▼              ▼              ▼             ▼
 browser/       session/       snapshot/     network/           workflow/ · testing/
 detector       manager        injected.ts   proxy-manager      engine, recorder,
 launcher       session(s)     engine        monitor            validator, assertions,
 manager        store (AES)    diff, refs    diagnostics, CA    generator, reports
                     ▲
                     └──────── security/ (domain policy, permissions, redactor, audit) ──┘
```

Rules:

1. `server/` and `tools/` depend on the harness; the harness never imports MCP code.
2. `snapshot/injected.ts` is self-contained (it is serialized into the page).
3. Security components are injected into the harness and consulted at every boundary: navigation, sub-requests, redirects, popups, WebSockets, file paths, launch args, approvals, outputs.
4. All logs go to stderr (pino fd 2). stdout belongs to the MCP STDIO protocol.

## Key flows

### Action

```text
tool call → Zod validate → timeout wrapper → ActionExecutor.run()
  → resolve session/page → resolve target (ref → ElementHandle | semantic → Locator)
  → policy/approval checks → Playwright action (raced against dialogs)
  → settle (pending xhr/fetch/doc ≤2s) → snapshot → diff vs previous (same document) or full snapshot
  → new tabs, dialog state, errors since action start → compact text → audit + log
```

### Snapshot engine

- `tgInstall()` is evaluated once per document (string-evaluated with a `__name` shim so it is independent of the transpiler).
- Walks the DOM including open shadow roots and slots; computes implicit ARIA roles, accessible names (aria-labelledby, aria-label, labels, alt/title/placeholder, content) and states.
- Skips hidden (`display:none`, `aria-hidden`, `inert`, closed dialogs/details) and noise; merges text runs; drops `<label>` text that duplicates a control's name; flattens unnamed structural containers.
- Each element gets a ref stored in a page-side `Map` and a `WeakMap` → **refs are stable for the element's lifetime** and never reused within a page (Node-side counter), so refs from an old document are detected as stale. Ref resolution also checks the role still matches.
- Child frames are captured recursively and spliced under their `iframe` node.
- Formatting is line-based with pagination by character budget (`snapshot.maxChars`).

### Domain policy enforcement

| Path                                    | Mechanism                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Tool navigation                         | `assertAllowed()` before `goto`, final URL check after                                    |
| Page navigation / popups / sub-requests | `context.route('**/*')` → fulfil block page / abort                                       |
| Redirect hops (not visible to routes)   | `request` event → policy check → cancel navigation, show block page, `DOMAIN_NOT_ALLOWED` |
| Committed documents                     | `framenavigated` post-check                                                               |
| WebSockets                              | `context.routeWebSocket`                                                                  |
| Service workers                         | blocked when `enforceOnSubresources` (they bypass routing)                                |

## Data on disk (`dataDir`, default `~/.tg-browser`, mode 0700)

| Path                              | Content                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `sessions/<project>/<name>.state` | AES-256-GCM encrypted Playwright storage state           |
| `keys/session.key`                | Local key (0600), unless `TG_BROWSER_SESSION_KEY` is set |
| `profiles/...`                    | Dedicated persistent browser profiles                    |
| `workflows/<project>/*.json`      | Workflow definitions                                     |
| `runs/<project>/<runId>.json`     | Run checkpoints/results (secrets masked)                 |
| `artifacts/...`                   | Screenshots, traces, reports                             |
| `audit/audit-YYYY-MM-DD.jsonl`    | Audit log (no values, cookies or tokens)                 |

SQLite was not needed for the MVP: all metadata is small, per-project and append-mostly; JSON files keep the install free of native modules (see ADR-0004).

## Module map

| Module             | Responsibility                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `config/`          | Zod schema, defaults, precedence (defaults < file < env < CLI), normalization              |
| `browser/`         | Detection (system + Playwright-managed), launch/persistent/CDP, lifecycle, crash detection |
| `session/`         | Contexts per session, pages, dialogs, policy routes, save/restore                          |
| `snapshot/`        | Injected collector, refs, formatting/pagination, diff                                      |
| `harness/`         | Public API, actions, target resolution, locator suggestions                                |
| `adapters/generic` | ARIA combobox selection (mat-select, p-select, autocomplete)                               |
| `network/`         | Proxy resolution, monitor (ring buffers), diagnostics, certificates                        |
| `security/`        | Domain policy, permissions/approvals/file roots, redaction, audit                          |
| `workflow/`        | Schema, validator, engine, recorder                                                        |
| `testing/`         | Assertions, Playwright test generator, reports                                             |
| `server/`          | MCP server, registry, transports                                                           |
| `tools/`           | Tool definitions per category                                                              |
