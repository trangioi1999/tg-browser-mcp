# Configuration

Sources (lowest → highest precedence): built-in defaults < config file (`--config`, else `./tg-browser.config.json` or `./.tg-browser.json`) < environment (`TG_BROWSER_*`) < CLI flags. Invalid configs fail fast with `CONFIG_INVALID` and the offending path. Full example: [`tg-browser.config.example.json`](../tg-browser.config.example.json).

## Environment variables

| Variable                                             | Effect                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `TG_BROWSER`                                         | browser shortcut (chrome, edge, chromium, firefox, webkit)                 |
| `TG_BROWSER_HEADLESS`                                | `true`/`1`                                                                 |
| `TG_BROWSER_EXECUTABLE`                              | browser executable path                                                    |
| `TG_BROWSER_CDP_ENDPOINT`                            | default CDP endpoint                                                       |
| `TG_BROWSER_PROFILE`                                 | tool profile                                                               |
| `TG_BROWSER_PROJECT`                                 | project namespace                                                          |
| `TG_BROWSER_DATA_DIR`                                | data directory                                                             |
| `TG_LOG_LEVEL`                                       | log level (stderr)                                                         |
| `TG_BROWSER_SESSION_KEY`                             | 64 hex chars: session-state encryption key (instead of the local key file) |
| `TG_BROWSER_TOKEN` (name configurable)               | bearer token for HTTP transport                                            |
| `TG_SECRET_<NAME>`                                   | values for `${secret.NAME}` in workflows                                   |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` | used in `network.mode=system`                                              |

## Sections

| Key                                                                | Default                                       | Notes                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`                                                          | `default`                                     | Namespace for sessions, workflows, runs                                                                                                                                                                   |
| `dataDir`                                                          | `~/.tg-browser`                               | Created with mode 0700                                                                                                                                                                                    |
| `browser.engine` / `channel`                                       | `chromium` / `chrome`                         | `channel: null` = Playwright Chromium; `msedge`, `chrome-beta`…                                                                                                                                           |
| `browser.headless`                                                 | `false`                                       |                                                                                                                                                                                                           |
| `browser.persistent`, `userDataDir`                                | `false`, `~/.tg-browser/profiles/default`     | Dedicated automation profile for the default session — never your personal profile                                                                                                                        |
| `browser.timeout` / `navigationTimeout`                            | 30000                                         | ms                                                                                                                                                                                                        |
| `browser.args`                                                     | `[]`                                          | Security-weakening flags are rejected                                                                                                                                                                     |
| `browser.cdpEndpoint`, `allowRemoteCdp`                            | `null`, `false`                               |                                                                                                                                                                                                           |
| `network.*`                                                        | see [PROXY.md](PROXY.md)                      | `tls.verify` must stay `true`                                                                                                                                                                             |
| `network.capture`                                                  | 500 requests, 300 console, bodies off         | Ring buffers per session                                                                                                                                                                                  |
| `security.*`                                                       | see [SECURITY.md](SECURITY.md)                |                                                                                                                                                                                                           |
| `security.fileAccess.allowedRoots`                                 | cwd + `dataDir`                               | Roots for files the agent **reads** (uploads)                                                                                                                                                             |
| `security.fileAccess.writeRoots`                                   | `<dataDir>/artifacts`                         | Roots for agent-chosen output `path`s (screenshot, trace, test_generate, test_report); cwd is never writable implicitly                                                                                   |
| `security.fileAccess.allowOverwrite`                               | `false`                                       | Allow output paths to replace existing regular files (symlinks are never followed)                                                                                                                        |
| `workflows.allowInlineSecrets`                                     | `false`                                       | Let workflow definitions supplied by the model (`workflow_create`, `workflow_validate`, `workflow_execute` with `definition`) use `${secret.X}`; executing saved workflows and SDK callers are unaffected |
| `tools.profile` / `enabled` / `disabled`                           | `developer`                                   | Only enabled tools are advertised                                                                                                                                                                         |
| `snapshot.maxChars` / `maxDepth` / `maxTextLength` / `includeText` | 12000 / 40 / 80 / true                        | Response budgets                                                                                                                                                                                          |
| `output.screenshots`                                               | `inline`                                      | `inline` (MCP image), `file` (path only), `both`                                                                                                                                                          |
| `output.verbose`                                                   | `false`                                       | JSON ActionResult instead of compact text                                                                                                                                                                 |
| `sessions.expirationHours`, `encrypt`                              | 168, true                                     |                                                                                                                                                                                                           |
| `http.*`                                                           | 127.0.0.1:8931, token from `TG_BROWSER_TOKEN` | Optional transport                                                                                                                                                                                        |

