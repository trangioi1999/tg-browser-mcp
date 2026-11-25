# 05 — Storage Architecture

## 1. Inventory of current storage (all under `dataDir`, default `~/.tg-browser`, dirs 0700)

| Data                        | Location / format                                                                                                                         | Writer                                                       | Atomic?                  | Concurrency control                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------ | -------------------------------------------------------------------------------------- |
| Workflow definitions        | `workflows/<project>/<slug>.json` (pretty JSON)                                                                                           | `WorkflowEngine.saveDefinition` (`workflow-engine.ts:89-94`) | **no** (`writeFileSync`) | none; slug collisions silently overwrite (`"Đăng nhập"` and `"dang nhap"` → same file) |
| Workflow runs / checkpoints | `runs/<project>/<runId>.json`                                                                                                             | `checkpoint()` (`:129-138`) after every step                 | **no**                   | none; `listRuns()` parses every file, one torn file throws (D9, P8)                    |
| Session storage state       | `sessions/<project>/<name>.state` AES-256-GCM (`TGS1`+iv+tag+ct)                                                                          | `SessionStore.save` (`session-store.ts:64-91`)               | yes (tmp + rename)       | none                                                                                   |
| Session metadata            | `sessions/<project>/<name>.meta.json`                                                                                                     | same                                                         | **no**                   | none                                                                                   |
| Encryption key              | `keys/session.key` (hex, 0600) or env `TG_BROWSER_SESSION_KEY`                                                                            | `getKey()` (`:45-62`)                                        | `wx` create              | — (key lives next to the data it protects)                                             |
| Browser profiles            | `profiles/<project>/<name>/` (Chromium user data dir); default session uses `browser.userDataDir`                                         | Playwright                                                   | n/a                      | Chromium's own lock (second process fails)                                             |
| Journals                    | `journal/<project>/<session>/events.jsonl` + `events.1.jsonl` (rotation at `journal.maxBytes`)                                            | `SessionJournal.write` (`session-journal.ts`)                | append                   | appends from several processes may interleave lines (acceptable for JSONL)             |
| Audit log                   | `audit/audit-YYYY-MM-DD.jsonl`                                                                                                            | `AuditLogger.record`                                         | append                   | same                                                                                   |
| Screenshots                 | `artifacts/<project>/<session>/screenshot-<ts>.<ext>`; failure shots `artifacts/runs/<runId>/failure-<step>.png` (**not project-scoped**) | executor / workflow engine                                   | n/a                      | —                                                                                      |
| Videos                      | `artifacts/<project>/<session>/videos/*.webm` (0600)                                                                                      | `SessionManager.saveVideo`                                   | n/a                      | —                                                                                      |
| Traces                      | `artifacts/<project>/<session>/trace-<ts>.zip` or caller path                                                                             | `traceStop`                                                  | n/a                      | —                                                                                      |
| Reports                     | `artifacts/<project>/reports/report-<ts>.{md,xml}` or caller path                                                                         | `writeArtifact` (tools layer)                                | no                       | —                                                                                      |
| Configuration               | `tg-browser.config.json` (cwd or `--config`); dashboard writes atomically with `.bak`                                                     | `ui/server.ts:491-529`                                       | yes                      | —                                                                                      |

The original ADR-0004 decision (files, no native modules) was right for the MVP: data is small and append-mostly, and zero native dependencies matter for offline/corporate installs. It already names `node:sqlite` as the revisit path.

## 2. Does the decision still hold for V2?

V2 adds data with **relationships, versions and queries**: pages ↔ elements ↔ versions, workflows ↔ elements/pages (impact analysis), runs ↔ steps ↔ artifacts, healing decisions. It also adds **concurrent writers**: several MCP client processes routinely share one `dataDir`, background workflows checkpoint while the dashboard reads. Problems already visible with files (D9, non-atomic writes, O(n) scans, slug collisions) would multiply.

### Options

