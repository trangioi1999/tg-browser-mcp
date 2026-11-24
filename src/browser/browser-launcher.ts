import fs from 'node:fs';
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type LaunchOptions,
} from 'playwright';
import type { TgConfig } from '../config/schema.js';
import { TgError } from '../shared/errors.js';
import { isLoopback } from '../security/domain-policy.js';
import { detectBrowsers, resolveBrowser } from './browser-detector.js';
import type { ProxyManager } from '../network/proxy-manager.js';

export interface LaunchSpec {
  engine: 'chromium' | 'firefox' | 'webkit';
  channel: string | null;
  headless: boolean;
  executablePath: string | null;
}

export function browserTypeFor(engine: LaunchSpec['engine']): BrowserType {
  return engine === 'firefox' ? firefox : engine === 'webkit' ? webkit : chromium;
}

/**
 * Environment variables the browser process may inherit. Everything else (MCP tokens,
 * TG_SECRET_*, proxy credentials, cloud credentials) is withheld: the browser executes untrusted
 * web content, so a compromised renderer must not find secrets in its environment.
 */
const BROWSER_ENV_ALLOW = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
  'FONTCONFIG_PATH',
  'FONTCONFIG_FILE',
  'PLAYWRIGHT_BROWSERS_PATH',
  // Windows needs these to start Chrome/Edge.
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'LOCALAPPDATA',
  'APPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
];

export function browserEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (BROWSER_ENV_ALLOW.includes(k) || k.startsWith('LC_') || k.startsWith('XDG_')) out[k] = v;
  }
  return out;
}

export function buildLaunchOptions(cfg: TgConfig, spec: LaunchSpec, proxy: ProxyManager): LaunchOptions {
  const opts: LaunchOptions = {
    headless: spec.headless,
    timeout: cfg.browser.timeout,
    args: [...cfg.browser.args, ...(spec.engine === 'chromium' ? proxy.chromiumArgs() : [])],
    env: browserEnv(),
    chromiumSandbox: cfg.browser.chromiumSandbox,
    // Playwright attaches its own handlers; we do graceful shutdown ourselves.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
  if (spec.executablePath) opts.executablePath = spec.executablePath;
  else if (spec.channel && spec.engine === 'chromium') opts.channel = spec.channel;
  const p = proxy.playwrightProxy();
  if (p) opts.proxy = p;
  return opts;
}

/** Fails early with BROWSER_NOT_FOUND when the requested browser is not installed. */
export function preflight(spec: LaunchSpec): void {
  if (spec.executablePath) {
    if (!fs.existsSync(spec.executablePath)) {
      throw new TgError('BROWSER_NOT_FOUND', `Browser executable not found: ${spec.executablePath}`);
    }
    return;
  }
  const detected = detectBrowsers();
  if (!resolveBrowser(spec.engine, spec.channel, detected, spec.headless)) {
    const available = detected.map((d) => d.id).join(', ') || 'none';
    throw new TgError(
      'BROWSER_NOT_FOUND',
      `Browser ${spec.channel ?? spec.engine} is not installed. Detected: ${available}.`,
      {
        suggestion: spec.channel
          ? `Install ${spec.channel}, choose another with --browser, or run \`npx playwright install chromium\`.`
          : `Run \`npx playwright install ${spec.engine}\` or use --browser chrome.`,
        context: { available: detected.map((d) => d.id) },
      },
    );
  }
}

export async function launchBrowser(cfg: TgConfig, spec: LaunchSpec, proxy: ProxyManager): Promise<Browser> {
  preflight(spec);
  try {
    return await browserTypeFor(spec.engine).launch(buildLaunchOptions(cfg, spec, proxy));
  } catch (e) {
    throw new TgError(
      'BROWSER_LAUNCH_FAILED',
      `Failed to launch ${spec.channel ?? spec.engine}: ${String((e as Error).message).split('\n')[0]}`,
      { cause: e },
    );
  }
}

/** Launches a persistent context backed by a dedicated automation profile directory. */
export async function launchPersistent(
  cfg: TgConfig,
  spec: LaunchSpec,
  proxy: ProxyManager,
  userDataDir: string,
  contextOptions: Parameters<BrowserType['launchPersistentContext']>[1],
): Promise<BrowserContext> {
  preflight(spec);
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  try {
    return await browserTypeFor(spec.engine).launchPersistentContext(userDataDir, {
      ...buildLaunchOptions(cfg, spec, proxy),
      ...contextOptions,
    });
  } catch (e) {
    const msg = String((e as Error).message);
    const locked = /ProcessSingleton|SingletonLock|already in use|profile.*in use/i.test(msg);
    throw new TgError(
      'BROWSER_LAUNCH_FAILED',
      locked
        ? `Profile ${userDataDir} is in use by another browser process`
        : `Failed to launch persistent browser: ${msg.split('\n')[0]}`,
      {
        cause: e,
        ...(locked
          ? {
              suggestion:
                'Close the other browser using this profile, or use a different userDataDir/session.',
            }
          : {}),
      },
    );
  }
}

/** Connects to an existing Chromium over CDP. Only loopback endpoints unless explicitly allowed. */
export async function connectCdp(cfg: TgConfig, endpoint: string): Promise<Browser> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TgError('INVALID_ARGUMENT', 'cdpEndpoint must be a URL such as http://127.0.0.1:9222');
  }
  if (!isLoopback(url.hostname) && !cfg.browser.allowRemoteCdp) {
    throw new TgError(
      'PERMISSION_DENIED',
      'Remote CDP endpoints are disabled. Only localhost is allowed unless browser.allowRemoteCdp=true.',
    );
  }
  if (!isLoopback(url.hostname) && !['https:', 'wss:'].includes(url.protocol)) {
    throw new TgError('PERMISSION_DENIED', 'Remote CDP connections must use https:// or wss://');
  }
  try {
    return await chromium.connectOverCDP(endpoint, { timeout: cfg.browser.timeout });
  } catch (e) {
    throw new TgError(
      'BROWSER_LAUNCH_FAILED',
      `Cannot connect to CDP endpoint: ${String((e as Error).message).split('\n')[0]}`,
      {
        cause: e,
        suggestion:
          'Start Chrome with --remote-debugging-port=9222 and a dedicated --user-data-dir, then retry.',
      },
    );
  }
}
