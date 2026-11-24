# Angular & frontend automation guide

TG Browser is framework-independent; it interacts like a user through the accessibility tree. Snapshots report detected frameworks (`Framework: Angular 20.1.0 + Angular Material`) via `ng-version` and component class markers.

## What works generically (and is tested on the fixture app)

| Pattern                                                       | How                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reactive Forms / Signal Forms                                 | `browser_fill` with `fields` (one call); validation shows as `[invalid]`, `[required]`; errors appear in the diff                                                                                                   |
| `mat-select`, PrimeNG `p-select`/`p-dropdown`/`p-multiselect` | `browser_select_option` → generic ARIA combobox adapter: opens the combobox, finds `role=option` in the `aria-controls` popup or the CDK overlay (page-wide), exact match first, lists available options on failure |
| `mat-autocomplete`, PrimeNG AutoComplete                      | editable combobox: the adapter types the value, then picks the option                                                                                                                                               |
| `mat-datepicker`, PrimeNG DatePicker                          | fill the input with the app's date format (e.g. `12/31/2026`); or open the calendar and click the day button by name                                                                                                |
| `mat-checkbox`, `mat-radio-button`, `p-checkbox`              | `browser_check`/`browser_uncheck` (native input underneath is targeted through its label)                                                                                                                           |
| `mat-dialog`, CDK overlays, PrimeNG Dialog                    | appear as `dialog "Title" [modal]` in the diff; act inside with refs                                                                                                                                                |
| `mat-table`, `p-table`                                        | `table`/`row`/`cell` with refs; `scope=<table ref>` snapshot for big tables                                                                                                                                         |
| Virtual scrolling (`cdk-virtual-scroll-viewport`)             | `browser_scroll` with the viewport as target and `direction`/`to`, then snapshot                                                                                                                                    |
| Lazy routes                                                   | `browser_wait url=/orders/**` or `text="Orders"`                                                                                                                                                                    |
| Shadow DOM (open)                                             | included in snapshots; refs work                                                                                                                                                                                    |
| Nested iframes                                                | spliced into snapshots under `iframe "title"`; refs work without switching; `browser_frame_switch` for semantic locators                                                                                            |
| Nx micro frontends / Native Federation                        | `browser_errors` highlights failed `remoteEntry`/`mf-manifest` loads and CORS errors                                                                                                                                |

## Debug checklist

1. `browser_errors` — JS exceptions (`pageerror`), console errors (deduplicated ×N), failed/4xx/5xx requests.
2. `browser_network_requests apiOnly=true status="error"` — failing API calls; `browser_network_details id=r12` for redacted headers (bodies with `network.capture.captureBodies`).
3. `browser_snapshot scope=<ref>` — is the component rendered? empty `main` usually means a rendering error.
4. `browser_performance` — LCP/FCP, slowest resources, DOM size, JS heap.
5. `browser_trace_start` / `browser_trace_stop` → `npx playwright show-trace`.

## Tips

- Give interactive elements accessible names (`aria-label`, `<mat-label>`); add `data-testid` for generated tests.
- `div (click)` without role still appears as `clickable "text"` (cursor:pointer heuristic), but prefer buttons.
- Angular change detection is async: actions wait for pending XHR/fetch (≤2s) before diffing; use `browser_wait` for longer operations.

Framework-specific adapters beyond the ARIA combobox were not added: the generic approach covered Material/PrimeNG patterns without measurable gain from special casing (see ADR-0005).