| Criterion                                               | JSON files                       | SQLite                                                                                              | Hybrid SQLite + JSON + FS | PostgreSQL            |
| ------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------- | --------------------- |
| Offline install / corporate network                     | ✓                                | ✓ with `node:sqlite` (built in); ✗-ish with `better-sqlite3` (native prebuild download or compiler) | ✓ (`node:sqlite`)         | ✗ (server to operate) |
| Runtime deps                                            | none                             | none (`node:sqlite`)                                                                                | none                      | driver + server       |
| Win/macOS/Linux                                         | ✓                                | ✓                                                                                                   | ✓                         | ✓ (ops burden)        |
| Concurrent access (multi-process)                       | ✗ (last writer wins, torn files) | ✓ WAL, single writer, `busy_timeout`                                                                | ✓                         | ✓                     |
| Transactions                                            | ✗                                | ✓                                                                                                   | ✓ for metadata            | ✓                     |
| Indexing / search                                       | ✗ (scan)                         | ✓ (+FTS5)                                                                                           | ✓                         | ✓                     |
| Schema migrations                                       | ad hoc                           | `user_version` / migrations table                                                                   | ✓                         | ✓                     |
| Versioning                                              | manual files                     | rows                                                                                                | rows                      | rows                  |
| Workflow dependency analysis                            | scan + parse                     | SQL joins                                                                                           | ✓                         | ✓                     |
| Corruption recovery                                     | per-file, silent                 | WAL + `integrity_check`, backup API                                                                 | ✓                         | ✓                     |
| Backup / restore                                        | copy dir                         | `VACUUM INTO` / backup API + copy artifacts                                                         | ✓                         | `pg_dump`             |
| Cloudflare container (ephemeral disk, `sleepAfter 15m`) | lost on sleep                    | lost on sleep                                                                                       | lost on sleep             | external DB survives  |
| Git-friendly review of workflows                        | ✓                                | ✗ (needs export)                                                                                    | ✓ via export/import       | ✗                     |

**Recommendation: Hybrid** — SQLite for structured metadata and relationships; JSON stays the workflow _language_ and import/export format; binaries stay on the filesystem; authentication state stays in the dedicated encrypted store (unchanged). PostgreSQL is **rejected for V2** (no distributed deployment exists; the Cloudflare deployment is a single container whose state is ephemeral by design). Keep the repository interfaces narrow enough that a PostgreSQL adapter is possible later.

### Driver: `node:sqlite` vs `better-sqlite3`

