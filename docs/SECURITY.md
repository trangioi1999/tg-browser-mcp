# Security model

TG Browser MCP gives an AI agent control of a real browser. The design assumes:

- **The AI agent is semi-trusted**: it follows the user, but can be manipulated by content it reads.
- **Web pages are untrusted**: any text, attribute, console message or network payload may contain hostile instructions.
- **The user/operator is trusted** and is the only party that can relax policy (config file, CLI flags, approval prompts).

## Defaults

| Control                                                                                       | Default                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Localhost targets                                                                             | allowed (`security.allowLocalhost`) — local dev servers                                                                                                                                                                                                                                                                                                         |
| Private networks (RFC1918, link-local, CGNAT, ULA)                                            | **blocked** unless `allowPrivateNetwork` or explicitly allowlisted                                                                                                                                                                                                                                                                                              |
| Cloud metadata (169.254.169.254, metadata.google.internal, fd00:ec2::254, IPv4-mapped forms…) | **always blocked** — also for hostnames that resolve to a metadata address, even when allowlisted or with `allowPrivateNetwork`                                                                                                                                                                                                                                 |
| `file:`, `javascript:`, `chrome:` and other schemes; URLs with credentials                    | blocked                                                                                                                                                                                                                                                                                                                                                         |
| Enforcement scope                                                                             | navigations, redirects, popups, sub-requests, WebSockets; service workers blocked                                                                                                                                                                                                                                                                               |
| DNS rebinding                                                                                 | every permitted hostname (allowlisted ones too) is resolved; metadata answers are always rejected, loopback/private answers unless allowed by config or allowlist                                                                                                                                                                                               |
| TLS                                                                                           | verification is always on; `tls.verify: false` is rejected; `--ignore-certificate-errors` etc. are denied launch args                                                                                                                                                                                                                                           |
| File access                                                                                   | reads (uploads) must be inside `fileAccess.allowedRoots` (default: cwd + dataDir). Agent-chosen output paths (screenshot/trace/test_generate/test_report `path`) must be inside `fileAccess.writeRoots` (default: `<dataDir>/artifacts` only), use an allowed extension and never replace an existing file unless `allowOverwrite`; symlinks are never followed |
| High-risk tools (`browser_upload_file`, `browser_connect`)                                    | `approval.highRisk = ask` (MCP elicitation), otherwise `APPROVAL_REQUIRED`                                                                                                                                                                                                                                                                                      |
| Destructive clicks (delete, remove, pay, transfer, purchase …)                                | `approval.destructive = ask`, applied to **every** mutating action — click, Enter/Space (incl. typed newlines/spaces), fill/type with `submit`, select, check, drag — on the element actually activated (for Enter in a form field: the field, the form's default submit button and the form)                                                                   |
| Workflow secrets (`${secret.X}`)                                                              | only in `fill`/`type`/`fill_form` values — never in URLs, targets, assertions, extract or conditions; workflow definitions supplied by the model (`workflow_create` / `workflow_execute definition`) may not use secrets unless `workflows.allowInlineSecrets`                                                                                                  |
| Timeouts                                                                                      | inner Playwright timeouts stay below the tool/step budget; a timeout after a mutating action was dispatched is `ACTION_TIMEOUT` with `Retry safe: no` (outcome INDETERMINATE) and the page answers `PAGE_BUSY` until the action settles; actions on one page are serialized                                                                                     |
| JavaScript / shell execution tools                                                            | **not provided**                                                                                                                                                                                                                                                                                                                                                |
| Downloads                                                                                     | disabled (`acceptDownloads: false`)                                                                                                                                                                                                                                                                                                                             |
| Request/response bodies                                                                       | not captured (`captureBodies: false`)                                                                                                                                                                                                                                                                                                                           |
| CDP                                                                                           | localhost only; remote requires `allowRemoteCdp` + https/wss                                                                                                                                                                                                                                                                                                    |
| HTTP transport                                                                                | off by default; bearer token (≥24 chars, from env), 127.0.0.1, Host/Origin checks, rate limiting, session cap, isolated harness per MCP session                                                                                                                                                                                                                 |
| Telemetry                                                                                     | none; logs and audit stay local                                                                                                                                                                                                                                                                                                                                 |

## Approvals

When a policy is `ask`, the server sends an MCP **elicitation** request to the client, which shows it to the human. Declines become `PERMISSION_DENIED`. If the client does not support elicitation the call fails with `APPROVAL_REQUIRED` and a suggestion for the user — the model cannot approve on its own (there is no "confirm: true" argument). Set the policy to `allow` or `deny` in the config to make the decision permanent.

## Data protection

- **Redaction** (`DataRedactor`): authorization/cookie/api-key headers, sensitive query params (token, code, state…), JWTs, bearer tokens, card-like numbers, emails (network/console), and JSON keys (password, secret, token, otp, pin, card, ssn… plus `security.sensitiveFields`). Short keys only match whole tokens (`pin` ≠ `shipping`).
- **Snapshots** mask values of password fields, `autocomplete=cc-*/one-time-code/*-password`, and fields whose name/id/label matches a sensitive key (`••••`).
- **Assertions** on password/sensitive fields (`value`, `attribute value`) report the verdict only; actual and expected values are `[REDACTED]`.
- **Generated Playwright tests** emit page-derived values as JSON string literals joined with `vars.X` / `secret('X')`, so a hostile value cannot become code.
- **Recorder** stores sensitive inputs as `${secret.NAME}` placeholders; workflows resolve them from `TG_SECRET_<NAME>` env vars and mask them in results.
- **Session state** is encrypted at rest (AES-256-GCM, tamper-evident). Tool responses only report counts — raw cookies/tokens are never returned to the model.
- **Logs** (stderr) and **audit** records contain tool names, targets (ref or host), status and timing — never typed values.
- **Errors** are normalized; stack traces and Playwright call logs are stripped.

## Prompt injection

Page content is data. The server instructions tell the model so explicitly, snapshots render text as quoted data (never as instructions), and every dangerous capability is gated by policy rather than by the model's judgment: even a fully hijacked agent cannot reach metadata endpoints, private networks, local files outside the roots, or perform approval-gated actions without the human.

## Limitations (honest)

- Redirect hops of **sub-resources** (fetch/img) are not interceptable by Playwright routes; the target host may receive a blind GET. The response is not committed to a document we snapshot. Use `allowedDomains` and network controls for high-assurance setups.
- The DNS-rebinding check resolves once (cached 30s); the browser resolves independently (TOCTOU window).
- Page scripts run in the same world as the snapshot helper. The helper is installed by an init script before page scripts run, keeps its state in a closure behind a non-configurable property, uses built-ins captured at install time and returns results as JSON strings; a page that pre-defines it is rejected (`TARGET_CHANGED`). Refs carry an identity guard (role, name, row key, container…), so a recycled node yields `TARGET_CHANGED` instead of acting on another record, and approval names and sensitivity are re-checked from Node. Residual risk: a page still controls its own DOM and labels and can change them between verification and dispatch; documents that were already loaded when the session attached are less trusted.
- `allowLocalhost` is on by default for developer ergonomics; disable it when automating untrusted sites on a machine with local services.

Report vulnerabilities as described in [../SECURITY.md](../SECURITY.md). See also the [threat model](THREAT_MODEL.md).

## Remote deployment review (2026-11-24, Cloudflare Containers)

Focused review of the surface exposed by `--transport http` behind the Worker front door ([DEPLOY-CLOUDFLARE.md](DEPLOY-CLOUDFLARE.md)). Each fix has a regression test or a container check.

| #   | Finding                                                                                                                                                           | Evidence                                                                                               | Fix                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | The browser inherited the server's full environment (`TG_BROWSER_TOKEN`, `TG_SECRET_*`, proxy credentials); a compromised renderer could read them                | Linux container: Playwright default → token present in 3 of 24 Chrome processes' `/proc/<pid>/environ` | Allowlisted browser environment (`browserEnv()`), token removed from `process.env` after reading; after fix: 0 processes. Unit test `browser process environment` |
| S2  | Behind a proxy all clients share one source IP: the pre-auth per-IP limiter became global (unauthenticated traffic could lock out clients); limiter map unbounded | source review                                                                                          | Edge rate limit per `CF-Connecting-IP` before auth in the Worker; container keys on a trusted header only when `http.trustedClientIpHeader` is set; map pruned    |
| S3  | `allowLocalhost=true` (dev default) would let pages reach services in the container, including the MCP port                                                       | container test                                                                                         | Cloud config `allowLocalhost:false`; verified `127.0.0.1:8931` / `localhost` blocked                                                                              |
| S4  | Default file roots include cwd: `browser_screenshot path=/app/dist/index.js` could overwrite server code                                                          | container test                                                                                         | Roots = data dir; `/app` root-owned and read-only for uid 10001; verified `FILE_ACCESS_DENIED`                                                                    |
| S5  | Chromium sandbox off (Playwright default)                                                                                                                         | process flags                                                                                          | `browser.chromiumSandbox` option; enabled in cloud; renderers/GPU/network processes verified without `--no-sandbox` locally (needs re-check on Cloudflare)        |
| S6  | Clients disconnecting without `DELETE` kept a browser for 30 min; 3 such clients → 503 for everyone                                                               | container test                                                                                         | `http.idleTimeoutMinutes`, eviction of the stalest idle session when full; integration tests for both cases                                                       |

Verified unchanged: token required on every request (Worker + container, constant-time), wrong/missing token → 401, metadata/private/`file:` blocked, upload/CDP/trace tools not advertised remotely, high-risk approvals denied.

Open items (need validation on the platform): whether Cloudflare's runtime permits the Chromium sandbox (fallback env `TG_BROWSER_CHROMIUM_SANDBOX=false`); Cloudflare's own `deniedHosts` egress control as a second network-layer SSRF barrier (not enabled: its interaction with browser egress is undocumented in source).

## Local dashboard threat notes

`tg-browser-mcp ui` is a separate operator-only HTTP server bound to `127.0.0.1`. A random 32-byte startup
token is exchanged for an HttpOnly/SameSite=Strict cookie through a redirect removing the query token.
API and artifact requests require that cookie or bearer authentication, with constant-time comparison.
Host checks prevent DNS rebinding; writes require the exact dashboard Origin and `X-TG-CSRF: 1`.
Do not expose this operator interface through a tunnel or reverse proxy: its token permits configuration
changes, including changes to security policy for future MCP processes. There is no model approval API.

The dashboard serves only allowlisted artifact/journal file types after realpath containment checks,
rejects symlink escapes and traversal, and never serves session state, keys or profiles. Config updates
use schema validation, a 1 MiB JSON limit, private temporary files, atomic rename and a `.bak` backup.
Credentials use environment variable names; raw secret values are not returned by the JSON API.
A strict CSP, no-referrer, nosniff and no-store headers protect responses; website text is rendered as
text, never HTML. The server assumes local files are controlled by the trusted operator, not an attacker
with filesystem write access racing its reads. Token theft or a compromised same-user local process
remains outside this boundary.

Journals are best-effort, redacted metadata only, rotated to two bounded private files per session.
Screenshots, videos and traces can still contain visible sensitive information and are **not** covered
by journal text redaction. Recording defaults off; `retain-on-failure` removes recordings of successful
sessions at context close. Abrupt process termination can leave unfinished recordings. See [Dashboard](DASHBOARD.md).
