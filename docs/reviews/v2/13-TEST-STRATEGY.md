# 13 — Test Strategy

## 1. Current coverage (verified)

128 tests: unit 71 (config, domain policy, redactor, registry/permissions/proxy/session store/errors/browser env, snapshot diff, workflow validation/interpolation/generation, journal, dashboard API) + integration/E2E 57 (harness 16, security 10, STDIO 8, HTTP 6, network 4, lifecycle 4, indicator 2, dashboard 2, maker-checker 5). 125 pass here; 3 fail for environmental reasons (doc 01).

Gaps: none of D1–D10 had a test; no real-framework fixtures; no concurrency tests; no Docker build in CI; no Firefox/WebKit; tests inherit proxy env (non-hermetic); video tests require a matching ffmpeg without a skip guard.

## 2. Test layers for V2

| Layer                             | Purpose                                                                                                                | Runs                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Pure unit                         | fingerprints, page hashing, matching passes, classifications, retry classes, generator token builder, policy decisions | every PR, < 10 s                          |
| Snapshot-corpus                   | serialized `RawNode[]` + mutations → reconciliation results (calibration benchmark, doc 07 §6)                         | every PR                                  |
| Browser integration (fixture app) | resolver/guard, verification, form engine, policy gates                                                                | every PR (Chrome); nightly Firefox/WebKit |
| E2E business flows                | maker-checker, changed-UI replay, impact analysis                                                                      | every PR                                  |
| Concurrency/fault                 | parallel tool calls, crash injection, process kill during transaction                                                  | nightly                                   |
| Packaging                         | Docker build + `doctor --no-launch` in container; `npm pack` install test                                              | every PR touching Dockerfile/package      |

Hermeticity: test helper clears `HTTP(S)_PROXY`/`NO_PROXY` unless a test opts in; video tests skip with a clear reason when the Playwright ffmpeg binary is missing.

## 3. Fixture additions

`/virtual-table` (row recycling), `/duplicates` (two forms with identical labels, cards with identical buttons), `/request/create?v=2` (10→11 field variant), `/conditional` (fields shown by selection), `/tabs-lazy` (lazy tab content), `/overlay` (CDK-like overlay container at body level, two comboboxes), static built Material-like and PrimeNG-like pages (checked-in HTML/CSS, no network), `/shadow` (open with slots, closed), `/frames-multi` (two iframes with identical labels, iframe that navigates), `/hostile` (labels with injection text, 10k elements, `__tgSnap` pre-definition), `/slow-submit` (server counts submissions, configurable delay), `/business-status` (HTTP 200 with `{status:"REJECTED"}`).

## 4. Mandatory scenarios (positive and negative)

| #   | Scenario                              | Positive case                                                              | Negative case                                                       | Layer                          |
| --- | ------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------ |
| 1   | Two buttons, same accessible name     | ref acts on the right card; `within` scoped role+name works                | bare role+name → `ELEMENT_AMBIGUOUS` (no first-match)               | integration                    |
| 2   | Duplicate fields in different forms   | `fill fields` with `within` form fills the right one                       | unscoped label → ambiguous                                          | integration                    |
| 3   | Reused DOM node after virtual scroll  | ref still valid when only a counter changed                                | row key changed → `TARGET_CHANGED`, nothing approved                | integration                    |
| 4   | Changed label, unchanged test id      | memory matches pass 1 → `MODIFIED`; input step heals                       | submit step returns `HEALING_SUGGESTED`                             | corpus + integration           |
| 5   | Changed test id, unchanged label      | pass 4/5 unique → `MODIFIED`                                               | duplicate label elsewhere → `AMBIGUOUS`                             | corpus                         |
| 6   | Business meaning changed, same role   | —                                                                          | "Approve" → "Reject" on same node: ref refused for click            | integration                    |
| 7   | Removed field                         | removed after 2 complete observations                                      | single observation / truncated snapshot → `UNOBSERVED`              | corpus                         |
| 8   | New required field                    | impact → `NEEDS_INPUT` via page dependency                                 | optional new field → `COMPATIBLE`                                   | corpus + E2E                   |
| 9   | Temporarily hidden field              | hidden by loading state → `UNOBSERVED`                                     | —                                                                   | corpus                         |
| 10  | Conditional fields                    | variant key differs → no removal                                           | —                                                                   | integration                    |
| 11  | Lazy-loaded tabs                      | tab variant keys separate versions                                         | unvisited tab fields `UNOBSERVED`                                   | integration                    |
| 12  | Angular Material overlays             | mat-select-like overlay option chosen via `aria-controls`                  | two open overlays → scoped lookup, no cross-pick                    | integration                    |
| 13  | Multiple iframes                      | refs in both frames act correctly; identical labels distinguished by frame | frame navigates → stale refs                                        | integration                    |
| 14  | Shadow DOM                            | open: slotted child listed once (D10 fixed); refs work                     | closed: documented unsupported, snapshot notes `closed shadow root` | integration                    |
| 15  | Maker-checker                         | existing E2E + verification expectations                                   | checker attempts approve on recycled row → refused                  | E2E                            |
| 16  | Browser crash recovery                | crashed page reported, session marked degraded, new page on next action    | in-flight non-idempotent action → `INDETERMINATE`                   | fault                          |
| 17  | Concurrent workflow executions        | two runs with own sessions both pass                                       | runs sharing a session without lease → `SESSION_BUSY`               | concurrency                    |
| 18  | Concurrent memory updates             | two processes observe same page → one version row, observations=2          | —                                                                   | concurrency (2 processes, WAL) |
| 19  | Workflow migration from JSON          | dry run, idempotent re-run, rollback                                       | torn JSON file reported, not fatal (D9)                             | unit + CLI                     |
| 20  | Memory poisoning                      | hostile labels stored quoted/truncated; no instruction leakage             | 10k elements capped; incomplete snapshot not stored                 | integration                    |
| 21  | Cross-project memory isolation        | project A lookups never return project B rows                              | SDK session in project p2 works (D8 fixed)                          | unit + integration             |
| 22  | Ambiguous self-healing                | —                                                                          | two candidates → no action, candidates listed                       | integration                    |
| 23  | Failed backend after successful click | `FAILED` + `✗` (D6 fixed)                                                  | 200 + success JSON with expectation → `VERIFIED`                    | integration                    |
| 24  | Non-idempotent action timeout         | `INDETERMINATE`, `retryable:false`, exactly one server submission          | second click while busy → `PAGE_BUSY`                               | integration                    |
| 25  | 10 → 11 field evolution               | classifier output 6/2/1/2/1, workflows classified per doc 07 §5            | candidate not activated without verification                        | corpus + E2E                   |

Security regressions (doc 11): S-01 keyboard bypass, S-02 engine takeover, S-03 generator payloads, S-04 DNS metadata matrix, S-05 secret origins, S-07 assertion masking, S-08 write roots, S-09 loopback sub-requests.

## 5. Definition of verified

A feature is "verified" only when a test that exercises it through the public surface (MCP tool or SDK) passes in CI on Linux + Windows + macOS with Chrome, plus the packaging job for deployable artifacts. File existence and unit tests of internals do not count.
