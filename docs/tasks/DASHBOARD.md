# Task: Local management dashboard (`tg-browser-mcp ui`)

Read `AGENTS.md`, `docs/ARCHITECTURE.md` and `docs/SECURITY.md` first. Work only in this repository, on the
current branch `feature/dashboard`. Make small, focused commits. **Do not push.**

## Goal

A local web dashboard, started with `tg-browser-mcp ui`, with two areas:

1. **Settings** — view and edit the TG Browser MCP configuration safely.
2. **Sessions** — per project/session overview of screenshots, videos, traces, console/network errors,
   actions timeline and workflow runs/reports.

UI copy in **Vietnamese** (short English technical terms like "session", "workflow", "trace" are fine).

## Part A — backend (TypeScript, `src/`)

### A1. Session journal (new data source)

Console/network events currently live only in memory (`src/network/network-monitor.ts`). Persist a per-session
journal so the dashboard can show history after the MCP process exits.

- File: `<dataDir>/journal/<project>/<session>/events.jsonl` (dirs mode 0700, files 0600). Rotate at 5 MB
  (keep `events.1.jsonl`, at most 2 files per session).
- One JSON object per line: `{ ts, type, sessionId, pageId?, ...payload }`. Types at minimum:
  `session.created`, `session.closed`, `navigation.completed`, `action.completed`, `action.failed`,
  `console.error` (incl. `pageerror`), `network.failed` (failure or HTTP ≥ 400), `dialog.opened`,
  `screenshot.created`, `video.saved`, `workflow.started|completed|failed`.
- Use the existing typed events (`src/shared/events.ts`) and the monitor. **Everything written must already be
  redacted** (reuse `DataRedactor`; URLs via `redactor.url`). Never write typed values, cookies, headers or
  bodies.
- Config: `journal: { enabled: true, maxBytes: 5_000_000 }` (Zod schema in `src/config/schema.ts`, documented).
- Writes must never throw into automation (best-effort, like `AuditLogger`).

### A2. Video recording

- Config `recording: { video: 'off' | 'on' | 'retain-on-failure', size?: { width, height } }`, default `off`.
- `session_create` gets an optional `recordVideo: boolean` that overrides config for that session.
- Use Playwright `recordVideo` on `newContext` / `launchPersistentContext`; save to
  `<dataDir>/artifacts/<project>/<session>/videos/`. Emit a new typed event `video.saved { sessionId, pageId, path, bytes }`
  when a page's video is finalized (after page/context close) and write it to the journal.
- `retain-on-failure`: delete the video if the session had no `action.failed`/workflow failure.

### A3. Dashboard API server — `src/ui/server.ts`

Plain `node:http`, no new runtime dependencies.

Security (mandatory — the dashboard reads local files and edits config):

- Bind **127.0.0.1 only**; refuse to start on any non-loopback host.
- Random 32-byte token generated at start; printed URL `http://127.0.0.1:<port>/?token=…`. On the first visit
  the server sets an `HttpOnly; SameSite=Strict; Path=/` cookie and redirects to a URL without the token. All
  `/api/*` require the cookie (or `Authorization: Bearer`); compare in constant time.
- `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding defence).
- State-changing requests (PUT/POST/DELETE) must have `Origin` equal to the dashboard origin **and** header
  `X-TG-CSRF: 1`.
- Headers on every response: `Content-Security-Policy: default-src 'self'; img-src 'self' data:; media-src 'self';
  object-src 'none'; frame-ancestors 'none'; base-uri 'none'`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store` for API.
- Files are served **only** from `<dataDir>/artifacts/` and `<dataDir>/journal/` via `realpath` checks (no `..`,
  no absolute paths, no symlink escape — reuse `isPathInside`). Never serve `keys/`, `sessions/*.state`,
  `profiles/`, or anything outside those roots. Correct content types (png, jpeg, webm, zip, md, xml, json);
  `.zip` as attachment. Support HTTP Range for videos.
- Request body limit 1 MB; reject non-JSON on PUT.
- Never return proxy credentials, tokens, `TG_SECRET_*` values or `TG_BROWSER_SESSION_KEY`.

Endpoints (JSON unless noted):

| Method | Path | Returns |
|---|---|---|
| GET | `/api/status` | version, config file path, detected browsers, tool counts per profile, proxy status (`ProxyManager.status()`), certificate status |
| GET | `/api/config` | `{ file, raw, effective }` — raw file content (parsed) and effective config |
| GET | `/api/config/schema` | JSON Schema from the Zod `ConfigSchema` (`z.toJSONSchema`) |
| PUT | `/api/config` | validate with `parseConfig`; on error 400 with issue list; on success write atomically (tmp + rename), keep `<file>.bak`, return the new effective config. If no config file exists, create `./tg-browser.config.json` in the dashboard's cwd |
| GET | `/api/tools?profile=` | tools of a profile (name, title, category, risk) — from `ALL_TOOLS` + `selectTools` |
| GET | `/api/projects` | projects found under `journal/`, `runs/`, `artifacts/`, `sessions/` |
| GET | `/api/sessions?project=` | sessions with first/last activity, counts (actions, errors, screenshots, videos, traces), saved-state meta (from `SessionStore.list`, counts only) |
| GET | `/api/sessions/:project/:name` | summary + artifact lists (screenshots, videos, traces) with URLs |
| GET | `/api/sessions/:project/:name/events?type=&since=&limit=` | journal events, newest last, limit ≤ 1000 |
| GET | `/api/runs?project=` / `/api/runs/:project/:runId` | workflow runs (`WorkflowEngine.listRuns/getRun`) |
| GET | `/files/<artifacts-or-journal-relative-path>` | file content (rules above) |

