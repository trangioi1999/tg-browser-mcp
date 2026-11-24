# Workflow guide

Workflows are declarative JSON, executed by the `WorkflowEngine` (`workflow_execute`, `test_execute`, SDK). Complete example: [examples/workflows/maker-checker.json](../examples/workflows/maker-checker.json) — tested end-to-end and converted into a passing Playwright test.

```json
{
  "name": "Maker Checker Workflow",
  "variables": { "BASE_URL": "http://127.0.0.1:4321" },
  "sessions": { "maker": {}, "checker": { "restore": false } },
  "steps": [
    { "id": "login", "session": "maker", "action": "navigate", "input": { "url": "${BASE_URL}/login" } },
    {
      "id": "creds",
      "session": "maker",
      "action": "fill_form",
      "input": {
        "fields": [
          { "label": "Username", "value": "maker" },
          { "label": "Password", "value": "${secret.MAKER_PASSWORD}" }
        ]
      }
    },
    { "id": "go", "session": "maker", "action": "click", "input": { "role": "button", "name": "Sign in" } },
    {
      "id": "id",
      "session": "maker",
      "action": "extract",
      "extract": {
        "variable": "REQUEST_ID",
        "from": "text",
        "target": { "testId": "request-id" },
        "pattern": "(REQ-\\d+)"
      }
    },
    {
      "id": "approve",
      "session": "checker",
      "action": "click",
      "input": { "role": "button", "name": "Approve ${REQUEST_ID}" },
      "dependsOn": ["id"]
    },
    {
      "id": "check",
      "session": "maker",
      "action": "assert",
      "assert": { "type": "text", "target": { "testId": "request-status" }, "equals": "Approved" }
    }
  ]
}
```

## Step fields

| Field                        | Meaning                                                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                         | unique step id                                                                                                                                                                                          |
| `session`                    | session name (created automatically, isolated)                                                                                                                                                          |
| `action`                     | navigate, click, double_click, fill, fill_form, type, press, select, check, uncheck, hover, wait, assert, extract, screenshot, snapshot, dialog, save_session, new_tab, switch_tab                      |
| `input`                      | action input; targets use the same fields as the tools (`role`+`name`, `label`, `testId`, `placeholder`, `text`, `selector`)                                                                            |
| `dependsOn`                  | earlier steps that must have passed, else this step is skipped                                                                                                                                          |
| `when`                       | condition: `${VAR}`, `!${VAR}`, `${VAR} == 'x'`, `${VAR} != 'x'` (no eval)                                                                                                                              |
| `retry`                      | `{ attempts, delayMs }` — **only** for idempotent actions (navigate, fill, select, check, wait, assert, extract…) unless `idempotent: true`. Clicks/typing/submissions are never retried automatically. |
| `timeout`, `continueOnError` | per-step limits / keep going                                                                                                                                                                            |
| `extract`                    | store text/value/attribute/url/title (+regex) in a variable                                                                                                                                             |
| `assert`                     | visible, hidden, text, value, url, title, count, attribute, enabled, disabled, checked, no_console_errors, no_failed_requests (auto-retry until `timeout`, default 5s)                                  |

Variables: workflow `variables` < run-time `variables`; `${secret.NAME}` reads `TG_SECRET_NAME` and is masked as `[secret]` everywhere.

## Execution semantics

- Steps run sequentially; sessions keep state between steps (cross-user flows).
- On failure: screenshot (`<dataDir>/artifacts/runs/<runId>/failure-<step>.png`), URL, recent console errors and failed requests are attached to the run.
- Checkpoints: the run record is written after each step (`<dataDir>/runs/<project>/<runId>.json`); `startAt` resumes from a step when the sessions are already in the right state.
- Cancellation: `workflow_cancel runId=…` (or the MCP request's abort signal).
- `background: true` returns a run id immediately; poll `workflow_status`.

## Recording and test generation

```text
workflow_record_start name="Approve flow" sessions=["maker","checker"]
… normal browser_* actions …
workflow_record_stop            → saved workflow (refs converted to semantic locators, secrets → ${secret.X})
test_generate name="Approve flow" path="./e2e/approve.spec.ts"
test_execute names=["Approve flow"]   → Markdown + JUnit reports in <dataDir>/artifacts/reports
```

Generated specs use one `browser.newContext()` per session, semantic locators, `test.step` per workflow step, and read variables/secrets from env (`BASE_URL`, `TG_SECRET_*`).
