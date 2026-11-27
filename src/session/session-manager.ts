import { installScriptSource } from '../snapshot/injected.js';
import path from 'node:path';
import fs from 'node:fs';
import type { BrowserContext, BrowserContextOptions, Page } from 'playwright';
import type { TgConfig } from '../config/schema.js';
import type { BrowserManager } from '../browser/browser-manager.js';
import type { LaunchSpec } from '../browser/browser-launcher.js';
import type { DomainPolicy } from '../security/domain-policy.js';
import { safeUrlForLog } from '../security/domain-policy.js';
import type { DataRedactor } from '../security/data-redactor.js';
import type { TypedEmitter } from '../shared/events.js';
import { NetworkMonitor } from '../network/network-monitor.js';
import { ProxyManager } from '../network/proxy-manager.js';
import { TgError } from '../shared/errors.js';
import { getLogger } from '../shared/logger.js';
import { assertSafeName, shortId } from '../shared/util.js';
import { PageState, Session } from './session.js';
import { installIndicator } from '../browser/indicator.js';
import type { SessionStore } from './session-store.js';

export interface CreateSessionOptions {
  name: string;
  recordVideo?: boolean;
  project?: string;
  agentId?: string;
  /** Use a dedicated on-disk automation profile for this session. */
  persistent?: boolean;
  /** Restore previously saved storage state (cookies, localStorage, IndexedDB). */
  restore?: boolean;
  browser?: Partial<LaunchSpec>;
  viewport?: { width: number; height: number } | null;
  /** Per-context proxy (Chromium/Firefox). Credentials are taken from config env vars. */
  proxy?: TgConfig['network']['proxy'];
  /** Open a first blank page (default true). */
  openPage?: boolean;
  locale?: string;
  timezoneId?: string;
  /** Browser Memory auth context label (e.g. `maker`); default: config `memory.authContext`. */
  authContext?: string;
}

const BLOCKED_PAGE = (reason: string) =>
  `<!doctype html><title>Blocked by TG Browser policy</title><h1>Blocked by TG Browser policy</h1><p>${reason.replace(/[<>&]/g, '')}</p>`;

export class SessionManager {
  private readonly leases = new Map<string, string>();

  /** Reserve all names atomically, including sessions that have not been created yet. */
  acquireLeases(names: string[], owner: string, project = this.cfg.project): () => void {
    const keys = [
      ...new Set(
        names.map((name) => {
          const session = this.find(name, project);
          if (session && [...session.pages.values()].some((page) => page.lock.holder))
            throw new TgError('SESSION_BUSY', `Session ${name} has an action in flight`, { retryable: true });
          return this.key(session?.project ?? project, session?.name ?? name);
        }),
      ),
    ];
    for (const key of keys) {
      const held = this.leases.get(key);
      if (held && held !== owner)
        throw new TgError('SESSION_BUSY', `Session ${key} is leased by another run`, { retryable: true });
    }
    for (const key of keys) this.leases.set(key, owner);
    return () => {
      for (const key of keys) if (this.leases.get(key) === owner) this.leases.delete(key);
    };
  }

  private readonly sessions = new Map<string, Session>();
  private readonly recordings = new Map<
    string,
    { retain: boolean; failed: boolean; videos: Array<{ pageId: string; video: import('playwright').Video }> }
  >();
  private activeKey: string | undefined;

  constructor(
    private readonly cfg: TgConfig,
    private readonly browsers: BrowserManager,
    private readonly policy: DomainPolicy,
    private readonly redactor: DataRedactor,
    private readonly store: SessionStore,
    private readonly events: TypedEmitter,
  ) {
    events.on('action.failed', ({ sessionId }) => {
      const r = this.recordings.get(sessionId);
      if (r) r.failed = true;
    });
    events.on('workflow.failed', ({ sessions }) => {
      for (const s of sessions ?? []) {
        const r = this.recordings.get(s.sessionId);
        if (r) r.failed = true;
      }
    });
  }

  private key(project: string, name: string): string {
    return `${project}/${name}`;
  }

