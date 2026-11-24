import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright';
import type { TgConfig } from '../config/schema.js';
import type { ProxyManager } from '../network/proxy-manager.js';
import type { PermissionManager } from '../security/permission-manager.js';
import type { TypedEmitter } from '../shared/events.js';
import { getLogger } from '../shared/logger.js';
import { shortId } from '../shared/util.js';
import { connectCdp, launchBrowser, launchPersistent, type LaunchSpec } from './browser-launcher.js';
import { TgError } from '../shared/errors.js';

export interface BrowserInfo {
  id: string;
  engine: string;
  channel: string | null;
  headless: boolean;
  mode: 'launch' | 'persistent' | 'connect';
  version: string;
  connected: boolean;
  contexts: number;
}

interface ManagedBrowser {
  id: string;
  spec: LaunchSpec;
  mode: BrowserInfo['mode'];
  browser?: Browser;
  /** For persistent contexts there is no shared Browser object. */
  context?: BrowserContext;
  closing: boolean;
}

/**
 * Owns browser processes: one shared browser for isolated (non-persistent) contexts per launch
 * spec, plus one process per persistent profile and per CDP connection. Detects crashes
 * (disconnected events) and cleans up on shutdown.
 */
export class BrowserManager {
  private readonly browsers = new Map<string, ManagedBrowser>();
  private shared: ManagedBrowser | undefined;
  private launching: Promise<ManagedBrowser> | undefined;

  constructor(
    private readonly cfg: TgConfig,
    private readonly proxy: ProxyManager,
    private readonly permissions: PermissionManager,
    private readonly events: TypedEmitter,
  ) {
    permissions.checkLaunchArgs(cfg.browser.args);
  }

  defaultSpec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
    return {
      engine: overrides.engine ?? this.cfg.browser.engine,
      channel:
        overrides.channel !== undefined
          ? overrides.channel
          : this.cfg.browser.engine === 'chromium'
            ? this.cfg.browser.channel
            : null,
      headless: overrides.headless ?? this.cfg.browser.headless,
      executablePath:
        overrides.executablePath !== undefined ? overrides.executablePath : this.cfg.browser.executablePath,
    };
  }

  private track(mb: ManagedBrowser): ManagedBrowser {
    this.browsers.set(mb.id, mb);
    const onGone = () => {
      if (!this.browsers.has(mb.id)) return;
      this.browsers.delete(mb.id);
      if (this.shared === mb) this.shared = undefined;
      if (mb.closing) getLogger().debug({ browserId: mb.id }, 'browser closed');
      else getLogger().warn({ browserId: mb.id }, 'browser disconnected unexpectedly');
      this.events.emit('browser.closed', {
        browserId: mb.id,
        reason: mb.closing ? 'requested' : 'disconnected',
      });
    };
    mb.browser?.on('disconnected', onGone);
    mb.context?.on('close', onGone);
    this.events.emit('browser.started', {
      browserId: mb.id,
      engine: mb.spec.engine,
      ...(mb.spec.channel ? { channel: mb.spec.channel } : {}),
      mode: mb.mode === 'connect' ? 'connect' : 'launch',
    });
    return mb;
  }

  /** Shared browser used for isolated contexts. Relaunches automatically after a crash. */
  async sharedBrowser(spec?: LaunchSpec): Promise<{ id: string; browser: Browser }> {
    const want = spec ?? this.defaultSpec();
    if (this.shared?.browser?.isConnected()) {
      const s = this.shared.spec;
      if (
        s.engine === want.engine &&
        s.channel === want.channel &&
        s.headless === want.headless &&
        s.executablePath === want.executablePath
      ) {
        return { id: this.shared.id, browser: this.shared.browser };
      }
      // A different browser was requested: launch a dedicated (non-shared) instance.
      const browser = await launchBrowser(this.cfg, want, this.proxy);
      const mb = this.track({ id: shortId('browser'), spec: want, mode: 'launch', browser, closing: false });
      return { id: mb.id, browser };
    }
    if (!this.launching) {
      this.launching = (async () => {
        const browser = await launchBrowser(this.cfg, want, this.proxy);
        const mb = this.track({
          id: shortId('browser'),
          spec: want,
          mode: 'launch',
          browser,
          closing: false,
        });
        this.shared = mb;
        return mb;
      })().finally(() => {
        this.launching = undefined;
      });
    }
    const mb = await this.launching;
    return { id: mb.id, browser: mb.browser! };
  }

  async persistentContext(
    userDataDir: string,
    contextOptions: BrowserContextOptions,
    spec?: LaunchSpec,
  ): Promise<{ id: string; context: BrowserContext }> {
    const s = spec ?? this.defaultSpec();
    const context = await launchPersistent(this.cfg, s, this.proxy, userDataDir, contextOptions);
    const mb = this.track({ id: shortId('browser'), spec: s, mode: 'persistent', context, closing: false });
    return { id: mb.id, context };
  }

  async connect(endpoint: string): Promise<{ id: string; browser: Browser }> {
    const browser = await connectCdp(this.cfg, endpoint);
    const mb = this.track({
      id: shortId('cdp'),
      spec: { engine: 'chromium', channel: null, headless: false, executablePath: null },
      mode: 'connect',
      browser,
      closing: false,
    });
    return { id: mb.id, browser };
  }

  list(): BrowserInfo[] {
    return [...this.browsers.values()].map((mb) => ({
      id: mb.id,
      engine: mb.spec.engine,
      channel: mb.spec.channel,
      headless: mb.spec.headless,
      mode: mb.mode,
      version: mb.browser?.version() ?? mb.context?.browser()?.version() ?? 'unknown',
      connected: mb.browser ? mb.browser.isConnected() : !!mb.context,
      contexts: mb.browser ? mb.browser.contexts().length : 1,
    }));
  }

  async close(id: string): Promise<void> {
    const mb = this.browsers.get(id);
    if (!mb)
      throw new TgError('BROWSER_NOT_FOUND', `No browser with id ${id}`, {
        suggestion: 'Call browser_list.',
      });
    mb.closing = true;
    // Remove first so the disconnect handler does not emit a second browser.closed.
    this.browsers.delete(id);
    if (mb.mode === 'connect') {
      // Never close the user's own browser; just disconnect.
      await mb.browser?.close().catch(() => undefined);
    } else {
      await (mb.context ?? mb.browser)?.close().catch(() => undefined);
    }
    if (this.shared === mb) this.shared = undefined;
    this.events.emit('browser.closed', { browserId: id, reason: 'requested' });
  }

  async closeAll(): Promise<void> {
    const all = [...this.browsers.values()];
    this.browsers.clear();
    await Promise.all(
      all.map(async (mb) => {
        mb.closing = true;
        await (mb.context ?? mb.browser)?.close().catch(() => undefined);
        this.events.emit('browser.closed', { browserId: mb.id, reason: 'shutdown' });
      }),
    );
    this.shared = undefined;
  }
}
