# MCP client configuration

TG Browser MCP is a standard STDIO MCP server. It does **not** require any AI-provider login; client authentication is the client's business. Replace `/abs/path` with the absolute path of your checkout (Windows: `C:\\path\\tg-browser-mcp\\dist\\index.js`). After the package is published, `"command": "npx", "args": ["-y", "tg-browser-mcp", ...]` works the same way.

Formats below were checked against each client's documentation in November 2026; clients evolve, so consult their docs if a field is rejected.

## Claude Code (CLI and VS Code extension)

```bash
claude mcp add tg-browser -- node /abs/path/dist/index.js --profile developer
# project-scoped (writes .mcp.json):
claude mcp add --scope project tg-browser -- node /abs/path/dist/index.js --profile testing
```

`.mcp.json`:

```json
{
  "mcpServers": {
    "tg-browser": {
      "command": "node",
      "args": ["/abs/path/dist/index.js", "--transport", "stdio", "--profile", "developer"]
    }
  }
}
```

## Codex CLI / IDE extension (`~/.codex/config.toml`, or `.codex/config.toml` in trusted projects)

```toml
[mcp_servers.tg-browser]
command = "node"
args = ["/abs/path/dist/index.js", "--transport", "stdio", "--profile", "developer"]
# env = { TG_PROXY_USERNAME = "..." }
```

or `codex mcp add tg-browser -- node /abs/path/dist/index.js --profile developer`.

## Kiro (`.kiro/settings/mcp.json` workspace, `~/.kiro/settings/mcp.json` user)

```json
{
  "mcpServers": {
    "tg-browser": {
      "command": "node",
      "args": ["/abs/path/dist/index.js", "--profile", "developer"],
      "disabled": false
    }
  }
}
```

## Gemini CLI (`~/.gemini/settings.json` or `.gemini/settings.json`)

```json
{
  "mcpServers": {
    "tg-browser": { "command": "node", "args": ["/abs/path/dist/index.js", "--profile", "developer"] }
  }
}
```

## Cursor (`.cursor/mcp.json` or `~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "tg-browser": { "command": "node", "args": ["/abs/path/dist/index.js", "--profile", "developer"] }
  }
}
```

## VS Code (GitHub Copilot agent mode, `.vscode/mcp.json`) — note the `servers` key

```json
{
  "servers": {
    "tg-browser": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/dist/index.js", "--profile", "developer"]
    }
  }
}
```

## Remote / shared (Streamable HTTP)

```bash
export TG_BROWSER_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
node dist/index.js start --transport http --port 8931
```

Client: URL `http://127.0.0.1:8931/mcp`, header `Authorization: Bearer $TG_BROWSER_TOKEN`. Put a TLS-terminating reverse proxy in front if you bind beyond loopback.

## Tips

- Use `--profile minimal` for coding agents that only need to look at a page (≈8 tools, smallest schema).
- Use `--headless` on CI/servers; headed mode is the default so humans can watch.
- Pass `--config /abs/path/tg-browser.config.json` to pin policy per project.
- Approvals use MCP elicitation; clients without elicitation get `APPROVAL_REQUIRED` with instructions for the user.
