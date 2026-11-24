# Installation

Requirements: Node.js ≥ 20.10 (LTS recommended), npm, and a browser — installed Chrome/Edge, or Playwright-managed browsers.

## macOS / Linux

```bash
git clone <repo> tg-browser-mcp && cd tg-browser-mcp
npm ci
npm run build
npx playwright install chromium      # optional: only if Chrome/Edge are not installed
node dist/index.js doctor
```

Linux CI/servers without a desktop: `npx playwright install --with-deps chromium` and use `--headless`.

## Windows (PowerShell)

```powershell
git clone <repo> tg-browser-mcp; cd tg-browser-mcp
npm ci
npm run build
node dist\index.js doctor
```

## Offline / restricted networks

1. On a connected machine (or via your internal registry/mirror): `npm ci` and, if needed, `npx playwright install chromium` (set `PLAYWRIGHT_DOWNLOAD_HOST` to an internal mirror, `NODE_EXTRA_CA_CERTS` for TLS inspection).
2. Copy the folder (including `node_modules` and, if used, `~/.cache/ms-playwright` / `%LOCALAPPDATA%\ms-playwright` / `~/Library/Caches/ms-playwright`).
3. Everything runs offline afterwards; with an installed Chrome/Edge no browser download is required at all.

## npm / npx (after publication)

```bash
npx -y tg-browser-mcp doctor
npx -y tg-browser-mcp --profile developer      # what MCP clients run
```

## Verify

```bash
npm test                 # unit + integration + E2E (launches headless Chrome)
npm run fixture          # demo app on http://127.0.0.1:4321
```
