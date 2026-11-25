# 08 — Self-Healing Element Resolution

## 1. Verdict

**Worth implementing only as "suggest, then verify read-only, then act through the normal resolver" — not as transparent auto-healing.** The current resolver (`target.ts:75-115`) is a good base: it already refuses ambiguity for semantic locators. What healing adds is _candidate generation from memory_ when a recorded locator fails. Auto-acting on a healed candidate is acceptable only for low-impact intents with strong-key matches.

The proposed lifecycle (12 steps) is sound; the critical changes are steps 8 (policy), 10 (verification must not mean "try the action"), and 12 (activation requires verified outcome, never just a successful click).

## 2. Distinguish four responsibilities

| Responsibility                 | Question it answers                                                               | Owner module                                                  | Who may approve                                               |
| ------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| Locator healing                | "The locator for _this same element_ stopped matching; which live element is it?" | `harness/target-healer.ts` (inside resolution)                | policy (auto for low impact) / AI with fresh snapshot / human |
| Element mapping reconciliation | "Page changed; which old elements map to which new ones?"                         | `memory/reconciler.ts` (doc 07)                               | verification outcomes / operator                              |
| Workflow migration             | "Given the new mapping, how should workflow steps change?"                        | `workflow/migrator.ts` (produces candidate workflow versions) | human review (dashboard)                                      |
| Business logic change          | "The process itself changed (new required field, new approval step)"              | none — out of scope for automation                            | product owner                                                 |

They should be **separate modules** sharing the fingerprint/matching functions; mixing them is how "healing" silently changes workflow intent.

## 3. Lifecycle (revised)

```mermaid
flowchart TD
  A[locator fails or guard reports TARGET_CHANGED] --> B[load active page version for scope + page key]
  B --> C[collect live candidates: same role family, same container/form, visible]
  C --> D[apply hard rejection rules doc 07 §3]
  D --> E{unique candidate via strong key or unique semantic identity?}
  E -- no --> F[report AMBIGUOUS / NOT_FOUND with ≤5 candidates + context; no action]
  E -- yes --> G{business identity equal? row key / form identity}
  G -- no --> F
  G -- yes --> H{healing permitted for intent? §4}
  H -- no --> I[return HEALING_SUGGESTED: candidate locator + evidence; caller must re-target]
  H -- yes --> J[read-only verification: describe(), isVisible, isEnabled, input type, label]
  J --> K[act through normal resolver with candidate]
  K --> L[action outcome VERIFIED?]
  L -- yes --> M[record healing decision; mark candidate verified; propose locator update]
  L -- no --> N[record failed healing; do not update]
```

## 4. Healing policy by intent

| Intent                                                                      | Auto-use healed candidate?                                                                      | Conditions                                                     |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Read-only (get_text, assert, wait, screenshot of element)                   | yes                                                                                             | unique, compatible; result annotated `healed: true`            |
| Input (fill, select, check)                                                 | yes only with strong-key match (test id / `formcontrolname` / `name`) in the same form identity | otherwise `HEALING_SUGGESTED`                                  |
| Navigation (link click)                                                     | yes if `href` path equal (normalized)                                                           | otherwise suggest                                              |
| Non-idempotent (submit, approve, reject, save, click on buttons in general) | **never**                                                                                       | always suggest; AI must take a fresh snapshot and act on a ref |
| High-impact (destructive patterns, payment, transfer)                       | **never**                                                                                       | suggest + approval policy still applies when the AI re-targets |

The system must never: click the first match; accept a different business entity; change workflow intent; drop required steps; invent values for new required fields; execute a destructive action to "test" a candidate; treat a successful click as proof that healing was correct (proof = `VERIFIED` outcome with an expectation tied to the step's intent).

## 5. Recording and activation

- Every healing decision → `memory_events` (V2.0) / `healing_history` (V2.1): old locator, candidate, evidence, policy decision, outcome, actor.
- A healed locator is **proposed** to the workflow as a candidate version (doc 10); it is activated automatically only for read-only/input-with-strong-key steps after ≥ 2 verified runs, otherwise by human review.
- Generated Playwright tests use the active workflow version only.

## 6. Tests

Ambiguous candidates (two "Approve" buttons after label change) → `AMBIGUOUS`, no action; changed label + unchanged test id → input heals automatically, submit returns `HEALING_SUGGESTED`; changed test id + unchanged label in same form → unique semantic match heals for read-only only; candidate in a different row → rejected; destructive candidate → never auto; healing on a hostile page that clones labels → ambiguous, no action.
