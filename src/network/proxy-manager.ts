import type { TgConfig } from '../config/schema.js';
import { TgError } from '../shared/errors.js';

export interface PlaywrightProxy {
  server: string;
  bypass?: string;
  username?: string;
  password?: string;
}

export interface ProxyStatus {
  mode: TgConfig['network']['mode'];
  source: 'config' | 'env' | 'browser-default' | 'none';
  server: string | null;
  bypass: string[];
  authenticated: boolean;
  credentialsMissing: string[];
  notes: string[];
}

/**
 * Resolves the browser proxy. Precedence:
 *   network.mode=manual + network.proxy.enabled  → config proxy
 *   network.mode=system                          → HTTPS_PROXY / HTTP_PROXY / ALL_PROXY env, else OS/browser default
 *   network.mode=direct                          → explicitly no proxy
 * Credentials are read from the environment variables named in config; they are never stored
 * in config files, logs or tool results.
 */
export class ProxyManager {
  constructor(
    private readonly cfg: TgConfig['network'],
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private envProxy(): string | undefined {
    const e = this.env;
    return (
      e.HTTPS_PROXY ||
      e.https_proxy ||
      e.HTTP_PROXY ||
      e.http_proxy ||
      e.ALL_PROXY ||
      e.all_proxy ||
      undefined
    );
  }

  private envBypass(): string[] {
    const raw = this.env.NO_PROXY || this.env.no_proxy || '';
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith('.') ? `*${s}` : s));
  }

  playwrightProxy(): PlaywrightProxy | undefined {
    const { mode, proxy } = this.cfg;
    if (mode === 'direct') return undefined;
    if (mode === 'manual') {
      if (!proxy.enabled) return undefined;
      if (!proxy.server)
        throw new TgError('CONFIG_INVALID', 'network.proxy.server is required when the proxy is enabled');
      return this.withCredentials(proxy.server, proxy.bypass);
    }
    // system mode
    if (proxy.enabled && proxy.server) return this.withCredentials(proxy.server, proxy.bypass);
    const envServer = this.envProxy();
    if (envServer) return this.fromEnvUrl(envServer, [...proxy.bypass, ...this.envBypass()]);
    return undefined;
  }

  /** Extra Chromium args needed for the mode (e.g. forcing direct connections). */
  chromiumArgs(): string[] {
    return this.cfg.mode === 'direct' ? ['--no-proxy-server'] : [];
  }

  private fromEnvUrl(raw: string, bypass: string[]): PlaywrightProxy {
    let u: URL;
    try {
      u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    } catch {
      throw new TgError('CONFIG_INVALID', 'HTTP(S)_PROXY environment variable is not a valid URL');
    }
    const out: PlaywrightProxy = { server: `${u.protocol}//${u.host}` };
    if (bypass.length) out.bypass = [...new Set(bypass)].join(',');
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  }

  private withCredentials(server: string, bypass: string[]): PlaywrightProxy {
    const out: PlaywrightProxy = { server };
    if (bypass.length) out.bypass = bypass.join(',');
    const { usernameEnv, passwordEnv } = this.cfg.proxy;
    if (usernameEnv && this.env[usernameEnv]) out.username = this.env[usernameEnv];
    if (passwordEnv && this.env[passwordEnv]) out.password = this.env[passwordEnv];
    return out;
  }

  status(): ProxyStatus {
    const notes: string[] = [];
    const missing: string[] = [];
    const { mode, proxy } = this.cfg;
    for (const name of [proxy.usernameEnv, proxy.passwordEnv]) {
      if (name && proxy.enabled && !this.env[name]) missing.push(name);
    }
    let resolved: PlaywrightProxy | undefined;
    let error: string | undefined;
    try {
      resolved = this.playwrightProxy();
    } catch (e) {
      error = (e as Error).message;
    }
    let source: ProxyStatus['source'] = 'none';
    if (resolved) source = proxy.enabled && proxy.server ? 'config' : 'env';
    else if (mode === 'system') source = 'browser-default';
    if (source === 'browser-default')
      notes.push(
        'No proxy configured; the browser uses the OS proxy settings (Chrome/Edge) or a direct connection.',
      );
    if (resolved?.server.startsWith('socks') && (resolved.username || resolved.password)) {
      notes.push(
        'Chromium does not support SOCKS5 proxy authentication; use an HTTP proxy for authenticated access.',
      );
    }
    notes.push(
      'This proxy applies to browser traffic only. Node.js (diagnostics), npm, and Playwright browser downloads use their own settings — see docs/PROXY.md.',
    );
    if (error) notes.push(`Configuration error: ${error}`);
    return {
      mode,
      source,
      server: resolved ? redactServer(resolved.server) : null,
      bypass: resolved?.bypass?.split(',') ?? [],
      authenticated: !!(resolved?.username || resolved?.password),
      credentialsMissing: missing,
      notes,
    };
  }
}

function redactServer(server: string): string {
  try {
    const u = new URL(server);
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return server;
  }
}
