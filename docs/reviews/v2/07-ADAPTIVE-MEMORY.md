# 07 — Adaptive Memory and UI Change Detection

## 1. Classifications

| Class          | Definition                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `UNCHANGED`    | matched by a strong key or by unique semantic identity; fingerprint equal except volatile fields (states, order)                       |
| `MODIFIED`     | matched; compatible but label, required/readonly, container or locator candidates changed                                              |
| `ADDED`        | live element with no match in the previous version                                                                                     |
| `REMOVED`      | previous element with no match, **and** removal conditions (§4) hold                                                                   |
| `UNOBSERVED`   | previous element with no match where removal cannot be proven                                                                          |
| `AMBIGUOUS`    | more than one compatible live candidate, or several previous elements claim one live element                                           |
| `INCOMPATIBLE` | matched by key but role/tag/input type changed so existing actions are invalid (textbox → combobox, checkbox → switch requires review) |

## 2. Page fingerprint

Two hashes per page version, computed from the **complete** snapshot of the page scope:

- `shape_hash` = SHA-256 over the sorted multiset of `(role, tag, inputType, strongKey?, containerRole)` for interactive elements and landmarks/headings/dialogs/forms. Excludes text nodes, cell contents, option lists, values, order.
- `label_hash` = SHA-256 over the sorted multiset of normalized names of the same elements.

Normalization excludes unstable data: digits and number groups → `#`, UUID/hex ids → `:id`, dates/times → `:date`, emails → `:email`, values never included, table bodies reduced to header cells, rows/list items not counted (only "has N≥1 rows"), loading indicators (`aria-busy`, `progressbar`, skeleton classes) cause the snapshot to be marked **incomplete** rather than hashed.

`shape` equal + `label` equal → UNCHANGED fast path (no element matching). `shape` equal + `label` differs → label changes only. Otherwise full matching.

**Build metadata** (`ng-version`, `<meta name="version">`, hashed main bundle file name from `<script src>`) is stored as `build_hint`. It is an optional _invalidation signal_ (a change triggers revalidation of key elements even if hashes match because elements may be lazy) — never a requirement and never proof of compatibility.

## 3. Deterministic element matching (before any fuzzy step)

Matching runs **within the same page and variant key**, container by container (forms, dialogs, regions), in passes; each pass only considers still-unmatched elements:

| Pass | Key                                                                                                    | Accept when                                                  |
| ---- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 1    | `data-testid` (+ role family)                                                                          | exactly one live element with that key                       |
| 2    | `formcontrolname` / `name` attribute within same form identity                                         | unique                                                       |
| 3    | stable-looking `id` (not matching generated patterns `mat-*-\d+`, `cdk-*`, `ng-*`, `:r\d+:`, long hex) | unique                                                       |
| 4    | `(role, normalized name, container)`                                                                   | unique on both sides                                         |
| 5    | `(role, normalized label)` page-wide                                                                   | unique on both sides                                         |
| 6    | structural: same container, same role, same ordinal among same-role siblings, compatible input type    | **never auto-accepted**; produces `AMBIGUOUS`/candidate only |

Hard rejection rules (independent of any score): role family change for mutating use; input type incompatibility (date ↔ text allowed only as `MODIFIED` + review; checkbox ↔ textbox rejected); different form identity; different business row key; element inside a different dialog/region; candidate hidden or disabled where previous was enabled (→ `MODIFIED` + review).

Ambiguity rules: if a pass yields >1 candidate → `AMBIGUOUS` and stop matching that element (no lower pass may "resolve" it); if two previous elements map to one live element → both `AMBIGUOUS`.

A **confidence score** is optional and only orders candidates for display to a human/AI. It is never the acceptance criterion; acceptance is "passes 1–5 unique + no rejection rule".

## 4. Removed vs temporarily absent

An unmatched previous element is `REMOVED` only if **all** hold; otherwise `UNOBSERVED`:

1. both snapshots are `complete` (no node cap, no depth cap, no pagination slice, no skipped frames, not `aria-busy`);
2. same `variant_key` (active tab, open dialog, form mode, expanded sections);
3. its container was rendered in the new snapshot (container matched);
4. same `auth_context` and environment (permissions and feature flags differ per role/tenant);
5. absent in **≥ 2 complete observations** of the new version (e.g. two snapshots or two sessions) — guards against loading states and A/B flags;
6. not inside a virtualized/paginated container (detected by `aria-rowcount` > rendered rows, `cdk-virtual-scroll-viewport`, pagination controls).

