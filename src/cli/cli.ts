import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, type CliOverrides } from '../config/load-config.js';
import type { TgConfig } from '../config/schema.js';
import { createLogger, setLogger } from '../shared/logger.js';
import { TgError } from '../shared/errors.js';
import { VERSION } from '../version.js';
import { detectBrowsers } from '../browser/browser-detector.js';
import { runDoctor } from './doctor.js';

const HELP = `tg-browser-mcp ${VERSION} — secure, token-efficient browser automation MCP server

Usage:
  tg-browser-mcp [start] [options]     Start the MCP server (default: STDIO)
  tg-browser-mcp init [--force]        Create tg-browser.config.json and print MCP client config
  tg-browser-mcp doctor [--url <u>]    Check Node, browsers, config, storage, proxy, TLS, MCP init
  tg-browser-mcp browsers              List detected browsers
  tg-browser-mcp sessions              List saved sessions for the project
  tg-browser-mcp ui [--port 8940] [--config <file>] [--project <p>] [--open]
  tg-browser-mcp workflows             List saved workflows and recent runs

Options (start):
  --transport <stdio|http>   Transport (default stdio)
  --browser <name>           chrome | edge | chromium | firefox | webkit
  --headless / --headed      Headless mode
  --profile <name>           Tool profile: minimal | developer | testing | full
  --config <file>            Config file (default ./tg-browser.config.json if present)
  --project <name>           Project namespace for sessions/workflows
  --allowed-domains <list>   Comma-separated allowlist (e.g. localhost,*.corp.local)
  --cdp-endpoint <url>       Default CDP endpoint for browser_connect
  --executable-path <path>   Browser executable
  --host <host> --port <n>   HTTP transport bind address (default 127.0.0.1:8931)
  --log-level <level>        fatal|error|warn|info|debug|trace|silent (logs go to stderr)
  -v, --version              Print version
  -h, --help                 Show help

Configuration precedence: defaults < config file < TG_BROWSER_* env < CLI flags.`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      transport: { type: 'string' },
      browser: { type: 'string' },
      headless: { type: 'boolean' },
      headed: { type: 'boolean' },
      profile: { type: 'string' },
      config: { type: 'string' },
      project: { type: 'string' },
      'allowed-domains': { type: 'string' },
      'cdp-endpoint': { type: 'string' },
      'executable-path': { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'log-level': { type: 'string' },
      url: { type: 'string' },
      force: { type: 'boolean' },
      open: { type: 'boolean' },
      'no-launch': { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.error(HELP);
    return 0;
  }
  if (values.version) {
    // --version is not used in MCP mode, so stdout is fine here.
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const cmd = positionals[0] ?? 'start';
  const overrides: CliOverrides = {
    ...(values.config ? { configPath: values.config } : {}),
    ...(values.browser ? { browser: values.browser } : {}),
    ...(values.headless ? { headless: true } : values.headed ? { headless: false } : {}),
    ...(values.profile ? { profile: values.profile } : {}),
    ...(values.project ? { project: values.project } : {}),
    ...(values['cdp-endpoint'] ? { cdpEndpoint: values['cdp-endpoint'] } : {}),
    ...(values['executable-path'] ? { executablePath: values['executable-path'] } : {}),
    ...(values['allowed-domains']
      ? {
          allowedDomains: values['allowed-domains']
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : {}),
    ...(values['log-level'] ? { logLevel: values['log-level'] } : {}),
  };

  if (cmd === 'init') return init(!!values.force);
  if (cmd === 'browsers') {
    const list = detectBrowsers();
    if (!list.length)
      console.error('No browsers detected. Install Chrome/Edge or run: npx playwright install chromium');
    for (const b of list)
      console.log(`${b.id.padEnd(12)} ${b.name.padEnd(22)} ${b.source.padEnd(10)} ${b.executablePath}`);
    return 0;
  }

  let config: TgConfig;
  let file: string | undefined;
  try {
    ({ config, file } = loadConfig(overrides));
  } catch (e) {
    console.error(e instanceof TgError ? `✗ ${e.code}: ${e.message}` : String(e));
    return 2;
  }
  setLogger(createLogger(config.logLevel));
  if (values.host) config.http.host = values.host;
  if (values.port) config.http.port = Number(values.port);

  switch (cmd) {
    case 'ui': {
      const { startDashboard } = await import('../ui/server.js');
      const dashboard = await startDashboard(config, {
        port: Number(values.port ?? 8940),
        ...(values.host ? { host: values.host } : {}),
        ...(file ? { file } : {}),
        overrides,
      });
      console.log(`Bảng điều khiển: ${dashboard.url}`);
      if (values.open) {
        const { execFile } = await import('node:child_process');
        const command =
          process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
        const args =
          process.platform === 'win32' ? ['url.dll,FileProtocolHandler', dashboard.url] : [dashboard.url];
        execFile(command, args, (error) => {
          if (error) console.error('Không thể mở trình duyệt; hãy mở URL phía trên.');
        });
      }
      const stop = () => void dashboard.close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return -1;
    }
    case 'start': {
      const transport = values.transport ?? 'stdio';
      if (transport === 'stdio') {
        const { startStdio } = await import('../server/transports/stdio.js');
        await startStdio(config);
        return -1; // keep running
      }
      if (transport === 'http') {
        const { startStreamableHttp } = await import('../server/transports/streamable-http.js');
        const h = await startStreamableHttp(config);
        console.error(`Listening on ${h.url} (Authorization: Bearer $${config.http.tokenEnv})`);
        const stop = () => void h.close().then(() => process.exit(0));
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        return -1;
      }
      console.error(`Unknown transport "${transport}". Use stdio or http.`);
      return 2;
    }
    case 'doctor':
      return runDoctor(config, file, {
        ...(values.url ? { url: values.url } : {}),
        launch: !values['no-launch'],
      });
    case 'sessions': {
      const { SessionStore } = await import('../session/session-store.js');
      const list = new SessionStore(config.dataDir, config.sessions.encrypt).list(config.project);
      console.log(`Project: ${config.project}`);
      if (!list.length) console.log('  (no saved sessions)');
      for (const m of list)
        console.log(
          `  ${m.name.padEnd(20)} saved=${m.savedAt} cookies=${m.cookies} origins=${m.origins}${m.encrypted ? ' encrypted' : ''}`,
        );
      return 0;
    }
    case 'workflows': {
      const { BrowserHarness } = await import('../harness/browser-harness.js');
      const { WorkflowEngine } = await import('../workflow/workflow-engine.js');
      const eng = new WorkflowEngine(new BrowserHarness(config));
      const defs = eng.listDefinitions();
      console.log(`Project: ${config.project}\nWorkflows:`);
      if (!defs.length) console.log('  (none)');
      for (const d of defs)
        console.log(`  ${d.name.padEnd(30)} steps=${d.steps} sessions=${d.sessions.join(',')}`);
      console.log('Recent runs:');
      for (const r of eng.listRuns(10))
        console.log(`  ${r.runId}  ${r.workflow.padEnd(30)} ${r.status.padEnd(9)} ${r.startedAt}`);
      return 0;
    }
    default:
      console.error(`Unknown command "${cmd}"\n\n${HELP}`);
      return 2;
  }
}

function init(force: boolean): number {
  const target = path.resolve('tg-browser.config.json');
  if (fs.existsSync(target) && !force) {
    console.error(`${target} already exists (use --force to overwrite)`);
  } else {
    const cfg = {
      project: path.basename(process.cwd()).replace(/[^A-Za-z0-9._-]/g, '-') || 'default',
      browser: { engine: 'chromium', channel: 'chrome', headless: false, persistent: false },
      security: {
        allowLocalhost: true,
        allowPrivateNetwork: false,
        allowedDomains: [],
        blockedDomains: [],
        approval: { highRisk: 'ask', destructive: 'ask' },
      },
      network: {
        mode: 'system',
        proxy: {
          enabled: false,
          server: null,
          usernameEnv: 'TG_PROXY_USERNAME',
          passwordEnv: 'TG_PROXY_PASSWORD',
          bypass: ['localhost', '127.0.0.1'],
        },
        tls: { caFile: null },
      },
      tools: { profile: 'developer', disabled: [] },
    };
    fs.writeFileSync(target, `${JSON.stringify(cfg, null, 2)}\n`);
    console.error(`✓ Wrote ${target}`);
  }
  const entry = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'index.js');
  console.error(
    `\nAdd to your MCP client (e.g. .mcp.json for Claude Code):\n${JSON.stringify({ mcpServers: { 'tg-browser': { command: 'node', args: [entry, '--transport', 'stdio', '--config', target] } } }, null, 2)}`,
  );
  return 0;
}
