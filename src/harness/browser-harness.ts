import fs from 'node:fs';
import { SessionJournal } from '../journal/session-journal.js';
import type { TgConfig, TgConfigInput } from '../config/schema.js';
import { isParsedConfig, parseConfig } from '../config/load-config.js';
import { BrowserManager } from '../browser/browser-manager.js';
import { SessionManager, type CreateSessionOptions } from '../session/session-manager.js';
import { SessionStore } from '../session/session-store.js';
import { DomainPolicy } from '../security/domain-policy.js';
import { DataRedactor } from '../security/data-redactor.js';
import { PermissionManager, type ApprovalHandler } from '../security/permission-manager.js';
import { AuditLogger } from '../security/audit-logger.js';
import { ProxyManager } from '../network/proxy-manager.js';
import { CertificateManager } from '../network/certificate-manager.js';
import { diagnose } from '../network/network-diagnostics.js';
import { TypedEmitter, type HarnessEventMap, type HarnessEventName } from '../shared/events.js';
import { ActionExecutor, type ActionContext, type ActionResult } from './action-executor.js';
import type { Target } from './target.js';
import type { Session } from '../session/session.js';

/**
 * Framework-independent browser automation harness. The MCP server is one consumer; TG Studio
 * or any Node.js program can use it directly:
 *
 *   const harness = new BrowserHarness({ browser: { headless: true } });
 *   const s = await harness.createSession({ name: 'frontend-agent' });
 *   await s.navigate('http://localhost:4200');
 *   console.log((await s.snapshot()).text);
 *   await s.click({ role: 'button', name: 'Create' });
 */
export class BrowserHarness {
  readonly journal: SessionJournal;
  readonly config: TgConfig;
  readonly events = new TypedEmitter();
  readonly policy: DomainPolicy;
  readonly redactor: DataRedactor;
  readonly permissions: PermissionManager;
  readonly audit: AuditLogger;
  readonly proxy: ProxyManager;
  readonly certificates: CertificateManager;
  readonly browsers: BrowserManager;
  readonly sessions: SessionManager;
  readonly store: SessionStore;
  readonly actions: ActionExecutor;
  private closed = false;

  constructor(config: TgConfig | TgConfigInput = {}) {
    this.config = isParsedConfig(config) ? config : parseConfig(config);
    fs.mkdirSync(this.config.dataDir, { recursive: true, mode: 0o700 });
    this.policy = new DomainPolicy(this.config.security);
    this.redactor = new DataRedactor(this.config.security.sensitiveFields);
    this.journal = new SessionJournal(this.config, this.redactor, this.events);
    this.permissions = new PermissionManager(this.config);
    this.audit = new AuditLogger(this.config.dataDir);
    this.proxy = new ProxyManager(this.config.network);
    this.certificates = new CertificateManager(this.config.network.tls);
    this.browsers = new BrowserManager(this.config, this.proxy, this.permissions, this.events);
    this.store = new SessionStore(this.config.dataDir, this.config.sessions.encrypt);
    this.sessions = new SessionManager(
      this.config,
      this.browsers,
      this.policy,
      this.redactor,
      this.store,
      this.events,
    );
    this.actions = new ActionExecutor(
      this.config,
      this.sessions,
      this.policy,
      this.permissions,
      this.redactor,
      this.events,
    );
  }

  on<K extends HarnessEventName>(event: K, listener: (payload: HarnessEventMap[K]) => void): () => void {
    return this.events.on(event, listener);
  }

  setApprovalHandler(h: ApprovalHandler | undefined): void {
    this.permissions.setApprovalHandler(h);
  }

  async createSession(
    opts: CreateSessionOptions & { browser?: CreateSessionOptions['browser'] | string },
  ): Promise<HarnessSession> {
    const { browser, ...rest } = opts;
    let spec: CreateSessionOptions['browser'];
    if (typeof browser === 'string') {
      const { browserShortcut } = await import('../config/load-config.js');
      spec = browserShortcut(browser);
    } else spec = browser;
    const s = await this.sessions.create({ ...rest, ...(spec ? { browser: spec } : {}) });
    return new HarnessSession(this, s.name, s.project);
  }

