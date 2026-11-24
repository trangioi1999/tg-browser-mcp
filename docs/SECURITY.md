# Security model

TG Browser MCP gives an AI agent control of a real browser. The design assumes:

- **The AI agent is semi-trusted**: it follows the user, but can be manipulated by content it reads.
- **Web pages are untrusted**: any text, attribute, console message or network payload may contain hostile instructions.
- **The user/operator is trusted** and is the only party that can relax policy (config file, CLI flags, approval prompts).

## Defaults

| Control                                                                                       | Default                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Localhost targets                                                                             | allowed (`security.allowLocalhost`) — local dev servers                                                                                         |
| Private networks (RFC1918, link-local, CGNAT, ULA)                                            | **blocked** unless `allowPrivateNetwork` or explicitly allowlisted                                                                              |
| Cloud metadata (169.254.169.254, metadata.google.internal, fd00:ec2::254, IPv4-mapped forms…) | **always blocked**                                                                                                                              |
| `file:`, `javascript:`, `chrome:` and other schemes; URLs with credentials                    | blocked                                                                                                                                         |
| Enforcement scope                                                                             | navigations, redirects, popups, sub-requests, WebSockets; service workers blocked                                                               |
| DNS rebinding                                                                                 | non-allowlisted hostnames are resolved and rejected if they map to private/metadata addresses                                                   |
| TLS                                                                                           | verification is always on; `tls.verify: false` is rejected; `--ignore-certificate-errors` etc. are denied launch args                           |
| File access                                                                                   | uploads, screenshot/trace/report paths must be inside `fileAccess.allowedRoots` (default: cwd + dataDir); symlinks resolved                     |
| High-risk tools (`browser_upload_file`, `browser_connect`)                                    | `approval.highRisk = ask` (MCP elicitation), otherwise `APPROVAL_REQUIRED`                                                                      |
| Destructive clicks (delete, remove, pay, transfer, purchase …)                                | `approval.destructive = ask`                                                                                                                    |
| JavaScript / shell execution tools                                                            | **not provided**                                                                                                                                |
| Downloads                                                                                     | disabled (`acceptDownloads: false`)                                                                                                             |
| Request/response bodies                                                                       | not captured (`captureBodies: false`)                                                                                                           |
| CDP                                                                                           | localhost only; remote requires `allowRemoteCdp` + https/wss                                                                                    |
| HTTP transport                                                                                | off by default; bearer token (≥24 chars, from env), 127.0.0.1, Host/Origin checks, rate limiting, session cap, isolated harness per MCP session |
| Telemetry                                                                                     | none; logs and audit stay local                                                                                                                 |

## Approvals

When a policy is `ask`, the server sends an MCP **elicitation** request to the client, which shows it to the human. Declines become `PERMISSION_DENIED`. If the client does not support elicitation the call fails with `APPROVAL_REQUIRED` and a suggestion for the user — the model cannot approve on its own (there is no "confirm: true" argument). Set the policy to `allow` or `deny` in the config to make the decision permanent.

## Data protection

- **Redaction** (`DataRedactor`): authorization/cookie/api-key headers, sensitive query params (token, code, state…), JWTs, bearer tokens, card-like numbers, emails (network/console), and JSON keys (password, secret, token, otp, pin, card, ssn… plus `security.sensitiveFields`). Short keys only match whole tokens (`pin` ≠ `shipping`).
- **Snapshots** mask values of password fields, `autocomplete=cc-*/one-time-code/*-password`, and fields whose name/id/label matches a sensitive key (`••••`).
- **Recorder** stores sensitive inputs as `${secret.NAME}` placeholders; workflows resolve them from `TG_SECRET_<NAME>` env vars and mask them in results.
- **Session state** is encrypted at rest (AES-256-GCM, tamper-evident). Tool responses only report counts — raw cookies/tokens are never returned to the model.
- **Logs** (stderr) and **audit** records contain tool names, targets (ref or host), status and timing — never typed values.
- **Errors** are normalized; stack traces and Playwright call logs are stripped.

## Prompt injection

Page content is data. The server instructions tell the model so explicitly, snapshots render text as quoted data (never as instructions), and every dangerous capability is gated by policy rather than by the model's judgment: even a fully hijacked agent cannot reach metadata endpoints, private networks, local files outside the roots, or perform approval-gated actions without the human.

## Limitations (honest)

- Redirect hops of **sub-resources** (fetch/img) are not interceptable by Playwright routes; the target host may receive a blind GET. The response is not committed to a document we snapshot. Use `allowedDomains` and network controls for high-assurance setups.
- The DNS-rebinding check resolves once (cached 30s); the browser resolves independently (TOCTOU window).
- Page scripts run in the same world as the snapshot helper and could tamper with it; ref resolution re-checks the element's role, but a malicious page can always lie about its own content.
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
