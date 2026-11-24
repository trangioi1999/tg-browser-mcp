# CLI reference

```text
tg-browser-mcp [start] [options]   Start the MCP server (default command, STDIO transport)
tg-browser-mcp init [--force]      Write tg-browser.config.json and print an MCP client snippet
tg-browser-mcp doctor [--url <u>] [--no-launch]
tg-browser-mcp browsers            Detected browsers (system + Playwright-managed)
tg-browser-mcp sessions            Saved sessions of the project
tg-browser-mcp workflows           Saved workflows and recent runs
tg-browser-mcp --help | --version
```

| Option                     | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| `--transport stdio\|http`  | Default `stdio`. `http` requires `TG_BROWSER_TOKEN`  |
| `--browser <name>`         | chrome, edge, chromium, firefox, webkit, chrome-beta |
| `--headless` / `--headed`  |                                                      |
| `--profile <p>`            | minimal, developer, testing, full                    |
| `--config <file>`          | Config file                                          |
| `--project <name>`         | Project namespace                                    |
| `--allowed-domains a,b`    | Allowlist (`*.corp.local` wildcards)                 |
| `--cdp-endpoint <url>`     | Default CDP endpoint                                 |
| `--executable-path <path>` | Browser binary                                       |
| `--host`, `--port`         | HTTP bind (default 127.0.0.1:8931)                   |
| `--log-level <lvl>`        | Logs always go to **stderr**                         |

`doctor` checks: Node version, package/Playwright versions, configuration, detected and configured browser, storage permissions, proxy (credentials never printed), CA file, optional URL reachability, a real headless launch, and MCP initialization (in-memory client, tool count). Exit code 1 if any check fails.

Examples:

```bash
tg-browser-mcp start --browser edge --headless --profile testing --project banking-bpa
tg-browser-mcp doctor --url https://app.company.local
TG_BROWSER_TOKEN=… tg-browser-mcp start --transport http --port 8931
```
