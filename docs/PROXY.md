# Proxy configuration & enterprise network troubleshooting

## Which settings affect which traffic

Configuring one layer does **not** configure the others.

| Traffic                                                         | Who makes it                 | Controlled by                                                                                                          |
| --------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Browser page traffic (documents, XHR/fetch, assets, WebSockets) | Chrome/Edge/Firefox process  | `network.mode` + `network.proxy` (→ Playwright `proxy`), else OS proxy settings / PAC for Chrome/Edge in `system` mode |
| Per-session browser traffic                                     | the session's BrowserContext | `session_create` with a context proxy (SDK: `CreateSessionOptions.proxy`)                                              |
| `network_diagnose` / `doctor --url`                             | Node.js in the MCP process   | same proxy resolution as the browser + `tls.caFile` + `NODE_EXTRA_CA_CERTS`                                            |
| MCP process itself (no outbound traffic by default)             | Node.js                      | —                                                                                                                      |
| `npm install`                                                   | npm                          | `npm config set proxy/https-proxy`, `cafile`, internal registry (`registry=`)                                          |
| `npx playwright install` (browser download)                     | Playwright installer         | `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, or `PLAYWRIGHT_DOWNLOAD_HOST` (internal mirror)                                  |
| Browser WebSockets                                              | browser                      | the browser proxy (HTTP CONNECT); policy enforced via `routeWebSocket`                                                 |

## Modes and precedence

| `network.mode`     | Behaviour                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system` (default) | `network.proxy` if enabled → else `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` (+ `NO_PROXY`) → else the browser's own default (Chrome/Edge: OS settings, PAC) |
| `manual`           | Only `network.proxy` (must be enabled with `server`)                                                                                                     |
| `direct`           | No proxy (`--no-proxy-server` for Chromium)                                                                                                              |

Credentials are **never** stored in config: set `usernameEnv`/`passwordEnv` to the _names_ of environment variables. Env-URL credentials (`http://user:pass@proxy:3128`) are also supported. Status output never shows them.

```json
{
  "network": {
    "mode": "manual",
    "proxy": {
      "enabled": true,
      "server": "http://proxy.company.local:3128",
      "usernameEnv": "TG_PROXY_USERNAME",
      "passwordEnv": "TG_PROXY_PASSWORD",
      "bypass": ["localhost", "127.0.0.1", "*.company.local"]
    },
    "tls": { "verify": true, "caFile": "/etc/ssl/company-root-ca.pem" }
  }
}
```

Supported: HTTP proxy, HTTPS via CONNECT, SOCKS5 (`socks5://host:1080`, Chromium does not support SOCKS authentication), Basic proxy auth, bypass lists. Not supported/never implemented: firewall bypass, tunnelling around policy, traffic obfuscation, disabling TLS verification.

## Corporate CA certificates

| Layer                          | How to trust the corporate CA                                                     |
| ------------------------------ | --------------------------------------------------------------------------------- |
| Chrome / Edge (Windows, macOS) | Install in the OS trust store (usually done by IT)                                |
| Chromium on Linux              | `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n corp-ca -i ca.pem`               |
| Firefox                        | Enterprise policy `Certificates.ImportEnterpriseRoots` or import into the profile |
| Node.js diagnostics            | `network.tls.caFile` and/or `NODE_EXTRA_CA_CERTS=/path/ca.pem`                    |
| npm / Playwright download      | `npm config set cafile`, `NODE_EXTRA_CA_CERTS`                                    |

`network_certificate_status` lists configured certificates, expiry and the notes above.

## Troubleshooting

Start with `node dist/index.js doctor --url https://app.company.local` or the `network_diagnose` tool:

```text
✗ https://app.company.local/ via proxy http://proxy.company.local:3128
  ✓ policy     0ms  Allowed by domain policy
  ✓ proxy     42ms  CONNECT tunnel to app.company.local:443 established via proxy.company.local:3128
  ✗ tls       18ms  UNABLE_TO_GET_ISSUER_CERT_LOCALLY … — configure network.tls.caFile with your corporate CA  [NETWORK_TLS_FAILED]
```

| Symptom / code                               | Likely cause                                  | Fix                                                                                        |
| -------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `DOMAIN_NOT_ALLOWED`                         | host not in allowlist, private IP, metadata   | add host to `security.allowedDomains` (internal apps)                                      |
| `NETWORK_DNS_FAILED`                         | host only resolvable via proxy or VPN         | use a proxy (mode manual), check VPN/DNS                                                   |
| `NETWORK_PROXY_FAILED` 407                   | missing/wrong proxy credentials               | set the env vars named in `usernameEnv`/`passwordEnv`                                      |
| `NETWORK_PROXY_FAILED` CONNECT 403           | proxy denies the destination/port             | ask the network team to allow it                                                           |
| `NETWORK_TLS_FAILED`                         | TLS inspection with corporate CA              | install CA (table above); never disable verification                                       |
| `NAVIGATION_TIMEOUT`                         | firewall drops packets, wrong bypass list     | check bypass entries, test with `network_connection_test`                                  |
| Works in Chrome, fails in diagnose           | Chrome uses PAC/OS proxy that Node cannot see | set `network.proxy` explicitly                                                             |
| Localhost goes through proxy                 | bypass missing                                | Chromium bypasses loopback by default; add `localhost`/`127.0.0.1` to `bypass` for Firefox |
| `ERR_CONNECTION_RESET` on `remoteEntry.json` | proxy/IDS blocks micro-frontend remotes       | `browser_errors` highlights failed remotes; allow the remote host                          |

Commands for each OS:

```bash
# macOS / Linux
export TG_PROXY_USERNAME=alice TG_PROXY_PASSWORD='…' NODE_EXTRA_CA_CERTS=/etc/ssl/corp-ca.pem
# Windows PowerShell
$env:TG_PROXY_USERNAME="alice"; $env:TG_PROXY_PASSWORD="…"; $env:NODE_EXTRA_CA_CERTS="C:\certs\corp-ca.pem"
```
