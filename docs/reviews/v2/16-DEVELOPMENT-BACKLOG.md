# 16 — Development Backlog

Priority: P0 (Phase 0), P1 (Phase 1), P2 (Phase 2), P3 (Phase 3), P4 (Phase 4), P5 (Phase 5). Complexity: S (≤2 d), M (≤1 wk), L (≤3 wk). Finding ids refer to docs 01/11.

---

### TGB-001 · Fix Docker build (copy-ui script)

- **Priority:** P0 · **Status:** broken (D11) · **Complexity:** S
- **Problem:** `npm run build` in the Dockerfile build stage fails: `scripts/copy-ui.mjs` is neither copied nor allowed by `.dockerignore`.
- **Evidence:** `Dockerfile:11-13`, `.dockerignore` (`scripts`), `package.json` `build`; reproduced by build-stage simulation.
- **Solution:** `COPY scripts/copy-ui.mjs ./scripts/` (and un-ignore that file) or move the copy step into a Node one-liner inside `tsconfig`-independent build; add a CI job `docker build` + `docker run … doctor --no-launch`.
- **Reuse:** existing Dockerfile. **Files:** `Dockerfile`, `.dockerignore`, `.github/workflows/ci.yml`. **New modules:** none.
- **Dependencies:** none. **Security:** keep non-root runtime, read-only `/app`. **Compatibility:** none affected.
- **Acceptance:** image builds from a clean checkout; `doctor` passes in container; CI job required.
- **Tests:** CI packaging job.

### TGB-002 · Policy gate for every mutating action