  get size(): number {
    return this.sessions.size;
  }

  list(project?: string): Session[] {
    return [...this.sessions.values()].filter((s) => !project || s.project === project);
  }

  get active(): Session | undefined {
    return this.activeKey ? this.sessions.get(this.activeKey) : undefined;
  }

  find(nameOrId: string, project = this.cfg.project): Session | undefined {
    return (
      this.sessions.get(this.key(project, nameOrId)) ??
      [...this.sessions.values()].find((s) => s.id === nameOrId)
    );
  }

  /**
   * Resolves a session by id, or by name in `project` (default: the configured project). When no project
   * is given and the name is not in the configured project, a name that exists in exactly one other
   * project resolves to that session, so MCP page tools can address sessions created with
   * `session_create project=...` (D8). A name present in several other projects is ambiguous.
   */
  get(nameOrId?: string, project?: string): Session {
    let s = nameOrId ? this.find(nameOrId, project) : this.active;
    if (nameOrId && !s && project === undefined) {
      const named = [...this.sessions.values()].filter((x) => x.name === nameOrId && x.status === 'active');
      if (named.length > 1) {
        throw new TgError(
          'SESSION_AMBIGUOUS',
          `Session name "${nameOrId}" exists in several projects: ${named.map((x) => `${x.project}/${x.name} (${x.id})`).join(', ')}`,
          {
            context: { sessions: named.map((x) => ({ id: x.id, project: x.project, name: x.name })) },
            suggestion: 'Pass the session id instead of its name.',
          },
        );
      }
      s = named[0];
    }
    if (!s || s.status !== 'active') {
      throw new TgError(
        'SESSION_NOT_FOUND',
        nameOrId ? `Session "${nameOrId}" not found` : 'No active session',
        {
          context: {
            sessions: this.list().map((x) =>
              x.project === this.cfg.project ? x.name : `${x.project}/${x.name} (${x.id})`,
            ),
          },
        },
      );
    }
    return s;
  }

  switch(nameOrId: string, project?: string): Session {
    const s = this.get(nameOrId, project);
    this.activeKey = this.key(s.project, s.name);
    return s;
  }

  /** Returns the active session, creating the "default" session on first use. */
  async ensureActive(): Promise<Session> {
    const a = this.active;
    if (a && a.status === 'active') return a;
    const existing = this.find('default');
    if (existing && existing.status === 'active') {
      this.activeKey = this.key(existing.project, existing.name);
      return existing;
    }
    const pending = this.creating.get(this.key(this.cfg.project, 'default'));
    if (pending) return pending;
    return this.create({ name: 'default', persistent: this.cfg.browser.persistent });
  }

  private contextOptions(opts: CreateSessionOptions): BrowserContextOptions {
    const o: BrowserContextOptions = {
      viewport: opts.viewport !== undefined ? opts.viewport : this.cfg.browser.viewport,
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
      serviceWorkers: this.cfg.security.enforceOnSubresources ? 'block' : 'allow',
      bypassCSP: false,
    };
    if (opts.recordVideo ?? this.cfg.recording.video !== 'off') {
      o.recordVideo = {
        dir: path.join(
          this.cfg.dataDir,
          'artifacts',
          assertSafeName('project', opts.project ?? this.cfg.project),
          assertSafeName('session', opts.name),
          'videos',
        ),
        ...(this.cfg.recording.size ? { size: this.cfg.recording.size } : {}),
      };
    }
    if (o.recordVideo?.dir) fs.mkdirSync(o.recordVideo.dir, { recursive: true, mode: 0o700 });
    if (opts.locale) o.locale = opts.locale;
    if (opts.timezoneId) o.timezoneId = opts.timezoneId;
    if (opts.proxy?.enabled) {
      const pm = new ProxyManager({ ...this.cfg.network, mode: 'manual', proxy: opts.proxy });
      const p = pm.playwrightProxy();
      if (p) o.proxy = p;
    }
    return o;
  }

  /** Creations in flight, so concurrent creates of the same name cannot both launch a context (D25). */
  private readonly creating = new Map<string, Promise<Session>>();