Conditional fields, tabs, dialogs, lazy tabs, pagination and virtual scrolling therefore produce `UNOBSERVED`, not `REMOVED`. Variant keys are built from observable state: selected `tab` names, open `dialog` names, `aria-expanded` sections, URL query mode params (`?mode=edit`).

## 5. Mandatory scenario: 10 fields → 11 fields

Previous verified version v3 (form "Request"): F1…F10. New deployment: F1–F6 preserved, F7–F9 modified, F10 removed, N1–N2 added (N2 required).

| Step                   | Mechanism                                                                                                                                                  | Result                                                                                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Detect new structure | `shape_hash`/`label_hash` differ from v3 on a complete snapshot                                                                                            | adaptive mode, candidate v4 (status `candidate`)                                                                                                                                                                                                  |
| 2 Match unchanged      | passes 1–2 (`formcontrolname`) match F1–F6                                                                                                                 | `UNCHANGED` ×6                                                                                                                                                                                                                                    |
| 3 Identify modified    | F7 label "Amount" → "Amount (VND)" same key → `MODIFIED`; F8 becomes required → `MODIFIED` (+ `required`); F9 textbox → combobox same key → `INCOMPATIBLE` | 2 modified, 1 incompatible                                                                                                                                                                                                                        |
| 4 Identify added       | N1, N2 unmatched live                                                                                                                                      | `ADDED` ×2; N2 flagged `required`                                                                                                                                                                                                                 |
| 5 Removed vs hidden    | F10 unmatched; removal conditions checked; first observation → `UNOBSERVED`; after a second complete observation in the same variant → `REMOVED`           | 1 unobserved → removed                                                                                                                                                                                                                            |
| 6 Workflow mappings    | impact analyzer (doc 10) on workflows depending on page / elements                                                                                         | workflows filling F9 → `BROKEN` (incompatible); workflows filling F10 → `BROKEN`; all workflows that submit this form → `NEEDS_INPUT` (N2 required, no value); F7/F8 users → `NEEDS_REVALIDATION`; workflows only reading the page → `COMPATIBLE` |
| 7 Candidate version    | v4 rows written in one transaction; v3 stays `active`                                                                                                      |                                                                                                                                                                                                                                                   |
| 8 Validate candidate   | a verified action/assertion on v4 elements (e.g. a successful `form_fill` + `VERIFIED` save in a test environment), or operator approval in the dashboard  | v4 `verified`                                                                                                                                                                                                                                     |
| 9 Activate             | `activateVersion` sets `pages.active_version_id`, v3 → `archived`, `memory_event` written                                                                  |                                                                                                                                                                                                                                                   |
| 10 Audit               | v3 retained (last 5 versions), diff v3↔v4 queryable                                                                                                        |                                                                                                                                                                                                                                                   |

Note: 11 live fields = 6 + 3 + 2; the classifier reports **6 UNCHANGED, 2 MODIFIED, 1 INCOMPATIBLE, 2 ADDED, 1 REMOVED (after confirmation)**.

## 6. Calibration benchmark

Matching must be benchmarked before being trusted, using generated fixture variants with ground truth:

- Base corpus: fixture forms (login, request create, approval table, dialogs, tabs, iframes, shadow DOM) + synthetic Material-like and PrimeNG-like markup.
- Mutation operators: rename label, change/remove test id, reorder, wrap in new container, duplicate a field into another form, toggle required, change input type, hide conditionally, move into tab, paginate/virtualize, truncate snapshot, inject hostile labels.
- Metrics per operator: auto-match precision (**target 100 %**; any wrong auto-match is a release blocker), auto-match recall, `AMBIGUOUS` rate, false `REMOVED` rate (target 0 with removal conditions), runtime per page.
- Run in CI as a unit-level suite on serialized snapshots (fast, no browser) plus a small browser suite on fixtures.

## 7. What not to build

- No ML/embedding similarity, no LLM in the harness for matching.
- No automatic activation of candidate versions based on similarity alone.
- No page-content storage to "explain" changes — the diff of fingerprints is the explanation.