- Verified locally: `node:sqlite` works unflagged on Node 22.23.5 (SQLite 3.54.1, WAL, `STRICT` tables) and prints an `ExperimentalWarning` on **stderr** (harmless for STDIO MCP; filter it at startup).
- `node:sqlite` is **not available on Node 20** (current `engines: >=20.10`). Node 20 reached EOL on 2026-04-30, so raising the floor to **Node ≥ 22.13** (first 22.x without `--experimental-sqlite`) is justified — but it is a breaking change: bump the minor version, update CI (drop 20), README, INSTALLATION, doctor check.
- `node:sqlite` API is still marked experimental/active development. Mitigate with a ≤10-method internal adapter (`open, exec, prepare/run/get/all, transaction, close`) so `better-sqlite3` can be swapped in if the built-in API changes. Do not add `better-sqlite3` as a dependency now (native module, contradicts ADR-0004's install goals).
- Other options (sql.js/wasm, LevelDB, LMDB) offer no advantage: sql.js has no multi-process locking on files; KV stores lose relational queries.

### When is SQLite justified?

Not as a standalone P0 item. P0 should make the **file** storage correct (atomic writes, resilient readers, repository interfaces). SQLite becomes justified **together with Browser Memory and run-history indexing**, i.e. Phase 1 of the roadmap.

## 3. Single source of truth per data type

| Data type                                                                  | Authoritative store (V2.0)                                      | Notes                                                                                                                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow definitions                                                       | **JSON files** (unchanged path)                                 | Git-friendly; SQLite keeps a _derived_ index (`workflow_index`, `workflow_dependencies`) keyed by file content hash, rebuilt on mismatch — never edited directly |
| Workflow definitions (V2.1, with versioning)                               | **SQLite `workflow_versions.definition_json`** (immutable rows) | files become explicit export/import with conflict detection; migration in §6                                                                                     |
| Runs + step results                                                        | SQLite                                                          | old `runs/*.json` imported once, then read-only                                                                                                                  |
| Memory (applications, pages, versions, elements, observations)             | SQLite                                                          | new                                                                                                                                                              |
| Healing decisions, memory audit events                                     | SQLite                                                          | new                                                                                                                                                              |
| Artifact metadata (path, kind, bytes, sha256, run/session link, retention) | SQLite                                                          | files stay on disk                                                                                                                                               |
| Screenshots, videos, traces, reports                                       | filesystem                                                      | unchanged layout, project-scoped (move `artifacts/runs/<runId>` under project)                                                                                   |
| Storage state + key                                                        | encrypted files (+ OS keychain later)                           | **never** in SQLite                                                                                                                                              |
| Journal, audit                                                             | JSONL append files                                              | high-rate append, operator-readable; optionally indexed later                                                                                                    |
| Configuration                                                              | `tg-browser.config.json`                                        | unchanged                                                                                                                                                        |

## 4. Schema — challenge and MVP cut

Proposed 17 tables → **9 for the first implementation**, 4 deferred, 4 rejected/merged.

| Proposed                          | Decision                               | Reason                                                                                                   |
| --------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| projects                          | MERGE into `scopes`                    | a project alone is not an isolation boundary; scope = project + application + environment + auth context |
| applications                      | MERGE into `scopes`                    | an application is an origin within a project/environment                                                 |
| pages                             | KEEP                                   |                                                                                                          |
| page_variants                     | MERGE into `page_versions.variant_key` | variants (tab, dialog, mode, role) are a dimension, not an entity                                        |
| page_versions                     | KEEP                                   |                                                                                                          |
| elements                          | KEEP                                   | stable memory ids                                                                                        |
| element_versions                  | KEEP as `element_observations`         | per page version, holds fingerprint                                                                      |
| element_locators                  | DEFER                                  | JSON column `locators` in observations until healing exists                                              |
| workflows / workflow_versions     | DEFER to V2.1                          | files remain authoritative in V2.0                                                                       |
| workflow_steps                    | REJECT                                 | derived from definition JSON; normalizing duplicates the source                                          |
| workflow_dependencies             | KEEP (derived)                         | impact analysis                                                                                          |
| workflow_runs, workflow_run_steps | KEEP                                   |                                                                                                          |
| memory_events                     | KEEP (small)                           | append-only audit of memory mutations (poisoning forensics)                                              |
| healing_history                   | DEFER                                  | until healing ships (suggest-only mode can log into `memory_events`)                                     |
| artifacts                         | KEEP                                   |                                                                                                          |

### DDL sketch (SQLite, `STRICT`, `foreign_keys=ON`, WAL)

```sql
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL) STRICT;

CREATE TABLE scopes (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  origin TEXT NOT NULL,                 -- scheme://host:port, normalized
  environment TEXT NOT NULL DEFAULT 'default',
  auth_context TEXT NOT NULL DEFAULT 'default', -- caller-declared role label, never derived from cookies
  created_at TEXT NOT NULL,
  UNIQUE (project, origin, environment, auth_context)
) STRICT;

CREATE TABLE pages (
  id INTEGER PRIMARY KEY,
  scope_id INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  route_key TEXT NOT NULL,              -- normalized path pattern (/requests/:id)
  page_key TEXT NOT NULL,               -- route_key + primary heading/landmark signature
  active_version_id INTEGER,            -- FK to page_versions (set after verification)
  created_at TEXT NOT NULL,
  UNIQUE (scope_id, page_key)
) STRICT;

CREATE TABLE page_versions (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  variant_key TEXT NOT NULL DEFAULT '', -- e.g. tab=Details|mode=edit
  shape_hash TEXT NOT NULL,             -- roles + stable keys
  label_hash TEXT NOT NULL,             -- normalized names
  build_hint TEXT,                      -- optional ng-version / bundle hash
  status TEXT NOT NULL CHECK (status IN ('observed','candidate','verified','active','archived','rejected')),
  complete INTEGER NOT NULL,            -- snapshot was not truncated/paginated/partial
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, observations INTEGER NOT NULL DEFAULT 1,
  supersedes_id INTEGER REFERENCES page_versions(id),
  UNIQUE (page_id, variant_key, shape_hash, label_hash)
) STRICT;
CREATE INDEX page_versions_page ON page_versions(page_id, status);

CREATE TABLE elements (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL UNIQUE,       -- 'el_' + random; stable across versions
  semantic_key TEXT NOT NULL,           -- strongest available identity key (see doc 07)
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (page_id, semantic_key)
) STRICT;

CREATE TABLE element_observations (
  id INTEGER PRIMARY KEY,
  element_id INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
  page_version_id INTEGER NOT NULL REFERENCES page_versions(id) ON DELETE CASCADE,
  fingerprint_json TEXT NOT NULL,       -- role, tag, inputType, keys, container, normalized name (≤ 200 chars), states subset
  locators_json TEXT NOT NULL,          -- ordered candidates
  classification TEXT CHECK (classification IN ('UNCHANGED','MODIFIED','ADDED','REMOVED','UNOBSERVED','AMBIGUOUS','INCOMPATIBLE')),
  verified_at TEXT,                     -- set only by a verified action/assertion
  UNIQUE (element_id, page_version_id)
) STRICT;

CREATE TABLE workflow_index (           -- derived from JSON files (V2.0)
  id INTEGER PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL, file TEXT NOT NULL,
  content_sha256 TEXT NOT NULL, schema_version INTEGER NOT NULL, indexed_at TEXT NOT NULL,
  UNIQUE (project, name)
) STRICT;
CREATE TABLE workflow_dependencies (
  workflow_id INTEGER NOT NULL REFERENCES workflow_index(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  element_id INTEGER REFERENCES elements(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('page','element','fills_form')),
  PRIMARY KEY (workflow_id, step_id, kind)
) STRICT;
CREATE INDEX wd_element ON workflow_dependencies(element_id);
CREATE INDEX wd_page ON workflow_dependencies(page_id);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,                  -- existing runId format
  project TEXT NOT NULL, workflow TEXT NOT NULL, workflow_sha256 TEXT,
  status TEXT NOT NULL, owner TEXT NOT NULL,      -- process/lease id (doc 14)
  started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER,
  failure_json TEXT, variables_json TEXT          -- non-secret, redacted
) STRICT;
CREATE INDEX runs_by_workflow ON workflow_runs(project, workflow, started_at DESC);

CREATE TABLE workflow_run_steps (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL, ord INTEGER NOT NULL, session TEXT NOT NULL, action TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
  verification TEXT, message TEXT, error_json TEXT,
  PRIMARY KEY (run_id, step_id)
) STRICT;

CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('screenshot','video','trace','report')),
  rel_path TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL, sha256 TEXT,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL, session TEXT, created_at TEXT NOT NULL, expires_at TEXT
) STRICT;

CREATE TABLE memory_events (
  id INTEGER PRIMARY KEY, scope_id INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  ts TEXT NOT NULL, actor TEXT NOT NULL,           -- 'observer' | 'verifier' | 'operator' | 'import'
  kind TEXT NOT NULL, subject TEXT NOT NULL, detail_json TEXT NOT NULL
) STRICT;
```

### Transaction boundaries

- One transaction per **observation** (page version upsert + element observations + memory event).
- One transaction per **run step** completion (step row + run status) — replaces per-step file checkpoint.
- One transaction per **verification** (sets `verified_at`, possibly activates a version).
- Index rebuild per workflow file is one transaction.
- `BEGIN IMMEDIATE` for writers; `busy_timeout=5000`; writes never span a browser action.

### Retention

`runs` and step rows: keep N days (default 30) or last K per workflow; artifacts follow `expires_at` (default 14 days; failures 30); `memory_events` 90 days; archived page versions keep the last 5 per page. A `tg-browser-mcp gc` command and a dashboard button run retention; never automatic deletion of active/verified versions.

### Repository interfaces (harness-facing, no SQL leaks)

```ts
interface RunRepository { create(run): void; completeStep(runId, step): void; finish(runId, result): void; get(runId): RunRecord | undefined; list(q: { project; workflow?; limit; before? }): RunSummary[]; }
interface WorkflowRepository { list(project): WorkflowSummary[]; load(project, name): Workflow; save(project, wf, { expectedSha?: string }): { sha256 }; }
interface ArtifactRepository { register(a): void; list(q): Artifact[]; expire(now): string[] /* paths */; }
interface MemoryRepository { /* doc 06 */ }
```

V2.0 implementations: `FileWorkflowRepository` (atomic write + optimistic `expectedSha`), `SqliteRunRepository`, `SqliteArtifactRepository`, `SqliteMemoryRepository`. The dashboard uses the same repositories (removes `new BrowserHarness()` per request).

## 5. Immediate file-storage fixes (P0, no SQLite needed)

1. `writeFileAtomic(path, data, mode)` helper (tmp in same dir + `fsync` + rename) for workflow definitions, run checkpoints, session meta, reports.
2. `listRuns()` skips unreadable files with a warning instead of throwing; sorts by filename timestamp before parsing; parses only `limit` files.
3. `saveDefinition()` refuses to overwrite a file whose stored `name` differs (slug collision) unless `overwrite: true`.
4. Project-scope failure screenshots.

## 6. Migration from existing JSON (runs; later workflow definitions)

| Requirement               | Design                                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backup                    | `tg-browser-mcp migrate --backup` copies `runs/` and `workflows/` to `backups/<ts>/` (and `VACUUM INTO` of an existing DB) before any write                      |
| Dry run                   | `--dry-run` parses everything, prints counts, conflicts and unreadable files, writes nothing                                                                     |
| Validation                | each run JSON parsed with a Zod `RunRecord` schema; workflows with `validateWorkflow()`; invalid items reported, not dropped silently                            |
| Idempotency               | runs keyed by `runId` (`INSERT … ON CONFLICT DO NOTHING`); workflows keyed by `(project, name, sha256)`; `schema_migrations` row records migration id + checksum |
| Conflict handling         | same `runId` with different content → keep DB row, report; workflow name collision with different sha → import as a new version (V2.1) or report (V2.0)          |
| Failure recovery          | whole migration in one transaction per project; on error roll back and leave files untouched (files are never deleted by migration)                              |
| Rollback                  | files remain authoritative until the operator runs `migrate --finalize`; before that, deleting the DB returns to file mode                                       |
| JSON export compatibility | `workflow export` writes v1 JSON when no V2 features are used, otherwise v2 with `schemaVersion: 2`; `run export` writes the legacy `RunRecord` JSON             |