  async create(opts: CreateSessionOptions): Promise<Session> {
    const name = assertSafeName('session', opts.name);
    const project = assertSafeName('project', opts.project ?? this.cfg.project);
    if (opts.authContext !== undefined) assertSafeName('authContext', opts.authContext);
    const k = this.key(project, name);
    if (this.creating.has(k)) {
      throw new TgError(
        'SESSION_EXISTS',
        `Session "${name}" is already being created in project "${project}"`,
        {
          suggestion: 'Wait for the other session_create to finish, then use session_switch.',
        },
      );
    }
    const existing = this.sessions.get(k);
    if (existing && existing.status === 'active') {
      throw new TgError('SESSION_EXISTS', `Session "${name}" already exists in project "${project}"`, {
        suggestion: 'Use session_switch, or session_delete first.',
      });
    }
    // In-flight creations count against the limit, so concurrent creates cannot exceed it.
    if (this.sessions.size + this.creating.size >= this.cfg.security.maxSessions) {
      throw new TgError(
        'RESOURCE_LIMIT_EXCEEDED',
        `Maximum of ${this.cfg.security.maxSessions} sessions reached`,
      );
    }
    const p = this.createUnlocked(opts, name, project);
    this.creating.set(k, p);
    try {
      return await p;
    } finally {
      this.creating.delete(k);
    }
  }

  private async createUnlocked(opts: CreateSessionOptions, name: string, project: string): Promise<Session> {
    const ctxOpts = this.contextOptions(opts);
    let restored: { cookies: number; origins: number } | undefined;
    if (opts.restore) {
      const { state } = this.store.load(project, name, this.cfg.sessions.expirationHours);
      const st = state as { cookies?: Array<{ expires: number }>; origins?: unknown[] };
      const now = Date.now() / 1000;
      st.cookies = (st.cookies ?? []).filter((c) => c.expires === -1 || c.expires > now);
      ctxOpts.storageState = st as BrowserContextOptions['storageState'];
      restored = { cookies: st.cookies.length, origins: st.origins?.length ?? 0 };
    }

    let context: BrowserContext;
    let browserId: string;
    const persistent = !!opts.persistent;
    if (persistent) {
      const dir =
        name === 'default' && project === this.cfg.project
          ? this.cfg.browser.userDataDir
          : path.join(this.cfg.dataDir, 'profiles', project, name);
      const spec = this.browsers.defaultSpec(opts.browser);
      const r = await this.browsers.persistentContext(dir, ctxOpts, spec);
      context = r.context;
      browserId = r.id;
      if (ctxOpts.storageState && typeof ctxOpts.storageState === 'object') {
        await context.addCookies(
          (ctxOpts.storageState as { cookies: Parameters<BrowserContext['addCookies']>[0] }).cookies ?? [],
        );
      }
    } else {
      const { id, browser } = await this.browsers.sharedBrowser(
        opts.browser ? this.browsers.defaultSpec(opts.browser) : undefined,
      );
      context = await browser.newContext(ctxOpts);
      browserId = id;
    }
    const session = await this.adopt(context, {
      name,
      project,
      browserId,
      persistent,
      connected: false,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      openPage: opts.openPage ?? true,
      restored,
      retainVideo: opts.recordVideo === undefined && this.cfg.recording.video === 'retain-on-failure',
      indicator: this.cfg.browser.indicator ?? !this.browsers.defaultSpec(opts.browser).headless,
    });
    if (opts.authContext !== undefined) session.authContext = opts.authContext;
    return session;
  }

  /** Attaches an existing Chromium (CDP). The session wraps the browser's default context. */
  async connect(endpoint: string, name = 'cdp'): Promise<Session> {
    assertSafeName('session', name);
    if (this.find(name)) throw new TgError('SESSION_EXISTS', `Session "${name}" already exists`);
    const { id, browser } = await this.browsers.connect(endpoint);
    const context = browser.contexts()[0] ?? (await browser.newContext(this.contextOptions({ name })));
    return this.adopt(context, {
      name,
      project: this.cfg.project,
      browserId: id,
      persistent: false,
      connected: true,
      openPage: context.pages().length === 0,
      indicator: this.cfg.browser.indicator ?? true,
    });
  }

