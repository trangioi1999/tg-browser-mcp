# Progress

Last update: 2026-11-25

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

## Pending

- npm publish, OS keychain integration, sub-resource redirect enforcement, Firefox/WebKit CI runs (see ROADMAP.md "Next").
- V2 Phase 1+ (TGB-012…TGB-023): ActionPipeline, ActionOutcome + `expect`, SQLite storage, Browser Memory, adaptive matching (see [reviews/v2/16-DEVELOPMENT-BACKLOG.md](reviews/v2/16-DEVELOPMENT-BACKLOG.md)).

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

1. Push to a Git remote and let CI run the Windows/Linux/Node 20–24 matrix.
2. Connect from Claude Code/Codex with `.mcp.json` and try the maker-checker prompt on the fixture app.
3. Publish to npm; then build the TG Studio event consumer.

## V2 Phase 1 — lane A

### TGB-012

- Extracted the action envelope (policy probes/gate, lock, budget handling, settle, snapshot/diff and events) into `ActionPipeline`; inspection and screenshot/trace operations into `Inspectors` and `ArtifactService`. `ActionExecutor` retains its public methods through delegation.
- Added 10 fake-page pipeline tests. Optional native V8 probe (`TGB_PIPELINE_COVERAGE=/tmp/lane-a-coverage-final.json npx vitest run tests/unit/action-pipeline.test.ts`) maps execution ranges back to source lines and enforces the 90% threshold. Final measurement: 302/309 mapped lines covered (97.73%); not a branch-coverage claim.
- Verification: lint/typecheck passed; `npx vitest run tests/unit`: 16 files, 159 tests passed. `npm test` attempted but stalled on fixture setup and was interrupted: localhost bind is denied (`listen EPERM 127.0.0.1`); Playwright Chromium headless shell revision 1255 is also missing. All integration and e2e suites remain unverified in this environment.

### TGB-013

- Added ActionOutcome/ExpectSpec, scoped verification through AssertionEngine and NetworkMonitor, temporary response observers with in-memory JSON checks, redacted verdict evidence, status prefixes, SDK and tool `expect` support. Timeout errors retain legacy context and additionally carry `actionOutcome`.
- Tool schemas advertise a compact array and validate every item against the shared ExpectSpec schema at runtime. Measured baseline → expect: minimal 7,747 → 8,221 (+474), developer 26,742 → 28,085 (+1,343), testing 36,773 → 38,116 (+1,343), full 40,545 → 41,967 (+1,422) chars.
- Unit tests: 17 files / 167 tests passed before final timeout additions. Added fixture integration cases for 500, rejected JSON on 200, verified UI text, and slow pending requests. Browser execution remains blocked by localhost bind denial and missing Chromium. Existing Phase 0 concurrency tests exercise timeout/busy and non-idempotent retries; workflow V2 expectation syntax remains Phase 4 / outside this lane.
- `npm run docs:tools` failed on tsx IPC bind (EPERM); equivalent `node --import tsx scripts/gen-tool-docs.ts` succeeded (69 tools). Schema measurement used `node --import tsx scripts/schema-size.ts` for the same reason.
- Commit attempt for TGB-012 was denied creating the worktree Git `index.lock`; no commits can be created under current sandbox permissions.

### TGB-016

- Batch fills now report every field (including not-attempted fields after a failure), precheck disabled/read-only controls, preserve existing values with `ifEmpty`, select editable autocomplete options and radio groups, support arrays for select controls, and compare read-back values without returning sensitive values. Existing combobox ambiguity rejection is reused. Default read-back verification feeds ActionOutcome; `verify:false` remains UNVERIFIED without explicit expectations.
- Added `continueOnError`, form `within`, required-missing and associated validation-message reporting. Policy refusals remain thrown failures with partial progress attached. Scoped refs must reconstruct a unique matching container; ambiguous scopes fail safely.
- Added unit tests and fixture integration tests for disabled/readonly partial completion, preservation, autocomplete, radio, dependent fields, ambiguity, missing fields, sensitive read-back, validation, opt-out and duplicate names in scoped forms. No Angular/PrimeNG-specific adapters were added; these tests exercise the generic ARIA path.
- TGB-016 adds 716 schema characters per profile independently of `expect`. Final totals: minimal 8,937; developer 28,801; testing 38,832; full 42,683. The expect-only regression tests remain within 1,500 characters for all profiles.

### Final verification and environment limits

- `npm run lint`, `npm run typecheck`, and `npm run build`: passed. `npx vitest run tests/unit`: 19 files / 190 tests passed on the final pass. Native V8 pipeline probe: 10 tests passed, 97.73% mapped-line coverage.
- `npm test`: attempted and interrupted because fixture startup cannot bind localhost (`EPERM`). Unverified suites: `tests/integration/{action-outcome,smart-form,concurrency,dashboard,harness,http-transport,indicator,lifecycle,mcp-audit,mcp-stdio,network,security,snapshot-targeting,workflow-secrets}.test.ts` and `tests/e2e/maker-checker.test.ts`. No browser-suite pass is claimed. Direct Chrome launch also exited with SIGABRT/EPERM; bundled Chromium revision 1255 is absent.
- `npm run docs:tools` and `npm run schema-size`: tsx IPC bind denied. Equivalent `node --import tsx scripts/gen-tool-docs.ts` generated 69 tools; `node --import tsx scripts/schema-size.ts` produced the totals above. Prettier was run on every changed file, and generated docs were regenerated afterward to retain generator formatting.
- Outside the lane's source-file list: one additive paragraph in `src/server/mcp-server.ts` documents the shared ExpectSpec shape so compact per-tool schemas remain usable. Also updated the shared fixture app, generated `docs/TOOLS.md`, and only this lane's section in `docs/PROGRESS.md`. The tool-registry formatter additionally displays outcomes and per-field results, as required by the designs.
- Commit creation is blocked: Git cannot create `/Users/trangioi/Documents/vibe-code/tg-browser-mcp/.git/worktrees/tg-browser-mcp-p1-a/index.lock` (`Operation not permitted`). All changes remain in this worktree; nothing pushed and no PR opened. No other worktree or branch was modified.
