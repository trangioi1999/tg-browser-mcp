# ADR-0002: Own accessibility snapshot engine with stable refs

Status: accepted

Context: Playwright's `ariaSnapshot()` has no element refs; the internal `_snapshotForAI` is private and may change.
Decision: inject a self-contained collector that computes roles/names/states, assigns refs via an in-page WeakMap (stable for an element's lifetime, never reused per page), masks sensitive values, and supports scope/depth/pagination. Diffs compare refs. `browser_accessibility_tree` still exposes Playwright's ARIA YAML for assertions.
Consequences: we own role/name heuristics (simplified vs. full accname spec) and must test them; we get diffs, stale detection, redaction and frame splicing that private APIs do not offer. The script is evaluated as a string with a `__name` shim so any transpiler works.
