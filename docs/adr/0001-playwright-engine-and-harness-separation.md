# ADR-0001: Playwright as engine; harness separate from MCP

Status: accepted (2026-11-24)

Context: we need multi-browser automation, robust actionability, tracing, and an API reusable by TG Studio.
Decision: use Playwright (`playwright` package, not `@playwright/test`) as the only engine. Implement all logic in a transport-independent `BrowserHarness`; MCP tools are thin adapters.
Consequences: the SDK and MCP share one code path and test suite; MCP SDK upgrades do not touch browser logic.