  private async adopt(
    context: BrowserContext,
    o: {
      name: string;
      project: string;
      browserId: string;
      persistent: boolean;
      connected: boolean;
      agentId?: string;
      openPage: boolean;
      restored?: { cookies: number; origins: number } | undefined;
      indicator: boolean;
      retainVideo?: boolean;
    },
  ): Promise<Session> {
    context.setDefaultTimeout(this.cfg.browser.timeout);
    context.setDefaultNavigationTimeout(this.cfg.browser.navigationTimeout);
    const holder: { session?: Session } = {};
    const monitor = new NetworkMonitor(
      this.cfg.network.capture,
      this.redactor,
      (p) => holder.session?.pageIdOf(p),
      (type, entry) => {
        if (!holder.session) return;
        if (type === 'console.error')
          this.events.emit(type, {
            sessionId: holder.session.id,
            pageId: entry.pageId as string | undefined,
            text: String(entry.text),
            count: 1,
          });
        else
          this.events.emit(type, {
            sessionId: holder.session.id,
            pageId: entry.pageId as string | undefined,
            method: String(entry.method),
            url: String(entry.url),
            status: entry.status as number | null,
            failureCode: entry.failureCode as string | null,
          });
      },
    );
    const session = new Session(
      shortId('session'),
      o.name,
      o.project,
      context,
      o.browserId,
      monitor,
      o.persistent,
      o.connected,
      o.agentId,
    );
    holder.session = session;
    this.recordings.set(session.id, { retain: !!o.retainVideo, failed: false, videos: [] });
    monitor.attachContext(context);
    await this.installPolicy(context, monitor);
    await context.addInitScript(installScriptSource());
    if (o.indicator) {
      const label = `TG Browser MCP · ${o.name}`;
      await context.addInitScript(
        `(() => { const __name = (f) => f; (${installIndicator.toString()})(${JSON.stringify(label)}); })()`,
      );
    }

    context.on('page', (p) => {
      // Pages we open ourselves also fire `page`; only website-opened pages are reported as new tabs.
      const own = session.ownPagesPending > 0;
      if (own) session.ownPagesPending--;
      this.registerPage(session, p, !own);
    });
    context.on('close', () => {
      void this.finalizeVideos(session);
      this.events.emit('session.closed', { sessionId: session.id, name: session.name });
      session.status = 'closed';
      this.sessions.delete(this.key(session.project, session.name));
      if (this.activeKey === this.key(session.project, session.name)) this.activeKey = undefined;
    });
    for (const p of context.pages()) this.registerPage(session, p, false);
    if (o.openPage && session.pages.size === 0) {
      await this.openPage(session);
    }

    this.sessions.set(this.key(o.project, o.name), session);
    this.activeKey = this.key(o.project, o.name);
    this.events.emit('session.created', { sessionId: session.id, name: o.name, project: o.project });
    if (o.restored)
      this.events.emit('session.restored', {
        sessionId: session.id,
        name: o.name,
        project: o.project,
        ...o.restored,
      });
    return session;
  }

  /** Opens a tab on behalf of the agent (never reported as a website-opened popup). */
  async openPage(session: Session): Promise<PageState> {
    session.ownPagesPending++;
    let page: Page;
    try {
      page = await session.context.newPage();
    } catch (e) {
      session.ownPagesPending = Math.max(0, session.ownPagesPending - 1);
      throw e;
    }
    const st = this.registerPage(session, page, false);
    session.activePageId = st.id;
    return st;
  }

