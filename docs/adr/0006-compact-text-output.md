# ADR-0006: Compact text output, JSON optional

Status: accepted

Decision: tools return compact, deterministic text (status line, diff/snapshot, warnings, errors) rather than JSON + structuredContent, since many clients pass both to the model. `output.verbose=true` returns the normalized JSON `ActionResult`. Error text has a fixed shape (code, retry safety, suggestion, context).
Consequences: fewer tokens per call; consumers needing structure use the SDK or verbose mode. Measured in docs/BENCHMARK.md.