  session(name: string, project?: string): HarnessSession {
    const s = this.sessions.get(name, project);
    return new HarnessSession(this, s.name, s.project);
  }

  diagnose(url: string) {
    return diagnose(url, { proxy: this.proxy, certs: this.certificates, policy: this.policy });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.sessions.closeAll();
    await this.browsers.closeAll();
  }
}

/** Convenience facade bound to one session. */
export class HarnessSession {
  constructor(
    private readonly h: BrowserHarness,
    readonly name: string,
    readonly project: string,
  ) {}

  private get ctx(): ActionContext {
    return { session: this.name, project: this.project };
  }

  get raw(): Session {
    return this.h.sessions.get(this.name, this.project);
  }

  navigate(
    url: string,
    opts: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' } & Pick<ActionContext, 'expect'> = {},
  ): Promise<ActionResult> {
    return this.h.actions.navigate(url, { ...this.ctx, ...opts });
  }
  async snapshot(opts: { scope?: string; page?: number; interactiveOnly?: boolean } = {}) {
    return this.h.actions.snapshot(opts, this.ctx);
  }
  click(
    target: Target,
    opts: Parameters<ActionExecutor['click']>[1] & Pick<ActionContext, 'expect'> = {},
  ): Promise<ActionResult> {
    return this.h.actions.click(target, opts, { ...this.ctx, ...opts });
  }
  fill(
    target: Target,
    value: string,
    opts: { submit?: boolean } & Pick<ActionContext, 'expect'> = {},
  ): Promise<ActionResult> {
    return this.h.actions.fill(target, value, opts, { ...this.ctx, ...opts });
  }
  fillForm(
    fields: Parameters<ActionExecutor['fillForm']>[0],
    opts: import('./form-filler.js').FillOptions & Pick<ActionContext, 'expect'> = {},
  ): Promise<ActionResult> {
    return this.h.actions.fillForm(
      fields,
      { ...this.ctx, ...(opts.expect ? { expect: opts.expect } : {}) },
      opts,
    );
  }
  type(
    target: Target | undefined,
    text: string,
    opts: Parameters<ActionExecutor['type']>[2] & Pick<ActionContext, 'expect'> = {},
  ): Promise<ActionResult> {
    return this.h.actions.type(target, text, opts, { ...this.ctx, ...opts });
  }
  press(key: string, target?: Target, opts: Pick<ActionContext, 'expect'> = {}): Promise<ActionResult> {
    return this.h.actions.press(key, target, { ...this.ctx, ...opts });
  }
  select(
    target: Target,
    values: string | string[],
    opts: Pick<ActionContext, 'expect'> = {},
  ): Promise<ActionResult> {
    return this.h.actions.selectOption(target, Array.isArray(values) ? values : [values], {
      ...this.ctx,
      ...opts,
    });
  }
  check(target: Target, checked = true, opts: Pick<ActionContext, 'expect'> = {}): Promise<ActionResult> {
    return this.h.actions.setChecked(target, checked, { ...this.ctx, ...opts });
  }
  hover(target: Target, opts: Pick<ActionContext, 'expect'> = {}): Promise<ActionResult> {
    return this.h.actions.hover(target, { ...this.ctx, ...opts });
  }
  wait(opts: Parameters<ActionExecutor['wait']>[0]): Promise<ActionResult> {
    return this.h.actions.wait(opts, this.ctx);
  }
  text(target?: Target): Promise<string> {
    return this.h.actions.getText(target, {}, this.ctx);
  }
  screenshot(opts: Parameters<ActionExecutor['screenshot']>[0] = {}) {
    return this.h.actions.screenshot(opts, this.ctx);
  }
  dialog(
    accept: boolean,
    promptText?: string,
    opts: Pick<ActionContext, 'expect'> = {},
  ): Promise<ActionResult> {
    return this.h.actions.dialog(accept, promptText, { ...this.ctx, ...opts });
  }
  save() {
    return this.h.sessions.save(this.name, this.project);
  }
  close(): Promise<void> {
    return this.h.sessions.close(this.name, this.project);
  }
}
