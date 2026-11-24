# Roadmap

Status legend: ✅ done & tested · 🟡 partial · ⏳ planned

## Phase 0 — Research & architecture ✅

Environment inspection, SDK/API verification (MCP SDK 1.32, Playwright 1.65, Zod 4), architecture, security boundaries, backlog, ADRs.

## Phase 1 — Working MCP MVP ✅

STDIO server, typed registry, detection, lifecycle, navigate/snapshot/click/fill/press/wait/screenshot, CLI, unit + integration tests, verified with the official MCP client.
Acceptance: Definition of Done items 1–15 (see PROGRESS.md) — met.

## Phase 2 — Network & sessions ✅

Proxy (system/manual/direct, env, auth via env), diagnostics, CA status, persistent profiles, sessions + save/restore (encrypted), tabs, isolation, CDP attach.
Acceptance: proxied navigation through an authenticated local proxy; 407 diagnosed; maker/checker cookie isolation; profile survives restart; CDP localhost only — all tested.

## Phase 3 — Smart harness ✅

Diffs, compact responses, ref validation/staleness, network & console monitoring, tool profiles, ARIA combobox adapter, framework detection.
Acceptance: measured benchmark vs Playwright MCP (docs/BENCHMARK.md).

## Phase 4 — Workflow & testing ✅

Engine (multi-user, variables, extraction, deps, conditions, safe retries, assertions, diagnostics, checkpoints, cancel), recorder, replay, Playwright test generation, Markdown/JUnit reports.
Acceptance: maker-checker example passes; generated spec passes under `@playwright/test`.

## Phase 5 — Platform integration 🟡

✅ Public SDK, typed events, Streamable HTTP (token, rebinding protection, rate limit, per-session isolation), npm packaging metadata, CI + release workflows.
⏳ Publish to npm; TG Studio reference UI client (separate repo).

## Next

- ⏳ Approvals UX: allow-once / allow-for-session choices in elicitation.
- ⏳ OS keychain for the session key (macOS Keychain, Windows DPAPI, libsecret) instead of the key file.
- ⏳ Redirect enforcement for sub-resource redirects (CDP Fetch on Chromium).
- ⏳ Optional, explicitly-enabled `browser_evaluate` (read-only, approval-gated).
- ⏳ Downloads tool with allowed-roots + size limits.
- ⏳ Firefox/WebKit CI coverage (code paths exist; only Chrome is exercised in tests here).
- ⏳ Framework adapters where fixtures prove the generic path insufficient (mat-datepicker calendar, p-tree).
- ⏳ Real-tokenizer benchmark and per-step token budgets.
