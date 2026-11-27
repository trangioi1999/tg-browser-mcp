import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { TgConfig } from '../config/schema.js';
import { detectBrowsers, resolveBrowser } from '../browser/browser-detector.js';
import { ProxyManager } from '../network/proxy-manager.js';
import { CertificateManager } from '../network/certificate-manager.js';
import { DomainPolicy } from '../security/domain-policy.js';
import { diagnose } from '../network/network-diagnostics.js';
import { VERSION } from '../version.js';

type Status = 'ok' | 'warn' | 'fail';
const ICON: Record<Status, string> = { ok: '✓', warn: '!', fail: '✗' };

/** Runs environment diagnostics. Prints to stderr/stdout; never prints credentials. */
export async function runDoctor(
  cfg: TgConfig,
  configFile: string | undefined,
  opts: { url?: string; launch: boolean },
): Promise<number> {
  const results: Array<{ status: Status; name: string; detail: string; fix?: string }> = [];
  const add = (status: Status, name: string, detail: string, fix?: string) =>
    results.push({ status, name, detail, ...(fix ? { fix } : {}) });

  // Node
  if (supportedNodeVersion(process.versions.node)) add('ok', 'Node.js', `v${process.versions.node}`);
  else add('fail', 'Node.js', `v${process.versions.node} (need ≥ 22.13)`, 'Install the current Node.js LTS');

  add('ok', 'tg-browser-mcp', `v${VERSION}`);
  add('ok', 'Configuration', configFile ? `valid (${configFile})` : 'valid (defaults; no config file found)');
  add(
    'ok',
    'Tool profile',
    `${cfg.tools.profile}${cfg.tools.disabled.length ? `, disabled: ${cfg.tools.disabled.join(', ')}` : ''}`,
  );

  // Playwright
  try {
    const req = createRequire(import.meta.url);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(path.dirname(req.resolve('playwright')), 'package.json'), 'utf8'),
    ) as { version: string };
    add('ok', 'Playwright', `v${pkg.version}`);
  } catch {
    add('fail', 'Playwright', 'not installed', 'npm install');
  }

  // Browsers
  const detected = detectBrowsers();
  if (detected.length) add('ok', 'Browsers detected', detected.map((b) => b.id).join(', '));
  else
    add('fail', 'Browsers detected', 'none', 'Install Chrome/Edge or run: npx playwright install chromium');
  const wanted = cfg.browser.executablePath
    ? fs.existsSync(cfg.browser.executablePath)
    : !!resolveBrowser(
        cfg.browser.engine,
        cfg.browser.engine === 'chromium' ? cfg.browser.channel : null,
        detected,
      );
  const wantedName = cfg.browser.executablePath ?? cfg.browser.channel ?? cfg.browser.engine;
  if (wanted) add('ok', 'Configured browser', wantedName);
  else
    add(
      'fail',
      'Configured browser',
      `${wantedName} not found`,
      'Use --browser with one of the detected browsers, or set browser.executablePath',
    );

  // Storage
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    const probe = path.join(cfg.dataDir, `.probe-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe);
    add('ok', 'Storage', `${cfg.dataDir} writable`);
  } catch (e) {
    add('fail', 'Storage', `${cfg.dataDir}: ${(e as Error).message}`, 'Set dataDir to a writable directory');
  }

  // Proxy / TLS
  const proxy = new ProxyManager(cfg.network);
  const ps = proxy.status();
  add(
    ps.credentialsMissing.length ? 'warn' : 'ok',
    'Browser proxy',
    `${ps.mode}/${ps.source}${ps.server ? ` ${ps.server}` : ''}${ps.authenticated ? ' (auth)' : ''}`,
    ps.credentialsMissing.length ? `Set env: ${ps.credentialsMissing.join(', ')}` : undefined,
  );
  const certs = new CertificateManager(cfg.network.tls).status();
  if (cfg.network.tls.caFile)
    add(
      certs.caFileReadable && !certs.certificates.some((c) => c.expired) ? 'ok' : 'fail',
      'Corporate CA',
      `${cfg.network.tls.caFile}: ${certs.certificates.length} cert(s)`,
      certs.caFileReadable ? undefined : 'Check network.tls.caFile path (PEM format)',
    );
  else add('ok', 'Corporate CA', 'none configured (OS trust store)');
  if (process.env.NODE_EXTRA_CA_CERTS) add('ok', 'NODE_EXTRA_CA_CERTS', process.env.NODE_EXTRA_CA_CERTS);

  // Connectivity
  if (opts.url) {
    const r = await diagnose(opts.url, {
      proxy,
      certs: new CertificateManager(cfg.network.tls),
      policy: new DomainPolicy(cfg.security),
    });
    add(
      r.ok ? 'ok' : 'fail',
      `Reach ${opts.url}`,
      r.conclusion,
      r.ok ? undefined : r.steps.find((s) => !s.ok)?.code,
    );
  }

  // Browser launch + MCP init
  if (opts.launch && wanted) {
    const { BrowserHarness } = await import('../harness/browser-harness.js');
    const h = new BrowserHarness({ ...cfg, browser: { ...cfg.browser, headless: true, persistent: false } });
    const t = Date.now();
    try {
      const s = await h.createSession({ name: 'doctor' });
      await s.navigate('about:blank');
      add('ok', 'Browser launch', `${h.browsers.list()[0]?.version ?? ''} in ${Date.now() - t}ms`);
    } catch (e) {
      add(
        'fail',
        'Browser launch',
        (e as Error).message.split('\n')[0] ?? '',
        'Run with --log-level debug; check the profile lock and browser installation',
      );
    } finally {
      await h.close();
    }
  }
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { createMcpServer } = await import('../server/mcp-server.js');
    const handle = createMcpServer(cfg);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'doctor', version: VERSION });
    await Promise.all([handle.server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    add('ok', 'MCP server init', `${tools.length} tools advertised (profile ${cfg.tools.profile})`);
    await client.close();
    await handle.close();
  } catch (e) {
    add('fail', 'MCP server init', (e as Error).message);
  }

  for (const r of results) {
    console.log(`${ICON[r.status]} ${r.name.padEnd(20)} ${r.detail}`);
    if (r.fix) console.log(`  → ${r.fix}`);
  }
  const failed = results.filter((r) => r.status === 'fail').length;
  console.log(failed ? `\n${failed} problem(s) found.` : '\nAll checks passed.');
  return failed ? 1 : 0;
}

/** Minimum unflagged node:sqlite runtime. Kept independent of driver imports for diagnostics. */
export function supportedNodeVersion(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}
