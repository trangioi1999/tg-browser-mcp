# Token benchmark

`npm run build && npm run bench` runs the same scenario against TG Browser MCP and `@playwright/mcp` (0.0.86, `--headless --isolated --browser chrome`) over STDIO with the official MCP client, on the bundled fixture app. Character counts are exact; tokens are estimated as chars/4.

Scenario: navigate /login → type username → type password → click Sign in → fill Customer Name → select Request Type → click Submit → navigate /dynamic → click Increment ×2 → navigate /large (1,500 links) → snapshot.

Result (2026-11-24, macOS, Chrome 158, TG profile `developer`):

| Step                          |      TG Browser chars |    Playwright MCP chars |
| ----------------------------- | --------------------: | ----------------------: |
| navigate /login               |                   629 |                     229 |
| fill username                 |                   135 |                     102 |
| fill password                 |                   136 |                     105 |
| click sign in                 |                   819 |                     259 |
| fill customer                 |                   142 |                     106 |
| select type                   |                   145 |                     258 |
| click submit                  |                   337 |                     258 |
| navigate /dynamic             |                   564 |                     235 |
| click increment 1             |                   132 |                     247 |
| click increment 2             |                   131 |                     247 |
| navigate /large               |                 12029 |                     229 |
| snapshot /large               |                 11940 |                  184900 |
| snapshot                      |                     — |                    3092 |
| **Total responses**           | **27139** (~6785 tok) | **190267** (~47567 tok) |
| Tool calls                    |                    12 |                      15 |
| Tools advertised              |                    40 |                      25 |
| Tool schema (tools/list JSON) |     31039 (~7760 tok) |       21199 (~5300 tok) |

Response size ratio TG/PW: 0.14

Tool schema sizes per TG profile (`npm run schema-size`, Zod JSON Schema; the SDK's `tools/list` adds a little):

| Profile   | Tools |  chars |
| --------- | ----: | -----: |
| minimal   |     8 |  7,747 |
| developer |    40 | 26,742 |
| testing   |    61 | 36,682 |
| full      |    69 | 40,454 |

## Interpretation

- Normal pages (all steps except /large): TG 3,169 chars vs Playwright MCP 5,138 (≈38% less), with 12 vs 15 calls — Playwright MCP 0.0.86 returns no snapshot on navigate/click in this mode, so the agent issues extra `browser_snapshot` calls; TG returns a full snapshot after navigation and a diff after actions.
- Per-call, TG navigate/click responses are larger (they embed state); fills/selects/clicks without visible change are similar.
- The 1,500-link page dominates the total: TG returns page 1 of N within `snapshot.maxChars` (12k) and tells the agent how to page or scope; Playwright MCP returns the full 185k-char tree. If an agent needs the whole list, paging costs about the same total.
- TG's `developer` schema is ~46% larger than Playwright MCP's default (more tools). Use `minimal` (≈7.7k chars) or disable tools to go below it.

No other claims are made; re-run the script to reproduce on your machine.