- **Priority:** P0 · **Status:** partial (D2/S-01) · **Complexity:** M
- **Problem:** destructive approval only in `click`; Enter/submit/keyboard/select/check/drag bypass.
- **Evidence:** `action-executor.ts:465-471` vs `:509`, `:573`, `:580-595`; probe P3.
- **Solution:** `security/policy-gate.ts` invoked from the action envelope with the _effective_ target (resolved element, focused element for page keys, the form's default submit button for Enter in inputs); Enter/Space on buttons treated as click; high-impact pattern list configurable per project.
- **Reuse:** `PermissionManager.requireApproval/isDestructiveName`. **Files:** `action-executor.ts`, `permission-manager.ts`, new `policy-gate.ts`.
- **Dependencies:** none (TGB-012 later moves it into the pipeline). **Security:** core fix. **Compatibility:** more approval prompts in flows that used Enter on destructive buttons (intended).
- **Acceptance:** P3 inverted for press/fill-submit/type-submit/workflow press; no regression in maker-checker.
- **Tests:** integration `security.test.ts` additions.

### TGB-003 · Harden in-page snapshot engine installation

- **Priority:** P0 · **Status:** vulnerable (D5/S-02) · **Complexity:** M
- **Problem:** page can pre-define `window.__tgSnap` and control names/ref mapping/masking.
- **Evidence:** `injected.ts:61`, `:651-668`; `element-reference.ts:63-76`; probe P10.
- **Solution:** install via `context.addInitScript` (plus evaluate fallback for already-loaded documents with a nonce check), closure state, non-configurable property, captured built-ins; Node-side cross-check of approval-relevant name via Playwright isolated-world reads; Node-side `isSensitiveField` as second masking decision.
- **Reuse:** `installScriptSource`, `isSensitiveField`. **Files:** `injected.ts`, `snapshot-engine.ts`, `session-manager.ts` (init script), `element-reference.ts`, `target.ts`.
- **Dependencies:** none. **Security:** core fix; document residual risk. **Compatibility:** snapshot output unchanged.
- **Acceptance:** P10 → approval required / `TARGET_CHANGED`; masking survives prototype tampering test.
- **Tests:** `/hostile` fixture integration tests.

### TGB-004 · Safe code generation for Playwright tests

- **Priority:** P0 · **Status:** vulnerable (D3/S-03) · **Complexity:** S
- **Problem:** `${…}` survives into template literals → code execution when specs run.
- **Evidence:** `test-generator.ts:7-16`; probe P7.
- **Solution:** tokenize values into literal/var/secret parts; emit `JSON.stringify` literals joined with `+ vars.X +` / `secret('X')`; reject non-identifier var names; parse generated code with the TS compiler API in tests.
- **Reuse:** generator structure. **Files:** `test-generator.ts`, `tests/unit/workflow.test.ts`.
- **Dependencies:** none. **Security:** core fix. **Compatibility:** generated code text changes (semantics same).
- **Acceptance:** payload list produces no executable expressions; e2e generated spec still passes.
- **Tests:** unit payload suite; existing e2e generated-test run.

### TGB-005 · DNS checks always apply the metadata rule

- **Priority:** P0 · **Status:** partial (D4/S-04) · **Complexity:** S
- **Problem:** allowlisted hosts and `allowPrivateNetwork=true` skip DNS → metadata reachable via hostname.
- **Evidence:** `domain-policy.ts:165`, `:169-187`; probe P5.
- **Solution:** always resolve non-IP hostnames; metadata rule unconditional; private/loopback rules respect config/allowlist.
- **Reuse:** `DomainPolicy.resolve` cache. **Files:** `domain-policy.ts`, `tests/unit/domain-policy.test.ts`.
- **Dependencies:** none. **Security:** core fix. **Compatibility:** one DNS lookup for allowlisted hosts (cached 30 s).
- **Acceptance:** metadata matrix denied in all configs.
- **Tests:** unit matrix.

### TGB-006 · Secret usage restrictions in workflows

- **Priority:** P0 (minimum) / P4 (origins) · **Status:** missing (D14/S-05) · **Complexity:** M
- **Problem:** any `TG_SECRET_*` can be interpolated into any step, incl. URLs to arbitrary hosts.
- **Evidence:** `workflow-engine.ts:549-559`; `workflow-tools.ts:22`.
- **Solution:** P0: secrets only allowed in `fill`/`type` values (not URLs, selectors, assertions, extract); inline definitions may not reference secrets unless `workflows.allowInlineSecrets`. P4: config-owned `secrets.<NAME>.origins` checked against the page origin at fill time.
- **Reuse:** `interpolate`. **Files:** `workflow-engine.ts`, `workflow-validator.ts`, `config/schema.ts`, docs.
- **Dependencies:** TGB-012 for origin check at action time. **Security:** core. **Compatibility:** workflows with secrets in URLs fail validation (intended, documented).
- **Acceptance:** exfiltration test denied; maker-checker with secrets passes.
- **Tests:** unit + e2e.

### TGB-007 · Honest timeouts and cancellation semantics

- **Priority:** P0 · **Status:** misleading (D12/S-06) · **Complexity:** M
- **Problem:** tool/step timeouts return retry-safe errors while actions continue.
- **Evidence:** `mcp-server.ts:36-49`; `workflow-engine.ts:603-620`.
- **Solution:** inner Playwright timeouts below outer budget; on outer timeout mark page busy until settle; error `ACTION_TIMEOUT` with `retryable` from idempotency class (false for non-idempotent) and `INDETERMINATE` outcome.
- **Reuse:** `TgError`, retry classes (TGB-010). **Files:** `mcp-server.ts`, `action-executor.ts`, `workflow-engine.ts`, `tool-registry.ts` (error text).
- **Dependencies:** TGB-009 (lock), TGB-010. **Security:** prevents duplicate business actions. **Compatibility:** error text changes.
- **Acceptance:** `/slow-submit` → one submission, `PAGE_BUSY` for overlapping action.
- **Tests:** integration.

### TGB-008 · Runtime ref guard (fix recycled-node targeting)

- **Priority:** P0 · **Status:** missing (D1) · **Complexity:** M
- **Problem:** refs survive semantic change of the same node (virtual scroll).
- **Evidence:** `element-reference.ts:103-116`; `injected.ts:435-443`; probe P1.
- **Solution:** emit `RefGuard` per ref during collect (role, tag, inputType, name, keys, container, rowKey); compare on resolve with intent-aware policy (doc 03 §5.2); new error `TARGET_CHANGED` with old/new context.
- **Reuse:** walker, `RefRegistry`. **Files:** `injected.ts`, `snapshot-engine.ts`, `element-reference.ts`, `target.ts`, `errors.ts`.
- **Dependencies:** none. **Security:** prevents wrong-entity actions. **Compatibility:** some previously "working" refs now error after re-renders — message tells the model to re-snapshot.
- **Acceptance:** `/virtual-table` tests (doc 03 §3.1) incl. counter-change positive case.
- **Tests:** integration.

### TGB-009 · Per-page lock and ref allocation safety

- **Priority:** P0 · **Status:** missing (D15/D25) · **Complexity:** M
- **Problem:** concurrent actions/snapshots interleave; ref counter race; duplicate session creation.
- **Evidence:** `action-executor.ts:199-272`, `:745-777`; `snapshot-engine.ts:93-95`; `session-manager.ts:156-208`.
- **Solution:** async mutex per `PageState` for actions, snapshots, inspections that resolve refs; in-flight map for `SessionManager.create`.
- **Reuse:** none needed. **Files:** `session.ts`, `action-executor.ts`, `snapshot-engine.ts`, `session-manager.ts`.
- **Dependencies:** none. **Security:** integrity. **Compatibility:** concurrent callers serialize (latency only).
- **Acceptance:** parallel click+snapshot stress test produces consistent refs; concurrent create → one session + `SESSION_EXISTS`.
- **Tests:** concurrency suite.

### TGB-010 · Idempotency classes from action + inputs

- **Priority:** P0 · **Status:** partial (D13) · **Complexity:** S
- **Problem:** `fill` with `submit` retried.
- **Evidence:** `workflow-schema.ts:29-42`; `workflow-engine.ts:272-273`.
- **Solution:** `classifyAction(action, input)` → read / idempotent-input / non-idempotent / high-impact; used by workflow retries, timeouts, healing.
- **Files:** `workflow-schema.ts`, `workflow-engine.ts`, new `harness/action-classes.ts`.
- **Dependencies:** none. **Compatibility:** `idempotent: true` override still honoured except for high-impact.
- **Acceptance:** `fill`+`submit` with retries dispatches once.
- **Tests:** e2e (server-side counter).

### TGB-011 · Smaller P0 correctness fixes

- **Priority:** P0 · **Complexity:** S each
- D8 SDK project propagation (`browser-harness.ts:122-124`, `:175-177`; `action-executor.ts:86-88`; `session-manager.ts:484`); D9 atomic writes + resilient `listRuns` (`workflow-engine.ts:89-94,129-138,157-175`); D10 slot duplication (`injected.ts:476-479`); D7 assertion masking (`assertion-engine.ts:70-86`); S-08 write roots/extension allowlist (`load-config.ts:148-149`, `permission-manager.ts:68-93`); D20 audit attribution (`mcp-server.ts:136-155`); D17 HTTP eviction with in-flight requests (`streamable-http.ts:78-135`); D18 combobox ambiguity (`combobox.ts:55,73`); test hermeticity + ffmpeg skip; doc corrections.
- **Acceptance/tests:** probes P2, P6, P8, P9 inverted as regression tests; unit tests for write roots and eviction.

### TGB-012 · Extract ActionPipeline from ActionExecutor

- **Priority:** P1 · **Status:** refactor · **Complexity:** L
- **Problem:** policy/verification/lock/observation must apply uniformly; executor mixes 25 operations with the envelope.
- **Evidence:** `action-executor.ts` (1,095 lines; `run/finish` at `:139-272`).
- **Solution:** `harness/action-pipeline.ts` (envelope), `inspectors.ts`, `artifact-service.ts`; executor methods become thin; public `ActionExecutor` API kept as a façade for compatibility.
- **Files:** harness/*, tools use unchanged signatures.
- **Dependencies:** TGB-002, 007, 009. **Compatibility:** SDK API unchanged.
- **Acceptance:** all existing tests pass unchanged; coverage of pipeline ≥ 90 %.
- **Tests:** existing suites + pipeline unit tests with a fake page.

### TGB-013 · ActionOutcome + `expect`

- **Priority:** P1 · **Status:** missing (D6) · **Complexity:** M
- **Problem/Evidence:** doc 04; `action-executor.ts:151`, `tool-registry.ts:98`; probe P4.
- **Solution:** contract and verifier (doc 04 §3–7); `expect` param on mutating tools and SDK; text prefix by status.
- **Reuse:** `AssertionEngine`, `NetworkMonitor`. **Files:** `action-executor.ts`/pipeline, `assertion-engine.ts`, `tool-registry.ts`, `page-tools.ts`, `sdk.ts` types.
- **Dependencies:** TGB-012. **Security:** response bodies in memory only, redacted evidence. **Compatibility:** `success` kept; prefix symbol changes.
- **Acceptance:** doc 04 §8 tests; schema-size delta ≤ 1.5k chars/profile.
- **Tests:** integration.

### TGB-014 · Repository interfaces + atomic file implementation

- **Priority:** P1 · **Complexity:** M
- **Solution:** `storage/` interfaces (doc 05 §4); file implementations; dashboard read models switch to repositories (remove per-request `BrowserHarness`, `ui/server.ts:326,373`).
- **Files:** `workflow-engine.ts`, `ui/server.ts`, new `storage/*`. **Dependencies:** TGB-011 (D9). **Acceptance:** dashboard tests pass; no `fs` calls left in `workflow-engine.ts`.

### TGB-015 · Node ≥ 22.13 and `node:sqlite` adapter; SQLite runs/artifacts; run migration

- **Priority:** P1 · **Complexity:** L
- **Problem:** querying, concurrency, integrity (doc 05). **Evidence:** D9; multi-process `dataDir`.
- **Solution:** engines bump (minor version), CI drop Node 20, `doctor` check; adapter; migrations table; `SqliteRunRepository`, `SqliteArtifactRepository`; `migrate --dry-run/--backup/--finalize`.
- **Security:** DB file 0600 in `dataDir`; no secrets stored. **Compatibility:** breaking runtime floor; legacy run JSON readable until finalize.
- **Acceptance:** two processes writing runs concurrently without loss; migration idempotent; rollback documented and tested.
- **Tests:** unit (adapter), concurrency (2 processes), CLI migration tests.

### TGB-016 · `browser_fill` improvements

- **Priority:** P1 · **Status:** partial (D21) · **Complexity:** M
- **Solution:** doc 09 §2.1 (per-field results, pre-checks, `ifEmpty`, autocomplete selection, radio group, ambiguity errors, read-back verify).
- **Files:** `action-executor.ts` (`fillForm`), `combobox.ts`, `page-tools.ts`. **Dependencies:** TGB-013 for verify outcome. **Acceptance:** doc 09 §4 tests.

### TGB-017 · `within` targets, container-scoped recorder/generator, session leases, `core` profile, snapshot `complete` flag

- **Priority:** P1 · **Complexity:** M
- **Files:** `target.ts`, `workflow-recorder.ts`, `test-generator.ts`, `session-manager.ts`, `workflow-engine.ts` (`ensureSessions`), `tool-registry.ts`/`config/schema.ts` (profile), `snapshot-engine.ts`.
- **Acceptance:** scenarios 1, 2, 17 (doc 13); recorder emits scoped locators for duplicate names.

### TGB-018 · Browser Memory (observe-only, opt-in)

- **Priority:** P2 · **Complexity:** L
- **Solution:** doc 06 modules; scopes, pages, versions, elements, observations, memory events; summary line; verification marking; caps/sanitization.
- **Dependencies:** TGB-008 (keys emitted), 013, 015, 017 (complete flag). **Security:** doc 11 §3. **Compatibility:** off by default.
- **Acceptance:** scenarios 18, 20, 21; no values persisted (DB scan test for fixture secrets).

### TGB-019 · Workflow dependency index + impact analyzer

- **Priority:** P2 (index) / P3 (analyzer) · **Complexity:** M
- **Solution:** derived `workflow_index`/`workflow_dependencies` from JSON (sha-checked); analyzer states (doc 10 §3).
- **Acceptance:** scenario 8 and 25 classifications; stale index rebuilt automatically.

### TGB-020 · Deterministic matching, classifications, candidate versions, calibration benchmark

- **Priority:** P3 · **Complexity:** L
- **Solution:** doc 07 passes, rejection/ambiguity rules, removal conditions, activation rules; corpus benchmark in CI (precision 100 % gate).
- **Acceptance:** scenarios 4, 5, 7, 9, 10, 11, 25.

### TGB-021 · Healing suggestions (suggest-mode; limited auto)

- **Priority:** P3 · **Complexity:** M
- **Solution:** doc 08; `HEALING_SUGGESTED` error with candidates; auto only read/input strong-key; decisions in `memory_events`.
- **Acceptance:** scenario 22 and doc 08 §6 tests.

### TGB-022 · Workflow schema v2, resume-from-run, migrator, `browser_form_inspect`, framework fixtures

- **Priority:** P4 · **Complexity:** L
- **Solution:** docs 09/10. **Compatibility:** v1 unchanged. **Acceptance:** v1 corpus passes unchanged; v2 example maker-checker with `expect` verified.

### TGB-023 · Platform: TG Studio policy hook/events, V2 token benchmark, keychain, Firefox/WebKit CI, dashboard memory views

- **Priority:** P5 · **Complexity:** L (split when scheduled)
- **Acceptance:** benchmark published with accounting rules (doc 12 §3); event schema versioned.
