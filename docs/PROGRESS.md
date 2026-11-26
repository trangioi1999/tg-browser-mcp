# Progress

Last update: 2026-11-27

## Completed

- Phase 0–4 complete; Phase 5 except npm publication (see ROADMAP.md).
- 69 MCP tools across 10 categories; profiles minimal (8) / developer (40) / testing (61) / full (69).
- Docs: README, architecture, installation, configuration, CLI, tools (generated), clients, proxy & troubleshooting, sessions, Angular, workflows, security model, threat model, TG Studio, benchmark, roadmap, 6 ADRs, contributing.

## V2 review — Phase 0 stabilization (2026-11-25)

Implements Phase 0 of [docs/reviews/v2](reviews/v2/15-IMPLEMENTATION-ROADMAP.md) (backlog TGB-001…TGB-011):
Docker build + CI `docker` job (D11); policy gate on every mutating action (D2); hardened snapshot engine
installation (D5); safe test generation (D3); DNS metadata rule always applied (D4); secrets restricted to
fill/type values (D14); honest timeouts with `INDETERMINATE` / `PAGE_BUSY` (D12); runtime ref guard (D1) and slot
dedupe (D10); per-page lock and in-flight session creation (D15, D25); input-aware retry classes (D13);
assertion masking (D7); SDK/MCP project addressing (D8); atomic run files (D9); HTTP eviction of busy sessions
(D17); combobox ambiguity (D18); audit attribution (D20); separate write roots (S-08); hermetic tests (proxy and
`TG_BROWSER_*` env cleared, video tests skip without Playwright ffmpeg); doc corrections.

The local dashboard (previously "in progress", blocked in a sandbox) is verified by `dashboard.test.ts` on a real
browser, including video retention.

## V2 review — Phase 1 core and storage foundation (2026-11-27)

Implements Phase 1 of [docs/reviews/v2](reviews/v2/15-IMPLEMENTATION-ROADMAP.md) (backlog TGB-012…TGB-017):

- **TGB-012:** the action envelope (policy gate, per-page lock, budgets, settle, snapshot/diff) lives in
  `harness/action-pipeline.ts`, with `inspectors.ts` and `artifact-service.ts`; `ActionExecutor` is a
  compatible façade. Fake-page pipeline unit tests.
- **TGB-013:** `ActionOutcome` + optional `expect` on mutating tools and the SDK (doc 04). Text output starts
  with `✓` VERIFIED, `•` UNVERIFIED, `✗` FAILED or `?` INDETERMINATE; `success` is kept. Schema growth per
  profile stays under 1.5k chars (`tests/unit/expect-schema-size.test.ts`).
- **TGB-016:** `browser_fill` reports per-field results, pre-checks disabled/readonly fields, supports `ifEmpty`,
  `continueOnError`, autocomplete and radio groups, reports ambiguity and validation messages, verifies by read-back.
- **TGB-014:** `src/storage/` repository interfaces with atomic file implementations; no `fs` in
  `workflow-engine.ts`; dashboard reads through repositories instead of a per-request `BrowserHarness`.
- **TGB-015:** Node ≥ 22.13 (version 0.2.0, CI drops Node 20, `doctor` checks it). Runs and artifact metadata in
  `dataDir/storage.sqlite` (0600, WAL) via `node:sqlite`; `tg-browser-mcp migrate --dry-run | --backup |
--finalize` imports legacy JSON runs (see CONFIGURATION.md).
- **TGB-017:** `within` container-scoped targets, container-scoped recorder/generator locators, session leases
  (`SESSION_BUSY`) for concurrent workflow runs, opt-in 13-tool `core` profile, snapshot `complete` flag.

Built in three parallel lanes and merged on `feat/phase1`. Test results (local, macOS, Node 24.18, Chrome
headless, 2026-11-27): `npm test` → **38 files, 309 tests passed**; lint, typecheck, build clean. Storage and
dashboard unit tests also pass on Node 22.13.1.

## Pending

- npm publish, OS keychain integration, sub-resource redirect enforcement, Firefox/WebKit CI runs (see ROADMAP.md "Next").
- V2 Phase 2+ (TGB-018…TGB-023): Browser Memory, impact analyzer, adaptive matching, healing, workflow v2 (see [reviews/v2/16-DEVELOPMENT-BACKLOG.md](reviews/v2/16-DEVELOPMENT-BACKLOG.md)).

## Implementation backlog (prioritized, original plan)

| #   | Item                                                      | Status |
| --- | --------------------------------------------------------- | ------ |
| 1   | Config schema + precedence                                | ✅     |
| 2   | Errors, logger (stderr), events                           | ✅     |
| 3   | Domain policy, redactor, permissions, audit               | ✅     |
| 4   | Browser detection/launch/manager                          | ✅     |
| 5   | Sessions/pages/dialogs + policy routes                    | ✅     |
| 6   | Snapshot engine + refs + diff                             | ✅     |
| 7   | Action executor + target resolution                       | ✅     |
| 8   | MCP server, registry, STDIO                               | ✅     |
| 9   | CLI + doctor                                              | ✅     |
| 10  | Network monitor, proxy, diagnostics, CA                   | ✅     |
| 11  | Workflow engine, recorder, assertions, generator, reports | ✅     |
| 12  | HTTP transport                                            | ✅     |
| 13  | Docs, CI, benchmark                                       | ✅     |

## Architecture decisions

See docs/adr/0001–0006.

## Test results (local, macOS, Node 24.18, Chrome headless, 2026-11-25)

`npm test` → **28 files, 231 tests passed**, also with `HTTPS_PROXY`/`HTTP_PROXY` set in the environment
(hermeticity). `npm run lint`, `npm run typecheck`, `npm run build` clean. Docker image built from a clean
checkout; `doctor` (including browser launch) passes in the container.

## Bugs found by tests and fixed

- Snapshot injection broke under esbuild `keepNames` (`__name is not defined`) → string evaluation with shim.
- IPv4-mapped IPv6 hex form (`::ffff:a9fe:a9fe`) bypassed metadata blocking → normalized.
- Redirect hops are invisible to Playwright routes → request-event enforcement + navigation cancel.
- Popup first request had no frame → route handler threw → guarded.
- Null JSHandle on stale refs surfaced as a raw TypeError → normalized `STALE_ELEMENT_REFERENCE`.
- Custom combobox picked hidden native `<option>`s → scoped to `aria-controls`, visible only.
- HTTP transport Host allowlist computed before ephemeral port binding → computed after listen.
- Tool schemas were larger than needed → target docs moved to server instructions (developer profile 39k → 27k chars).
- Intermittent EPIPE (≈1 in 5 full runs) from the test proxy fixture's CONNECT tunnel → socket error handlers; verified with 15 isolated + 4 full clean runs.
- Duplicate `browser.closed` event on shutdown → fixed.
- Found on a real site (toeic-vocab): the session's own first tab was reported as a website popup; diffs listed text inside added/removed elements (17 → 6 lines on a login dialog); `?key=` (Google API key) was not redacted in URLs → all fixed with regression tests.

## Known limitations

See docs/SECURITY.md (limitations) and docs/SESSIONS.md (storage). Only Chrome was exercised end-to-end on this machine; Edge/Firefox/WebKit paths are implemented but untested here. Windows/Linux are covered by the CI matrix but were not run locally.

## Next steps

1. Push to a Git remote and let CI run the Windows/Linux/Node 22.13–24 matrix.
2. Connect from Claude Code/Codex with `.mcp.json` and try the maker-checker prompt on the fixture app.
3. Publish to npm; then build the TG Studio event consumer.
