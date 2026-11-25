# 09 — Smart Form Engine

## 1. What `fill_form` does today

`browser_fill` with `fields` → `ActionExecutor.fillForm()` (`action-executor.ts:525-555`). For each field, sequentially: resolve target → if boolean `check/uncheck`; else if native `<select>` → `selectOption({label})` then by value; else if `role=combobox && !editable` → generic ARIA adapter (`combobox.ts`); else `el.fill(value)`.

| Capability                                                 | Status                                                                                             | Evidence / gap                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Batch filling (one call, ≤ 50 fields)                      | ✓                                                                                                  | `page-tools.ts:178-181`                |
| Text input, textarea, contenteditable                      | ✓                                                                                                  | Playwright `fill`                      |
| Native select                                              | ✓ (label, then value)                                                                              | `:539-543`                             |
| Custom non-editable combobox (mat-select / p-select style) | ✓ on hand-written ARIA fixture                                                                     | adapter; unverified on real frameworks |
| **Editable combobox / autocomplete**                       | ✗ in `fillForm`: text is typed but **no option is selected** (`browser_select_option` does select) | `:544` requires `!editable`            |
| Checkbox / switch                                          | ✓ via boolean                                                                                      | `:535-538`                             |
| Radio group by value                                       | ✗ (each radio must be targeted with `true`; `false` on a radio throws)                             | —                                      |
| Date picker                                                | text only (app format); calendar interaction not supported                                         | doc ANGULAR.md                         |
| Dependent fields                                           | partly: semantic targets wait for attachment; refs for fields appearing later don't exist          | —                                      |
| Required fields                                            | not checked; no "missing required" report                                                          | —                                      |
| Disabled / read-only fields                                | not pre-checked → Playwright waits the full timeout (30 s) then fails                              | —                                      |
| Validation messages                                        | only indirectly through the post-action diff                                                       | —                                      |
| Partial completion                                         | **not reported**: an exception on field k loses the list of fields 1…k-1 already filled            | D21                                    |
| Preserve existing data                                     | no (always replaces)                                                                               | —                                      |
| Combobox option choice                                     | exact match first, then **substring match, first option clicked**                                  | D18, `combobox.ts:55,73`               |

## 2. Proposed enhancement (extend, don't multiply tools)

### 2.1 Extend `browser_fill` (no new tool)

```ts
fields: Array<Target & { value: string | boolean | string[]; mode?: 'replace' | 'ifEmpty' }>
options?: { continueOnError?: boolean; verify?: boolean /* read back */; within?: Target /* form scope */ }
```

Result: per-field status `filled | skipped(ifEmpty) | failed(code) | not_found | disabled | readonly`, a read-back check (`inputValue` / `aria-valuetext` / selected option text; sensitive values compared but never echoed), validation messages that appeared, and the overall outcome (doc 04: `VERIFIED` when all read-backs match and no new `invalid` states).

Behaviour changes: pre-check enabled/editable (fail fast, `retryable:false`); editable combobox → type + pick exact option; radio group target (`role=radiogroup` + value) selects by option name; combobox substring fallback only when exactly one option contains the text, else `ELEMENT_AMBIGUOUS` with candidates.

### 2.2 One new inspection tool: `browser_form_inspect` (developer profile)

Returns the semantic schema of a form (scoped by `within` or the single form on the page):

```text
Form "Request form" [ref=e22] · 7 fields · 2 required missing
- textbox "Customer Name" [required] [ref=e23] key=formcontrolname:customer (empty)
- combobox "Request Type" [required] [ref=e24] options(4): Loan, Card, Account, Other (empty)
- combobox "Priority" [ref=e25]: "Normal"
- textbox "Amount (VND)" [ref=e26] [invalid] message: "Must be greater than 0"
- checkbox "Urgent" [ref=e27]
- button "Submit" [disabled] [ref=e29]
```

`form_validate`, `form_get_missing`, `form_compare` and `form_verify` from the proposal become **options/sections** of `form_inspect` (`include: ['missing','validation','options']`) and of `browser_fill` (`verify`), not separate tools. `form_compare` against memory belongs to the memory summary (doc 06). Net tool count +1. Options lists are capped (≤ 20 shown, count reported) and never include sensitive values.

### 2.3 Data mapping

Mapping supplied data to fields is done by **the AI** (it understands intent) using the inspect output; the harness offers deterministic mapping only by exact key (`formcontrolname`/`name`/test id/label) when the caller passes `{ key: value }` objects. No fuzzy/LLM mapping in the harness.

## 3. Framework compatibility

| Framework                                                                                           | Generic path expected to work                                                   | Needs fixture proof                                                 |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Angular Material (mat-form-field, mat-select, mat-autocomplete, mat-datepicker, mat-checkbox/radio) | inputs, mat-select (role=combobox + listbox in CDK overlay), checkbox via label | autocomplete in `fill`, datepicker calendar, `mat-chip-grid`        |
| Angular Reactive Forms / Signals / Signal Forms                                                     | DOM + ARIA reflect state (`aria-invalid`, `required`)                           | validation message association (`mat-error` via `aria-describedby`) |
| PrimeNG (p-select, p-multiselect, p-autocomplete, p-datepicker, p-checkbox)                         | p-select via ARIA                                                               | overlay `appendTo=body` lookups, multiselect chips, datepicker      |
| Custom enterprise components                                                                        | ARIA-compliant ones                                                             | non-ARIA widgets (div soup) → `clickable` heuristic only            |
| Micro frontends (Module/Native Federation)                                                          | same document → same behaviour; iframes → refs work                             | shadow-DOM-wrapped remotes with closed roots → unsupported          |

Per ADR-0005, add framework adapters **only** when a fixture demonstrates generic failure. The current fixture has no Angular/PrimeNG markup, so the first task is to add realistic static fixtures (built output of small Material/PrimeNG demo forms checked into `tests/fixtures`, no network) and measure.

## 4. Tests

Batch fill with one disabled field (fail fast, partial result lists the others); `ifEmpty` preserves existing values; autocomplete in `fields` selects the option; radio group by value; combobox substring ambiguity → error; required-missing report after partial fill; validation message association; dynamic dependent field appears after selecting "Loan"; sensitive read-back never echoed.