  registerPage(session: Session, page: Page, opener: boolean): PageState {
    const existingId = session.pageIdOf(page);
    if (existingId) return session.pages.get(existingId)!;
    if (session.pages.size >= this.cfg.security.maxPagesPerSession) {
      getLogger().warn({ session: session.name }, 'page limit reached; closing new page');
      void page.close().catch(() => undefined);
      throw new TgError(
        'RESOURCE_LIMIT_EXCEEDED',
        `Page limit (${this.cfg.security.maxPagesPerSession}) reached`,
      );
    }
    const st = new PageState(session.nextPageId(), page);
    session.pages.set(st.id, st);
    const video = page.video();
    if (video) this.recordings.get(session.id)?.videos.push({ pageId: st.id, video });
    session.monitor.attachPage(page);
    if (!session.activePageId || !opener) session.activePageId = st.id;
    if (opener) session.newPagesQueue.push(st.id);

    page.on('dialog', (d) => {
      this.events.emit('dialog.opened', {
        sessionId: session.id,
        pageId: st.id,
        type: d.type(),
        message: this.redactor.text(d.message()),
      });
      // beforeunload dialogs are accepted so navigations/closes are not blocked.
      if (d.type() === 'beforeunload') return void d.accept().catch(() => undefined);
      st.pendingDialog = {
        type: d.type(),
        message: this.redactor.text(d.message()).slice(0, 500),
        defaultValue: d.defaultValue(),
        dialog: d,
      };
    });
    page.on('framenavigated', (frame) => void this.checkCommittedUrl(frame.url(), () => frame, session));
    // Routes are not invoked for redirect hops: check them here and stop the navigation.
    page.on('request', (req) => {
      if (!req.isNavigationRequest() || !req.redirectedFrom()) return;
      void this.policy.check(req.url()).then(async (d) => {
        if (d.allowed) return;
        session.monitor.markBlocked(req.url());
        st.blockedNavigation = { url: safeUrlForLog(req.url()), reason: d.reason, at: Date.now() };
        getLogger().warn(
          { session: session.name, url: safeUrlForLog(req.url()), reason: d.reason },
          'blocked redirect',
        );
        let frame: import('playwright').Frame | undefined;
        try {
          frame = req.frame();
        } catch {
          frame = page.mainFrame();
        }
        if (frame === page.mainFrame()) {
          // Starting a new navigation cancels the pending (redirected) one on every engine.
          await page.goto('about:blank', { timeout: 5000 }).catch(() => undefined);
          await page.setContent(BLOCKED_PAGE(d.reason), { timeout: 5000 }).catch(() => undefined);
        } else {
          await frame.evaluate(() => window.stop(), undefined).catch(() => undefined);
        }
      });
    });
    page.on('close', () => {
      const recording = this.recordings.get(session.id);
      if (video && recording && !recording.retain) void this.saveVideo(session, st.id, video);
      session.pages.delete(st.id);
      if (session.activePageId === st.id) session.activePageId = [...session.pages.keys()].pop();
    });
    page.on('crash', () => getLogger().error({ session: session.name, page: st.id }, 'page crashed'));
    return st;
  }

  /**
   * Post-commit check: catches redirects (Playwright routes do not intercept redirect hops) and
   * replaces the document with a block page when the final URL violates policy.
   */
  private async checkCommittedUrl(
    url: string,
    frameFn: () => import('playwright').Frame,
    session: Session,
  ): Promise<void> {
    if (!url || url === 'about:blank' || url.startsWith('data:') || url.startsWith('chrome-error:')) return;
    const d = await this.policy.check(url);
    if (d.allowed) return;
    getLogger().warn(
      { session: session.name, url: safeUrlForLog(url), reason: d.reason },
      'blocked committed navigation',
    );
    const frame = frameFn();
    try {
      await frame.evaluate((html) => {
        document.open();
        document.write(html);
        document.close();
      }, BLOCKED_PAGE(d.reason));
    } catch {
      // frame may be gone
    }
  }

