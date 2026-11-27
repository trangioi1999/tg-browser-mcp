# Phase 3 — Adaptive intelligence (plan)

Status: not started (written 2026-11-27, after Phase 2 merged). Source of truth for the design:
[07 Adaptive memory](../reviews/v2/07-ADAPTIVE-MEMORY.md), [08 Self-healing](../reviews/v2/08-SELF-HEALING.md),
[10 §3 Impact analyzer](../reviews/v2/10-WORKFLOW-V2.md), backlog TGB-019 (analyzer), TGB-020, TGB-021.

## Starting point (what Phase 2 already gives us)

- Schema migration 2 already has `page_versions.status = 'candidate'` and `element_observations.classification`
  (unused so far) — Phase 3 should need **no new migration** unless removal confirmations need a column (see A3).
- `src/memory/fingerprint.ts`: fingerprints, semantic keys, shape/label hashes. `src/storage/workflow-index.ts`:
  derived `workflow_dependencies` (page/element/fills_form) with `route_key` and `target_key`.
- Verification marks elements of the pre-action version; a verified version activates only when its variant has no
  active version. Replacing an active version is operator-only (`memory activate`) — Phase 3 adds the rule-based path.
- Fixture routes: `/memory-hostile`, `/memory-flood`, `/memory-busy`. Missing: `/request/create?v=2` (10 → 11 fields).

## Work breakdown

Order: **A first** (B and C reuse its matching functions), then **B and C in parallel**, **D** last.

### A. Reconciler + calibration benchmark (TGB-020, L)

1. `src/memory/reconciler.ts` — pure function `reconcile(previous: ElementObs[], live: ElementObs[], ctx)` →
   per-element `UNCHANGED | MODIFIED | ADDED | REMOVED | UNOBSERVED | AMBIGUOUS | INCOMPATIBLE` (doc 07 §1).
   Deterministic passes 1–6 (§3): test id → formcontrolname/name within form → stable id → (role, name, container)
   → (role, label) page-wide → structural (never auto-accepted). Hard rejection rules and ambiguity rules are
   rules, not scores. Fast path: shape+label hash equal → all `UNCHANGED`.
2. Memory service: when a complete snapshot differs from the active version → write the new version as
   `candidate` with classifications (one transaction). Summary line becomes
   `Memory: 3 changed, 2 added, 1 unobserved since v3` (no names in the line).
3. Removal conditions (§4): `REMOVED` only after ≥ 2 complete observations in the same variant, container
   rendered, not virtualized/paginated. Count confirmations per (candidate version, element) — may need a small
   migration 3 (`absent_observations INTEGER`), or reuse `observations` on the candidate version.
4. Activation rule: candidate → `verified` on a `VERIFIED` outcome touching its elements; auto-activate only if
   it has no `REMOVED`/`INCOMPATIBLE`/`AMBIGUOUS` elements, otherwise operator (`memory activate`). v3 → archived.
5. Calibration corpus: `tests/corpus/` serialized snapshots + mutation operators (rename label, change/remove
   test id, reorder, wrap container, duplicate into another form, toggle required, change input type, hide
   conditionally, move into tab, paginate/virtualize, truncate, hostile labels). Unit suite, no browser.
   **CI gate: auto-match precision 100 %, false REMOVED 0.**
6. Fixture `/request/create?v=2` and scenario 25: classifier output **6 / 2 / 1 / 2 / 1**
   (unchanged / modified / incompatible / added / removed after 2nd observation).

Acceptance: scenarios 4, 5, 7, 9, 10, 11, 25 (doc 13).

### B. Workflow impact analyzer (TGB-019 rest, M)

- `src/memory/impact-analyzer.ts`: reconciliation + `workflow_dependencies` → per workflow (worst step wins):
  `COMPATIBLE | NEEDS_REVALIDATION | NEEDS_INPUT | BROKEN | AMBIGUOUS | REVIEW_REQUIRED | UNKNOWN` (doc 10 §3).
  `NEEDS_INPUT` comes from the **page** dependency (`fills_form` + new required field), not element dependency.
- Map `target_key` of a step to an element: same matching passes as A (reuse, don't duplicate).
- Surface: adaptive summary line `…; affects workflows: create-request (NEEDS_INPUT)`, `memory_page_info`,
  CLI `memory impact [--workflow]`, dashboard impact view.
- Acceptance: scenario 8 (new required field → `NEEDS_INPUT`, optional → `COMPATIBLE`) and scenario 25 states.

### C. Healing suggestions (TGB-021, M)

- `src/harness/target-healer.ts`, called from `resolveTarget` on `ELEMENT_NOT_FOUND` / `TARGET_CHANGED` for
  semantic targets (never for refs): active version → live candidates of same role family/container → rejection
  rules → unique?
- Policy by intent (doc 08 §4): read-only → auto (`healed: true`); input → auto only with strong key in the same
  form; link → auto if href path equal; submit/approve/any button click and high-impact → **never**, return new
  error `HEALING_SUGGESTED` with ≤ 5 candidates. Ambiguous → no action, candidates listed.
- Every decision → `memory_events` (actor `verifier`). Config `memory.healing: 'off' | 'suggest' | 'auto'`
  (proposed default `suggest`).
- Acceptance: scenario 22 + doc 08 §6 list (two "Approve" buttons → AMBIGUOUS; label changed + test id same →
  input heals, submit suggests; different row → rejected; destructive → never; hostile cloned labels → ambiguous).

### D. Dashboard (read-only)

Version compare (v3 ↔ v4 classifications) and impact view in the Memory Explorer. No write endpoints.

## Decisions to confirm before starting

1. Auto-activation of a verified candidate when it has no REMOVED/INCOMPATIBLE/AMBIGUOUS elements (A4) — or always
   operator-only?
2. `memory.healing` default: `suggest` (proposed) or `off`?
3. Run A–C as three parallel lanes in worktrees (like Phase 1) after A's matching API is fixed, or sequentially?

## Housekeeping

- Worktrees: `../tg-browser-mcp-p1-{a,b,c}` (merged, can be removed) and `../tg-browser-mcp-p2` (Phase 2, merged).
- Main checkout has a leftover `git stash` ("WIP on feat/phase1") — a duplicate early Phase 2 draft; safe to drop.
