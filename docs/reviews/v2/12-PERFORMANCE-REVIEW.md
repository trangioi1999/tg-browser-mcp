# 12 — AI Token and Performance Review

## 1. Measurements reproduced in this review

Environment: Linux container, Node 22.23.5, Chrome for Testing 158 headless, fixture app on 127.0.0.1.

### 1.1 Token benchmark (`npm run bench`, chars; tokens ≈ chars/4)

|                                                             | TG Browser (developer) |    Playwright MCP 0.0.86 |
| ----------------------------------------------------------- | ---------------------: | -----------------------: |
| 10 normal-page steps (PW: + 1 extra snapshot call it needs) |                  3,097 |    5,138 (2,046 + 3,092) |
| `navigate /large` (embeds paginated snapshot)               |                 12,029 |                      229 |
| snapshot `/large`                                           |      11,940 (page 1/9) |                  184,900 |
| **Total responses**                                         | **27,066** (≈6.8k tok) | **190,267** (≈47.6k tok) |
| Tool calls                                                  |                     12 |                       15 |
| Tool schema (`tools/list`)                                  |      31,039 (40 tools) |        21,199 (25 tools) |

Matches `docs/BENCHMARK.md` within 73 chars (navigate /login response is 74 chars shorter today). The honest notes in the README remain correct: most of the difference is pagination of one large page; per call, TG navigate/click responses are larger because they embed state.

### 1.2 Schema size per profile (`npm run schema-size`)

minimal 8 tools / 7,747 chars · developer 40 / 26,742 · testing 61 / 36,773 · full 69 / 40,545. The schema is paid **once per conversation** (and per context refresh); for a 12-step task with the developer profile it is ≈ 53 % of all tool-related characters (31,039 vs 27,066).

### 1.3 Latency (reviewer probe, medians of 3–7 runs)

| Operation                                                          | Median |
| ------------------------------------------------------------------ | -----: |
| Snapshot `/large` (1,500 links, 3,009 nodes, 9 pages at 12k chars) |  99 ms |
| Snapshot synthetic 800 forms (2,401 nodes)                         | 104 ms |
| Click by ref incl. settle + diff (`/dynamic`)                      |  99 ms |
| Click by ref with `snapshot: none`                                 |  97 ms |

Interpretation: browser-side cost is dominated by the settle floor (`domcontentloaded` wait + fixed 60 ms sleep, `action-executor.ts:120-137`), not by snapshotting. **Memory lookups cannot materially reduce latency**; their only potential benefit is tokens and fewer exploratory calls. A per-call SQLite lookup (<1 ms indexed) is negligible.

## 2. Assessment of optimization levers

| Lever                                             | Current state                                                           | Recommendation                                                                                                                                                                                                                  | Evidence needed before claiming savings                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Snapshot size limit / pagination                  | `maxChars` 12k, pages, `scope`, `interactiveOnly`                       | keep                                                                                                                                                                                                                            | —                                                                                    |
| Snapshot diffs                                    | after actions                                                           | keep; add `complete` flag; cap diff of re-rendered lists                                                                                                                                                                        | —                                                                                    |
| Tool profiles                                     | 4 static profiles                                                       | keep; add a `core` profile (~15 tools: navigate, snapshot, click, fill, select, press, wait, dialog, tabs, form_inspect, errors, screenshot, session_create/switch) as the recommended default for agents                       | schema chars and task success on bench scenarios                                     |
| Tool schema size                                  | descriptions already trimmed; targets documented in server instructions | measure every new param (`expect`, `within`); share `$defs` if the SDK supports it                                                                                                                                              | `schema-size` delta in PR template                                                   |
| Action results                                    | text, compact                                                           | add verification line (doc 04) — +20–80 chars per action                                                                                                                                                                        | bench delta                                                                          |
| Batch operations                                  | `fill fields`, workflows                                                | extend `fill` (doc 09); **do not** add a generic "batch of arbitrary actions" tool — it hides intermediate state the model needs to stay safe                                                                                   | —                                                                                    |
| Workflow reuse                                    | workflows replay with 1 call                                            | biggest real saving for repeated business processes (1 call vs N); invest here                                                                                                                                                  | measure N-step task: interactive vs replay                                           |
| Error-only reporting                              | `snapshot: 'none'` exists                                               | add `snapshot: 'auto'` (diff only if ≤ N lines else summary + hint)                                                                                                                                                             | bench                                                                                |
| Memory-aware snapshots                            | n/a                                                                     | ship behind a flag; summary line only; never replace the live snapshot                                                                                                                                                          | cold/warm/adaptive benchmark (§3)                                                    |
| Dynamic tool discovery / lazy capability exposure | n/a                                                                     | **defer**: relies on `notifications/tools/list_changed`; client support varies (several popular clients cache the tool list per session or require restart). Profiles + `tools.enabled/disabled` already provide static control | verified support matrix across Claude Code, Codex, Cursor, Gemini CLI, Kiro, VS Code |
| Configurable token budgets                        | `maxChars` global; `browser_snapshot maxChars`                          | per-call budget param on snapshot/get_text (exists); a session-level budget is not worth the complexity                                                                                                                         | —                                                                                    |

Safety constraint: optimizations must never remove the evidence needed for verification (failed requests, dialogs, `INDETERMINATE` reasons) or drop refs needed to act.

## 3. Benchmark plan for V2 (must exist before any token claim)

Scenarios on the fixture app (extended with `/virtual-table`, Material-like and PrimeNG-like forms, a changed-UI variant of `/request/create`):

| Scenario            | Variants                                           |
| ------------------- | -------------------------------------------------- |
| Cold start          | new conversation, no memory                        |
| Warm start          | memory with matching active version                |
| Changed UI          | 10→11 field deployment variant                     |
| Interactive actions | login, create, approve (maker-checker)             |
| Batch form          | 8-field form via `fill fields` vs individual fills |
| Workflow replay     | same task via `workflow_execute`                   |

Metrics: MCP tool calls; model rounds (scripted agent policy with fixed decision rules so runs are deterministic, plus an optional real-model run); schema chars; response chars and real-tokenizer tokens (record the tokenizer used); browser duration; memory lookup duration; snapshot duration; reconciliation duration; success rate; **incorrect target selections** (fixture server records which entity each mutation hit — any wrong-entity mutation fails the benchmark).

Accounting rule: report totals including extra memory/summary calls, failed actions, re-snapshots after `TARGET_CHANGED`, and requests for missing context. A memory feature that reduces chars but increases wrong-target or retry counts is a regression.