All `:project`, `:name`, `:runId` must pass `assertSafeName`.

### A4. CLI

`tg-browser-mcp ui [--port 8940] [--config <file>] [--project <p>] [--open]` (add to `src/cli/cli.ts` and help).
The `ui` command may print to stdout (it is not MCP STDIO mode). `--open` opens the browser with the OS command
(`open` / `xdg-open` / `start`) using `execFile` with a fixed argument list — no shell strings.

## Part B — frontend (`src/ui/public/`, copied to `dist/ui/public/` by the build)

- **No framework, no CDN, no build step**: plain HTML + CSS + ES modules (works offline). Add a small copy step
  to the build script for the static files.
- **XSS rule:** page titles, URLs, console text, step messages etc. are **untrusted website data**. Render with
  `textContent` / `setAttribute` only. Never `innerHTML` with data. Media/file links only to `/files/...` paths
  returned by the API.
- Layout: left nav (Tổng quan · Sessions · Cài đặt), responsive down to 360 px, light/dark via
  `prefers-color-scheme`, accessible (labels, focus states, keyboard navigation, `aria-live` for save results).

Pages:

1. **Tổng quan**: status cards (version, browsers, profile/tool count, proxy, CA), recent sessions, recent runs.
2. **Sessions**: list grouped by project; filter by project/text; per row: name, last activity, counts badges.
3. **Session detail** with tabs:
   - *Dòng thời gian*: journal events (icon per type, time, message, URL), filter by type.
   - *Ảnh chụp*: gallery with lightbox (keyboard ← → Esc).
   - *Video*: `<video controls>` per file.
   - *Lỗi*: console errors (with ×count) and network failures (method, URL, status, failure code), grouped.
   - *Workflow*: runs touching this session; step table (status, attempts, ms, message), failure screenshot,
     links to Markdown/JUnit reports.
   - *Trace*: list with download link and the `npx playwright show-trace <path>` command (copy button).
4. **Cài đặt**:
   - Form for the common fields: tool profile (+ enabled/disabled tools picker showing tools of the profile),
     browser (engine/channel/headless/indicator/timeout/viewport), security (allowedDomains, blockedDomains,
     allowLocalhost, allowPrivateNetwork, approval modes, sensitiveFields, file roots), network (mode, proxy
     server/bypass/**env var names** for credentials, CA file), snapshot budgets, recording, journal.
   - "JSON nâng cao" raw editor with validation errors from the API.
   - Clear notes: changes apply to **new** MCP processes (restart the client); credentials are env var
     *names*, never values; TLS verification cannot be disabled.
   - Save → PUT with CSRF header; show success/validation errors.

## Part C — tests & docs

- Unit tests (Vitest): journal redaction + rotation; video config handling; API auth (no token, wrong token,
  cookie flow), Host/Origin/CSRF checks, path traversal attempts (`..`, encoded `%2e%2e`, absolute paths,
  symlink escape, `keys/`, `sessions/x.state`), config PUT validation (invalid profile, `tls.verify:false`),
  atomic write + `.bak`.
- Integration: start the dashboard on an ephemeral port against a temp dataDir seeded by running a short harness
  session on the fixture app (`tests/fixtures/app/server.mjs`) with a screenshot and an error; check the
  APIs return them. Browser tests need Chrome; if your sandbox cannot launch it, still write them and say so.
- Keep **all existing tests passing**. Run `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`.
- Docs: `docs/DASHBOARD.md` (usage, screenshots optional, security model), update `README.md`,
  `docs/CONFIGURATION.md`, `docs/CLI.md`, `docs/SECURITY.md` (dashboard threat notes), `docs/PROGRESS.md`;
  regenerate `docs/TOOLS.md` with `npm run docs:tools` if tool schemas change.

## Constraints

- TypeScript strict, ESLint + Prettier clean, no new runtime dependencies.
- Do not modify `.github/`, `deploy/`, or loosen any existing security default.
- Keep the harness independent of the UI (UI imports harness modules, never the reverse).
- Stdout rule for MCP STDIO mode stays intact.

## Definition of done

`tg-browser-mcp ui` starts, prints the tokenized URL, and the dashboard shows real data from a session run on
the fixture app (screenshot, error, workflow run, video when enabled); settings can be edited and saved with
validation; all checks above pass. Finish with a summary: what was built, files changed, test results (exact
numbers), anything not done and why.
