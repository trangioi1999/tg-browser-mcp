# ADR-0004: JSON files instead of SQLite for the MVP

Status: accepted

Context: the spec allows SQLite "when needed". Stored data: session state (encrypted blobs), workflow definitions, run records, audit JSONL — small, per-project, rarely queried.
Decision: plain files under `dataDir` (0700/0600), atomic rename for session state.
Consequences: zero native dependencies (better offline/enterprise installs, all OSes). Revisit (Node's built-in `node:sqlite`) if run history needs querying at scale.