  private async installPolicy(context: BrowserContext, monitor: NetworkMonitor): Promise<void> {
    const all = this.cfg.security.enforceOnSubresources;
    await context.route('**/*', async (route) => {
      const req = route.request();
      if (!all && !req.isNavigationRequest()) return route.fallback();
      const d = await this.policy.check(req.url());
      if (d.allowed) return route.fallback();
      monitor.markBlocked(req.url());
      getLogger().warn(
        { url: safeUrlForLog(req.url()), reason: d.reason },
        'request blocked by domain policy',
      );
      if (req.isNavigationRequest()) {
        // Popups' first request has no frame yet; treat any navigation as a document load.
        let isMain = true;
        try {
          isMain = req.frame() === req.frame().page().mainFrame();
        } catch {
          isMain = true;
        }
        if (isMain)
          return route.fulfill({ status: 403, contentType: 'text/html', body: BLOCKED_PAGE(d.reason) });
      }
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket(/.*/, async (ws) => {
      const d = await this.policy.check(ws.url());
      if (!d.allowed) {
        getLogger().warn({ url: safeUrlForLog(ws.url()) }, 'websocket blocked by domain policy');
        return ws.close({ code: 1008, reason: 'Blocked by policy' });
      }
      ws.connectToServer();
    });
  }

  async save(
    nameOrId?: string,
    project?: string,
  ): Promise<{ name: string; project: string; cookies: number; origins: number; savedAt: string }> {
    const s = this.get(nameOrId, project);
    const state = await s.context.storageState({ indexedDB: true });
    const url = s.activePageId ? s.pages.get(s.activePageId)?.page.url() : undefined;
    const meta = this.store.save(s.project, s.name, state, {
      cookies: state.cookies.length,
      origins: state.origins.length,
      ...(url ? { url: safeUrlForLog(url) } : {}),
    });
    return {
      name: s.name,
      project: s.project,
      cookies: meta.cookies,
      origins: meta.origins,
      savedAt: meta.savedAt,
    };
  }

  /** Restores saved state by recreating the session's context. */
  async restore(name: string, project?: string): Promise<Session> {
    const proj = project ?? this.cfg.project;
    const existing = this.find(name, proj);
    const persistent = existing?.persistent ?? false;
    if (existing) await this.close(existing.name, proj);
    return this.create({ name, project: proj, restore: true, persistent });
  }

  async close(nameOrId: string, project?: string): Promise<void> {
    const s = this.get(nameOrId, project);
    s.status = 'closed';
    this.sessions.delete(this.key(s.project, s.name));
    if (this.activeKey === this.key(s.project, s.name)) this.activeKey = undefined;
    if (s.connected) {
      await this.browsers.close(s.browserId).catch(() => undefined);
    } else if (s.persistent) {
      await this.browsers.close(s.browserId).catch(() => undefined);
    } else {
      await s.context.close().catch(() => undefined);
    }
    await this.finalizeVideos(s);
  }

  private readonly savedVideos = new WeakMap<import('playwright').Video, Promise<void>>();
  private saveVideo(s: Session, pageId: string, video: import('playwright').Video): Promise<void> {
    const existing = this.savedVideos.get(video);
    if (existing) return existing;
    const work = (async () => {
      try {
        const file = await video.path();
        // saveAs waits for the recording to finish, including pages closed before their context.
        await video.saveAs(file);
        fs.chmodSync(file, 0o600);
        this.events.emit('video.saved', {
          sessionId: s.id,
          pageId,
          path: file,
          bytes: fs.statSync(file).size,
        });
      } catch {
        /* Recording failures must not break automation. */
      }
    })();
    this.savedVideos.set(video, work);
    return work;
  }

  private readonly finalizing = new Map<string, Promise<void>>();
  private finalizeVideos(s: Session): Promise<void> {
    const previous = this.finalizing.get(s.id);
    if (previous) return previous;
    const work = (async () => {
      const recording = this.recordings.get(s.id);
      for (const { pageId, video } of recording?.videos ?? []) {
        if (recording?.retain && !recording.failed) await video.delete().catch(() => undefined);
        else await this.saveVideo(s, pageId, video);
      }
      this.recordings.delete(s.id);
    })();
    this.finalizing.set(s.id, work);
    return work;
  }

  async closeAll(): Promise<void> {
    for (const s of [...this.sessions.values()]) await this.close(s.name, s.project).catch(() => undefined);
    await Promise.all(this.finalizing.values());
  }
}