## Journal and video recording

| Field              | Default   | Meaning                                                                            |
| ------------------ | --------- | ---------------------------------------------------------------------------------- |
| `journal.enabled`  | `true`    | Persist redacted per-session lifecycle, errors, artifacts and workflow events      |
| `journal.maxBytes` | `5000000` | Rotation threshold per file (1024–5000000); retain current + one previous file     |
| `recording.video`  | `off`     | `off`, `on`, or `retain-on-failure`                                                |
| `recording.size`   | omitted   | Optional `{ width, height }` in pixels; Playwright chooses dimensions when omitted |

`session_create.recordVideo` overrides the video mode for one session (`true`: always retain; `false`: off).
Failure retention considers action and workflow failures; videos finalize when pages/contexts close.
Existing CDP contexts cannot have recording enabled retroactively. See [Dashboard](DASHBOARD.md) for storage,
privacy and retention details. `tg-browser-mcp ui` edits the same config with validation and a `.bak` backup;
restart MCP clients to apply changes. Proxy credential fields are environment variable **names**, never values.

## Storage and JSON run migration (0.2)

Node.js **22.13 or newer** is required. New installations store run checkpoints
and artifact metadata in `dataDir/storage.sqlite` (0600). SQLite uses WAL,
a 5-second busy timeout and versioned schema migrations. Each checkpoint is one
atomic write; no transaction spans a browser action. Workflow definitions remain
atomic JSON files; artifact binaries remain project-scoped files. Authentication
state and encryption keys stay in their dedicated stores. Resolved
`TG_SECRET_*` values and sensitive fields are redacted before persistence.

Existing `runs/<project>/*.json` remain readable until finalization. While a
legacy runs directory exists and migration is not finalized, it takes precedence
and new checkpoints are also written there to preserve rollback. Fresh stores
write only SQLite. Stop writers during migration/finalization and rollback.

```sh
tg-browser-mcp migrate --config ./tg-browser.config.json --dry-run
tg-browser-mcp migrate --config ./tg-browser.config.json --backup
tg-browser-mcp migrate --config ./tg-browser.config.json --finalize
```

Dry run validates every run and workflow, reports counts, unreadable paths and
conflicts, and does not create a database or backup. Backup copies runs and
workflows under `dataDir/backups/<timestamp>-<id>/` before import, plus a consistent
`VACUUM INTO` snapshot of an existing database. Import is transactional per project
and idempotent by project/run ID. Conflicting DB records are kept and reported;
invalid files are reported. Either condition prevents finalization and makes the
CLI exit 1. No legacy files are deleted. Review conflicting records and correct
or move invalid legacy files before retrying.

Before finalization, rollback by stopping all processes and moving
`storage.sqlite`, `storage.sqlite-wal` and `storage.sqlite-shm` together out of
dataDir. The retained JSON checkpoints remain usable, and the next start can
read them. A subsequent migration rebuilds the database. Restore a backup's runs
and workflows if the files themselves need rollback. After finalization, new
writes are SQLite-only: restoring an older backup loses later writes, so first
preserve the current database and artifact files. Never delete WAL files from a
running database. Keep backups private; legacy files may predate redaction.

### Core tool profile (TGB-017)

Set `tools.profile: "core"` (or `TG_BROWSER_PROFILE=core`) for a compact agent tool set:
`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`,
`browser_select_option`, `browser_press_key`, `browser_wait`, `browser_dialog`,
`browser_tabs`, `browser_errors`, `browser_screenshot`, `session_create`, and
`session_switch`. Existing profiles and the `developer` default are unchanged.
`tools.enabled` adds tools and `tools.disabled` takes precedence. Form inspection
is planned for Phase 4 and is not registered by this profile yet.

Snapshots expose `snapshot.complete` in the SDK and `Complete: true/false` in
formatted output. False means collection or presentation was partial: node/depth
limits, text clipping, missing frames, scoped or interactive-only collection, or
pagination. True describes the currently observable page, not hidden content,
unvisited lazy tabs, or inaccessible closed shadow roots.
