# 17 — Architecture Decisions (proposed ADR-0007 … ADR-0014)

Each ADR is _proposed_; existing ADR-0001…0006 remain in force unless superseded.

## ADR-0007 — Single action pipeline with per-page serialization

- **Context:** policy, verification and concurrency checks are per method (`action-executor.ts`); probes P3/P10 show bypasses; no locking (D15).
- **Problem:** every new action path must remember every safety check.
- **Options:** (a) keep per-method checks + review discipline; (b) decorator per method; (c) one pipeline that all mutating actions pass through.
- **Decision:** (c). Pipeline stages: lock → resolve (guard) → policy gate → dispatch (bounded) → settle → snapshot/diff → verify → observe → events/audit.
- **Trade-offs:** larger refactor; slightly more latency from locking under contention.
- **Risks:** regressions in edge actions (drag, upload, dialogs) — mitigated by keeping executor façade and existing tests.
- **Compatibility:** SDK and tool signatures unchanged.
- **Reversal:** pipeline stages are composable; a stage can be bypassed per action type behind a flag.

## ADR-0008 — Runtime ref guard; refs refuse semantic change for mutating intents

- **Context:** D1 (recycled rows) reproduced; name changes are currently tolerated by design.
- **Options:** (a) compare names strictly; (b) guard with role/keys/container/row key + intent-aware name policy; (c) drop refs, use semantic locators only.
- **Decision:** (b).
- **Trade-offs:** some refs become `TARGET_CHANGED` after re-renders → one extra snapshot.
- **Risks:** row-key heuristics may miss custom grids → falls back to name/container checks; fixtures for Material/PrimeNG tables required.
- **Compatibility:** new error code; output format unchanged.
- **Reversal:** guard strictness configurable (`refs.guard: strict|standard|legacy`).

## ADR-0009 — Action outcome contract (VERIFIED / FAILED / UNVERIFIED / INDETERMINATE)

- **Context:** `success:true` + `✓` even on HTTP 500 (P4).
- **Options:** (a) treat any 4xx/5xx as action failure (throw); (b) outcome object alongside success; (c) always require expectations.
- **Decision:** (b); failure signals make `FAILED` without throwing, expectations make `VERIFIED`, unknown dispatch makes `INDETERMINATE`.
- **Trade-offs:** heuristic failure signals can produce false `FAILED` (e.g. background polling errors) — limited to requests initiated in the action window; configurable ignore patterns.
- **Compatibility:** `success` retained; text prefix changes.
- **Reversal:** `output.verification=off` restores old text.

## ADR-0010 — Hybrid storage: SQLite (node:sqlite) for metadata, JSON for workflow language, FS for binaries

- **Context:** ADR-0004 chose files for MVP; V2 needs relations, versions, multi-process safety.
- **Options:** JSON only; SQLite via `better-sqlite3`; SQLite via `node:sqlite`; PostgreSQL.
- **Decision:** `node:sqlite` behind a thin adapter, introduced with run history and memory (Phase 1), not before; workflow definitions remain files in V2.0 with a derived index; PostgreSQL rejected for V2.
- **Trade-offs:** requires Node ≥ 22.13 (Node 20 is EOL); experimental API warning; no DB for Cloudflare persistence.
- **Risks:** `node:sqlite` API changes → adapter isolates; fallback driver possible.
- **Compatibility:** breaking runtime floor (minor version bump, documented); legacy JSON runs migrated with rollback window.
- **Reversal:** repositories allow returning to file implementations; DB deletion before `--finalize` reverts to files.
- **Supersedes:** ADR-0004 (partially).

## ADR-0011 — Memory is an untrusted, scoped, opt-in hint; observed ≠ verified

- **Context:** proposal makes memory the differentiator; risks of poisoning, leakage, stale actions.
- **Options:** (a) memory drives actions; (b) memory as hint with live verification; (c) no memory.
- **Decision:** (b). Scope = project + origin + environment + auth context; no values stored; verified only through `VERIFIED` outcomes; off by default in V2.0.
- **Trade-offs:** smaller token savings than marketed; more conservative healing.
- **Risks:** low adoption if value is unclear → benchmark (doc 12) decides defaults.
- **Compatibility:** additive.
- **Reversal:** disable flag; purge scope.

## ADR-0012 — Deterministic matching with hard rejection; no confidence thresholds as acceptance

- **Context:** proposed confidence engine.
- **Options:** weighted similarity + threshold; deterministic key passes + uniqueness; ML/embeddings.
- **Decision:** deterministic passes; a score may only order candidates for display.
- **Trade-offs:** more `AMBIGUOUS`/`UNOBSERVED` results requiring AI/human input.
- **Risks:** lower recall — measured by calibration benchmark.
- **Reversal:** a scored pass can be added below the deterministic ones, still non-accepting.

## ADR-0013 — Healing is suggest-first; workflow migration is a separate, human-reviewed step

- **Context:** proposal includes self-healing; safety constraints for business actions.
- **Decision:** locator healing (auto only for read/input strong-key), reconciliation (memory), migration (candidate workflow versions), business changes (human) are separate modules.
- **Trade-offs:** fewer fully autonomous recoveries.
- **Compatibility:** additive. **Reversal:** policy table is configuration.

## ADR-0014 — Tool surface: extend existing tools, add only `browser_form_inspect`; defer dynamic tool discovery

- **Context:** schema size already ≈ 53 % of tool-related chars in the benchmark; client support for `tools/list_changed` varies.
- **Decision:** add optional params (`expect`, `within`, fill options), one new tool, a `core` profile; no runtime tool-set changes.
- **Trade-offs:** some capabilities less discoverable.
- **Risks:** param creep → schema-size budget check in CI.
- **Reversal:** dynamic exposure can be added later behind a capability check.
