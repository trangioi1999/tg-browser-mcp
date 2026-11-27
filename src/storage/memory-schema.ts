/**
 * Schema migration 2: Browser Memory (observe-only) and the derived workflow dependency index
 * (docs/reviews/v2/05-STORAGE-ARCHITECTURE.md, 06-BROWSER-MEMORY.md). Applied once; never edit.
 * No column holds field values, typed input, cookies, table cell data or page free text.
 */
export const MEMORY_SCHEMA = `
CREATE TABLE scopes (
 id INTEGER PRIMARY KEY,
 project TEXT NOT NULL,
 origin TEXT NOT NULL,
 environment TEXT NOT NULL DEFAULT 'default',
 auth_context TEXT NOT NULL DEFAULT 'default',
 created_at TEXT NOT NULL,
 UNIQUE (project, origin, environment, auth_context)
) STRICT;
CREATE TABLE pages (
 id INTEGER PRIMARY KEY,
 scope_id INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
 route_key TEXT NOT NULL,
 page_key TEXT NOT NULL,
 active_version_id INTEGER,
 created_at TEXT NOT NULL,
 UNIQUE (scope_id, page_key)
) STRICT;
CREATE INDEX pages_route ON pages(scope_id, route_key);
CREATE TABLE page_versions (
 id INTEGER PRIMARY KEY,
 page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 version_no INTEGER NOT NULL,
 variant_key TEXT NOT NULL DEFAULT '',
 shape_hash TEXT NOT NULL,
 label_hash TEXT NOT NULL,
 build_hint TEXT,
 status TEXT NOT NULL CHECK (status IN ('observed','candidate','verified','active','archived','rejected')),
 complete INTEGER NOT NULL,
 element_count INTEGER NOT NULL,
 capped INTEGER NOT NULL DEFAULT 0,
 first_seen_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL,
 observations INTEGER NOT NULL DEFAULT 1,
 verified_at TEXT,
 supersedes_id INTEGER REFERENCES page_versions(id) ON DELETE SET NULL,
 UNIQUE (page_id, variant_key, shape_hash, label_hash),
 UNIQUE (page_id, version_no)
) STRICT;
CREATE INDEX page_versions_page ON page_versions(page_id, status);
CREATE TABLE elements (
 id INTEGER PRIMARY KEY,
 page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 memory_id TEXT NOT NULL UNIQUE,
 semantic_key TEXT NOT NULL,
 role TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE (page_id, semantic_key)
) STRICT;
CREATE TABLE element_observations (
 id INTEGER PRIMARY KEY,
 element_id INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
 page_version_id INTEGER NOT NULL REFERENCES page_versions(id) ON DELETE CASCADE,
 fingerprint_json TEXT NOT NULL,
 fingerprint_hash TEXT NOT NULL,
 locators_json TEXT NOT NULL,
 classification TEXT CHECK (classification IN ('UNCHANGED','MODIFIED','ADDED','REMOVED','UNOBSERVED','AMBIGUOUS','INCOMPATIBLE')),
 verified_at TEXT,
 UNIQUE (element_id, page_version_id)
) STRICT;
CREATE INDEX element_observations_version ON element_observations(page_version_id);
CREATE TABLE memory_events (
 id INTEGER PRIMARY KEY,
 project TEXT NOT NULL,
 scope_id INTEGER REFERENCES scopes(id) ON DELETE SET NULL,
 ts TEXT NOT NULL,
 actor TEXT NOT NULL CHECK (actor IN ('observer','verifier','operator','import')),
 kind TEXT NOT NULL,
 subject TEXT NOT NULL,
 detail_json TEXT NOT NULL
) STRICT;
CREATE INDEX memory_events_scope ON memory_events(scope_id, ts);
CREATE TABLE workflow_index (
 id INTEGER PRIMARY KEY,
 project TEXT NOT NULL,
 name TEXT NOT NULL,
 file TEXT NOT NULL,
 content_sha256 TEXT NOT NULL,
 schema_version INTEGER NOT NULL,
 indexed_at TEXT NOT NULL,
 UNIQUE (project, name),
 UNIQUE (project, file)
) STRICT;
CREATE TABLE workflow_dependencies (
 workflow_id INTEGER NOT NULL REFERENCES workflow_index(id) ON DELETE CASCADE,
 step_id TEXT NOT NULL,
 session TEXT NOT NULL,
 action TEXT NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('page','element','fills_form')),
 route_key TEXT,
 target_key TEXT,
 page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
 element_id INTEGER REFERENCES elements(id) ON DELETE SET NULL,
 PRIMARY KEY (workflow_id, step_id, kind)
) STRICT;
CREATE INDEX wd_route ON workflow_dependencies(route_key);
CREATE INDEX wd_element ON workflow_dependencies(element_id);
CREATE INDEX wd_page ON workflow_dependencies(page_id);
`;
