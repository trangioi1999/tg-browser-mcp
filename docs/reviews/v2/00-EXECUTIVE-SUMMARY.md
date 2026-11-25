# 00 — Executive Summary: TG Browser MCP V2 Architecture Review

Commit reviewed: `74313fc` (clean tree) · Date: 2026-11-25 · Scope: analysis only — no production code changed, nothing committed.

## Verdict

The current product is a well-layered, security-minded Playwright MCP server with a reusable harness, measured token efficiency (reproduced: 27,066 vs 190,267 response chars against Playwright MCP) and real-browser tests (125/128 pass here; the 3 failures are environmental). **The V2 direction — memory-assisted, change-aware, verified automation — is appropriate, but not in the proposed order or breadth.** The review reproduced ten defects in the existing core, several of which a "browser intelligence" layer would amplify (wrong-entity targeting, approval bypasses, unverified success, code injection, SSRF bypass). Stabilize first; then build memory as an untrusted, opt-in hint whose main value is change detection and workflow impact analysis, not raw token savings.

## Top confirmed issues (all reproduced unless noted)

| #    | Issue                                                                                            | Severity      | Doc     |
| ---- | ------------------------------------------------------------------------------------------------ | ------------- | ------- |
| D1   | A ref on a recycled table row clicks the **new** record (REQ001 → "approved REQ009")             | High          | 03      |
| D2   | Destructive approval only on `click`; `press Enter` on the same button bypasses `deny`           | High          | 11 S-01 |
| D3   | Test generator emits attacker `${…}` into template literals → code execution when specs run      | High          | 11 S-03 |
| D4   | Hostnames resolving to cloud metadata are allowed when `allowPrivateNetwork=true` or allowlisted | High          | 11 S-04 |
| D5   | Page can pre-install `window.__tgSnap`, controlling names/ref mapping → approval bypass          | High          | 11 S-02 |
| D6   | Click with HTTP 500 reported as `✓ success`                                                      | Medium        | 04      |
| D7   | `value` assertion prints password values                                                         | Medium        | 11 S-07 |
| D8   | SDK sessions in non-default projects fail (`SESSION_NOT_FOUND`)                                  | Medium        | 02      |
| D9   | One torn run file breaks `workflow_list`/reports/dashboard; writes not atomic                    | Medium        | 05      |
| D10  | Slotted shadow-DOM content listed twice with the same ref                                        | Medium        | 03      |
| D11  | Docker build is broken (`scripts/copy-ui.mjs` not copied) → Cloudflare deploy unverified         | High (deploy) | 01      |
| D12* | Tool/step timeouts don't cancel actions yet say "Retry safe: yes"                                | High          | 04      |
| D13* | Workflow retries `fill` with `submit:true`                                                       | High          | 10      |
| D14* | Any `TG_SECRET_*` can be interpolated into a URL to any allowed host                             | High          | 11 S-05 |
| D15* | No per-page lock; concurrent snapshots can rebind refs                                           | Medium        | 02      |

\* code-evident, deterministic from source; not executed as a probe.

## Recommendations in one page

1. **Phase 0 Stabilization** (2–4 weeks): fix D1–D15, Docker, write roots, test hermeticity, doc corrections.
2. **Phase 1 Foundation:** single `ActionPipeline` (lock → resolve/guard → policy gate → dispatch → verify → observe); `ActionOutcome` with `expect`; repository interfaces; **SQLite via `node:sqlite`** for runs/artifacts (requires Node ≥ 22.13; Node 20 is EOL); `browser_fill` improvements; `within`-scoped targets.
3. **Phase 2 Memory (observe-only, opt-in):** scopes, page identity, fingerprints, page versions, verified marking, derived workflow dependency index.
4. **Phase 3 Adaptive:** deterministic matching, 7 classifications with strict removal rules, candidate versions, **impact analyzer**, healing in suggest-mode.
5. **Phase 4 Workflow/Form:** schema v2 (v1 compatible), `browser_form_inspect`, framework fixtures, migrator.
6. **Phase 5 Platform:** V2 token benchmark before any savings claim, TG Studio policy hook/events, keychain, more browsers.

Reject/defer: confidence engine as acceptance, visual recognition, knowledge-graph databases, dynamic tool discovery, generic batch tool, Angular dashboard rewrite, multi-tenant cloud scaling.

## Scorecard (current system, 0–10)

Rubric: 9–10 production-grade and verified; 7–8 solid with minor gaps; 5–6 works with material gaps; 3–4 significant defects for the intended use; 0–2 absent.

| Dimension            | Score | Evidence                                                                                                                     |
| -------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------- |
| Architecture         |   6.5 | clean harness/MCP separation (no upward imports); executor god-class; no storage abstraction; no concurrency model           |
| Maintainability      |     6 | strict TS, lint clean, small modules; duplication (locators, secret scrubbing, target predicate ×7); untyped workflow inputs |
| Element accuracy     |   4.5 | good refs/stale detection; D1, D10, D5, D15; simplified accname; no closed shadow DOM                                        |
| Browser reliability  |   5.5 | settle, dialog race, crash relaunch; no cancellation, no locks, crashed pages linger                                         |
| Workflow capability  |   5.5 | multi-session, vars, conditions, recorder, generator; D3, D13, D14, D19; no verification/versioning                          |
| Security             |   5.5 | strong policy baseline and tests; D2, D4, D5, D3, D14, write roots                                                           |
| Storage              |     4 | simple and encrypted state; non-atomic, unindexed, fragile under concurrency                                                 |
| Token efficiency     |     7 | reproduced benchmark; developer schema larger than baseline; no V2 measurements                                              |
| Test coverage        |     6 | 128 tests incl. E2E; none of D1–D10 covered; no framework fixtures, concurrency, Docker, Firefox/WebKit                      |
| Production readiness |   4.5 | v0.1.0 unpublished, Docker broken, safety gaps for business-critical actions                                                 |

## Document index

01 audit & capability matrix · 02 architecture & lifecycles · 03 element recognition · 04 action verification · 05 storage · 06 memory · 07 adaptive memory · 08 self-healing · 09 form engine · 10 workflow V2 · 11 security · 12 performance · 13 tests · 14 target architecture (incl. concurrency, dashboard, knowledge graph, TG Studio) · 15 roadmap & MVP · 16 backlog · 17 ADRs.
