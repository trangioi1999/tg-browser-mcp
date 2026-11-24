# Session management

A **session** = one isolated Playwright BrowserContext (own cookies, localStorage, IndexedDB, cache) + its tabs, named and namespaced by project:

```text
Project: banking-bpa
* maker     pages=2
  checker   pages=1
```

- Tools without `session` use the **active** session; the first tool call creates `default`.
- `session_create name=checker` → isolated context in the shared browser; `persistent=true` → dedicated on-disk profile (`<dataDir>/profiles/<project>/<name>`).
- `session_save` → encrypted storage state (`cookies`, `localStorage`, `IndexedDB`); `session_restore` / `session_create restore=true` recreate the context from it. Expired cookies are dropped; files older than `sessions.expirationHours` → `SESSION_EXPIRED`.
- `session_delete deleteSaved=true` removes saved state.

## Limitations

- **sessionStorage is not persisted** (browsers scope it to a tab lifetime; Playwright storage state excludes it). Apps that keep tokens only in sessionStorage need a fresh login.
- Restoring cookies does **not** guarantee the application session is still valid server-side (revocation, idle timeouts, device binding). Always verify with a snapshot.
- HttpOnly cookies are restored correctly but are never shown to the model.
- Persistent profiles cannot be opened by two browser processes at once (`BROWSER_LAUNCH_FAILED` with a lock hint).
- `browser_connect` (CDP) wraps the existing browser's default context; closing the session only disconnects.

## Isolation guarantees

Tested: different sessions in the same browser do not share cookies (`isolates sessions` test). Over HTTP transport each MCP session gets its own harness and browser.
