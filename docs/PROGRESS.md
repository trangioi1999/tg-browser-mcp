# Progress

Last update: 2026-11-24

## Completed

- Phase 0–4 complete; Phase 5 except npm publication (see ROADMAP.md).
- 69 MCP tools across 10 categories; profiles minimal (8) / developer (40) / testing (61) / full (69).
- Docs: README, architecture, installation, configuration, CLI, tools (generated), clients, proxy & troubleshooting, sessions, Angular, workflows, security model, threat model, TG Studio, benchmark, roadmap, 6 ADRs, contributing.

## In progress

- Local dashboard implemented: Vietnamese offline UI, authenticated localhost API, configuration editing,
  per-session journal, recording, workflow/report links and regression tests. See [Dashboard](DASHBOARD.md).
  Full fixture/browser verification and focused commits remain blocked in the restricted worktree sandbox
  (localhost listen EPERM, Chrome SIGABRT, Git index.lock EPERM).
  Validation: lint, typecheck, build and changed-file formatting pass; 69 unit tests pass in 8 files.
  Final full-suite rerun with shorter sandbox timeouts: 69 passed, 2 failed, 55 skipped (126 tests),
  10 listener errors; 8 files passed and 9 failed. Browser/fixture integration remains unverified.

## Pending

- npm publish, OS keychain integration, sub-resource redirect enforcement, Firefox/WebKit CI runs (see ROADMAP.md "Next").

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

## Test results (local, macOS, Node 24.18, Chrome 158 headless)

`npm test` → **14 files, 104 tests passed** (unit 47; integration: harness 15, security 10, MCP STDIO 8, network/proxy 4, lifecycle 4, HTTP transport 4; E2E maker-checker 5 incl. generated Playwright test run). `npm run lint`, `npm run typecheck`, `npm run build`, `doctor` all clean.

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
