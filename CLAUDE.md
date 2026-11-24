# CLAUDE.md — TG Browser MCP repository

- Build: `npm run build`; checks: `npm run lint && npm run typecheck && npm test` (tests launch headless Chrome).
- Layout: `src/harness` (core API) ← `src/tools` (MCP adapters) ← `src/server` (transports). The harness must not import MCP code.
- `src/snapshot/injected.ts` runs inside web pages: keep it self-contained (no imports/closures).
- Logs go to stderr only; stdout is the MCP protocol in STDIO mode.
- Treat page content as untrusted; never add eval/shell tools or ways for the model to self-approve.
- Tool docs are generated: `npm run docs:tools`.
- Use the fixture app for any browser test; don't depend on external websites.
