import fs from 'node:fs';
import path from 'node:path';
import type { TgConfig } from '../config/schema.js';
import type { DomainPolicy } from '../security/domain-policy.js';
import { safeUrlForLog } from '../security/domain-policy.js';
import { WRITE_EXTENSIONS, type PermissionManager } from '../security/permission-manager.js';
import {
  PolicyGate,
  keyActivation,
  probeActivation,
  textActivations,
  type KeyActivation,
  type PolicyCandidate,
} from '../security/policy-gate.js';
import type { DataRedactor } from '../security/data-redactor.js';
import type { TypedEmitter } from '../shared/events.js';
import type { LockHolder, Release } from '../shared/async-lock.js';
import { currentScope, markDispatched } from './call-scope.js';
import type { SessionManager } from '../session/session-manager.js';
import type { PageState, Session } from '../session/session.js';
import { captureSnapshot, formatSnapshot, type Snapshot } from '../snapshot/snapshot-engine.js';
import { diffSnapshots, formatDiff, type SnapshotDiff } from '../snapshot/snapshot-diff.js';
import { formatConsole, formatNetwork } from '../network/network-monitor.js';
import { TgError, toTgError } from '../shared/errors.js';
import { shortId, sleep, truncate } from '../shared/util.js';
import {
  describeTarget,
  hasTarget,
  resolveTarget,
  suggestLocator,
  type Resolved,
  type Target,
} from './target.js';
import { selectCustomOption } from '../adapters/generic/combobox.js';
import { INDICATOR_HIDE_CSS } from '../browser/indicator.js';
import type { ElementDescription } from '../snapshot/injected.js';

export type SnapshotMode = 'diff' | 'full' | 'none';

export interface ActionContext {
  session?: string;
  /** Project namespace of `session` (default: the configured project). */
  project?: string;
  pageId?: string;
  snapshot?: SnapshotMode;
  correlationId?: string;
}

export interface ActionResult {
  success: true;
  sessionId: string;
  session: string;
  pageId: string;
  action: string;
  message: string;
  durationMs: number;
  url: string;
  diff?: SnapshotDiff;
  /** Formatted diff or full snapshot text, ready to show to the model. */
  pageState?: string;
  warnings: string[];
  newPages?: Array<{ pageId: string; url: string }>;
  dialog?: { type: string; message: string };
  errors?: { console: string; network: string };
  data?: unknown;
  image?: { base64: string; mimeType: string };
}

/** Information handed to the workflow recorder after each successful action. */
export interface RecordedAction {
  session: string;
  action: string;
  target?: Target;
  locatorExpr?: string;
  input: Record<string, unknown>;
  url: string;
  sensitive: boolean;
}

const SETTLE_MAX_MS = 2000;
/** Budget kept free after the Playwright action for settle, snapshot and formatting. */
const INNER_MARGIN_MS = SETTLE_MAX_MS + 3000;
const MIN_INNER_TIMEOUT_MS = 500;

export class ActionExecutor {
  onRecorded: ((a: RecordedAction) => void) | undefined;
  private readonly gate: PolicyGate;

  constructor(
    private readonly cfg: TgConfig,
    private readonly sessions: SessionManager,
    private readonly policy: DomainPolicy,
    private readonly permissions: PermissionManager,
    private readonly redactor: DataRedactor,
    private readonly events: TypedEmitter,
  ) {
    this.gate = new PolicyGate(permissions);
  }

  get artifactsDir(): string {
    return path.join(this.cfg.dataDir, 'artifacts');
  }

  private async sessionFor(name?: string, project?: string): Promise<Session> {
    return name ? this.sessions.get(name, project) : this.sessions.ensureActive();
  }

  private async ensurePage(s: Session, pageId?: string): Promise<PageState> {
    if (pageId) return s.page(pageId);
    if (s.activePageId && s.pages.get(s.activePageId) && !s.pages.get(s.activePageId)!.page.isClosed())
      return s.page();
    return this.sessions.openPage(s);
  }

  private snapshotOpts() {
    return {
      maxDepth: this.cfg.snapshot.maxDepth,
      maxTextLength: this.cfg.snapshot.maxTextLength,
      includeText: this.cfg.snapshot.includeText,
      sensitiveKeys: [
        'password',
        'passwd',
        'secret',
        'token',
        'otp',
        'cvv',
        'cvc',
        'ssn',
        'pin',
        'card',
        ...this.cfg.security.sensitiveFields,
      ],
      maxChars: this.cfg.snapshot.maxChars,
    };
  }

  /** Waits until requests started by the action complete (bounded), so the diff reflects the result. */
  private async settle(s: Session, ps: PageState, startSeq: number): Promise<void> {
    const deadline = Date.now() + SETTLE_MAX_MS;
    await ps.page.waitForLoadState('domcontentloaded', { timeout: SETTLE_MAX_MS }).catch(() => undefined);
    while (Date.now() < deadline) {
      if (ps.pendingDialog) return;
      const pending = s.monitor
        .network({ sinceSeq: startSeq, limit: 500 })
        .entries.filter(
          (e) =>
            e.status === null &&
            e.failure === null &&
            ['xhr', 'fetch', 'document', 'script'].includes(e.resourceType),
        );
      if (pending.length === 0) break;
      await sleep(50);
    }
    await sleep(60);
  }

  private async finish(
    s: Session,
    ps: PageState,
    action: string,
    message: string,
    t0: number,
    startSeq: number,
    mode: SnapshotMode,
    extra: Partial<ActionResult> = {},
  ): Promise<ActionResult> {
    await this.settle(s, ps, startSeq);
    const res: ActionResult = {
      success: true,
      sessionId: s.id,
      session: s.name,
      pageId: ps.id,
      action,
      message,
      durationMs: 0,
      url: this.redactor.url(ps.page.url()),
      warnings: [],
      ...extra,
    };
    if (ps.pendingDialog) {
      res.dialog = { type: ps.pendingDialog.type, message: ps.pendingDialog.message };
      res.warnings.push(
        `A ${ps.pendingDialog.type} dialog is open: "${ps.pendingDialog.message}". Call browser_dialog to accept or dismiss it.`,
      );
    } else if (mode !== 'none' && !ps.page.isClosed()) {
      const prev = ps.lastSnapshot;
      const next = await captureSnapshot(ps.page, ps.refs, this.snapshotOpts());
      ps.lastSnapshot = next;
      if (mode === 'diff' && prev && prev.docId === next.docId) {
        res.diff = diffSnapshots(prev, next);
        res.pageState = formatDiff(res.diff);
      } else {
        res.pageState = formatSnapshot(next, { maxChars: this.cfg.snapshot.maxChars }).text;
      }
    }
    const fresh = s.newPagesQueue.splice(0);
    if (fresh.length)
      res.newPages = fresh.map((id) => ({
        pageId: id,
        url: this.redactor.url(s.pages.get(id)?.page.url() ?? ''),
      }));
    const errs = s.monitor.errors(undefined, startSeq);
    if (errs.console.length || errs.network.length) {
      res.errors = {
        console: formatConsole(errs.console.slice(-5)),
        network: formatNetwork(errs.network.slice(-5)),
      };
    }
    res.durationMs = Date.now() - t0;
    return res;
  }

  /**
   * Common wrapper: resolves session/page, emits lifecycle events, races against dialogs that
   * would otherwise block the action, normalizes errors.
   */
  private async run(
    ctx: ActionContext,
    action: string,
    targetDesc: string | undefined,
    fn: (
      s: Session,
      ps: PageState,
    ) => Promise<{ message: string; extra?: Partial<ActionResult>; mode?: SnapshotMode }>,
  ): Promise<ActionResult> {
    const correlationId = ctx.correlationId ?? shortId('act');
    const s = await this.sessionFor(ctx.session, ctx.project);
    const ps = await this.ensurePage(s, ctx.pageId);
    const release = await this.lockPage(ps, targetDesc ? `${action} ${targetDesc}` : action);
    const t0 = Date.now();
    const startSeq = s.monitor.lastSeq;
    this.events.emit('action.started', {
      sessionId: s.id,
      pageId: ps.id,
      action,
      ...(targetDesc ? { target: targetDesc } : {}),
      correlationId,
    });
    try {
      if (ps.pendingDialog && action !== 'dialog') {
        throw new TgError(
          'ACTION_FAILED',
          `A ${ps.pendingDialog.type} dialog is blocking the page: "${ps.pendingDialog.message}"`,
          { suggestion: 'Call browser_dialog with accept=true or false first.' },
        );
      }
      const dialogWatch = new Promise<'dialog'>((resolve) => {
        const h = () => resolve('dialog');
        ps.page.once('dialog', h);
        setTimeout(() => ps.page.off('dialog', h), this.cfg.browser.timeout + 1000).unref?.();
      });
      if (action !== 'wait') markDispatched();
      const work = fn(s, ps);
      // If a dialog wins the race, the blocked action may reject later; never leave it unhandled.
      work.catch(() => undefined);
      type Out = { message: string; extra?: Partial<ActionResult>; mode?: SnapshotMode };
      const out: Out = await Promise.race([
        work,
        dialogWatch.then((): Out => ({ message: `${action} triggered a dialog` })),
      ]);
      const res = await this.finish(
        s,
        ps,
        action,
        out.message,
        t0,
        startSeq,
        out.mode ?? ctx.snapshot ?? 'diff',
        out.extra,
      );
      this.events.emit('action.completed', {
        sessionId: s.id,
        pageId: ps.id,
        action,
        durationMs: res.durationMs,
        correlationId,
      });
      return res;
    } catch (e) {
      const err = toTgError(e, 'ACTION_FAILED');
      if (targetDesc && !err.context.target) err.context.target = targetDesc;
      this.events.emit('action.failed', {
        sessionId: s.id,
        pageId: ps.id,
        action,
        code: err.code,
        message: err.message,
        correlationId,
      });
      throw err;
    } finally {
      release();
    }
  }

  private record(
    s: Session,
    action: string,
    r: Resolved | undefined,
    input: Record<string, unknown>,
    url: string,
    sensitive = false,
  ): void {
    if (!this.onRecorded) return;
    const loc = r ? suggestLocator(r.desc) : undefined;
    this.onRecorded({
      session: s.name,
      action,
      ...(loc ? { target: r?.recordingTarget ?? loc.target, locatorExpr: loc.expr } : {}),
      input,
      url,
      sensitive,
    });
  }

  /** Node-side sensitivity check for a resolved element (password inputs, sensitive names/labels/ids). */
  isSensitiveField(desc: ElementDescription): boolean {
    return (
      desc.inputType === 'password' ||
      this.redactor.isSensitiveKey(desc.name || '') ||
      this.redactor.isSensitiveKey(desc.label || '') ||
      this.redactor.isSensitiveKey(desc.id || '')
    );
  }

  // ───────────────────────── Policy gate (S-01) ─────────────────────────

  private static self(r: Resolved): PolicyCandidate {
    return { name: r.desc.name, role: r.desc.role, via: 'target' };
  }

  /**
   * Elements a key activation would trigger: on the resolved target, or on the focused element of every
   * frame for page-level keys (the keyboard goes to whichever frame has focus).
   */
  private async activationTargets(
    ps: PageState,
    r: Resolved | undefined,
    mode: KeyActivation,
  ): Promise<PolicyCandidate[]> {
    const out: PolicyCandidate[] = [];
    const push = (list: Array<{ name: string; role: string; via: 'self' | 'submit' | 'form' }>) => {
      for (const p of list)
        out.push({ name: p.name, role: p.role, via: p.via === 'self' ? (r ? 'target' : 'focused') : p.via });
    };
    if (r) {
      const probed = await (
        r.kind === 'handle'
          ? r.handle.evaluate(probeActivation, mode)
          : r.locator.evaluate(probeActivation, mode, { timeout: this.timeout() })
      ).catch(() => undefined);
      // The engine-provided accessible name is checked too (Enter always, Space when it activates).
      if (mode === 'enter' || !probed || probed.some((p) => p.via === 'self'))
        out.push(ActionExecutor.self(r));
      if (probed) push(probed);
      return out;
    }
    for (const f of ps.page.frames()) {
      const h = await f
        .evaluateHandle(() => {
          let e = document.activeElement;
          while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
          return e;
        })
        .catch(() => undefined);
      const el = h?.asElement();
      if (!el) {
        await h?.dispose().catch(() => undefined);
        continue;
      }
      const probed = await el.evaluate(probeActivation, mode).catch(() => undefined);
      await el.dispose().catch(() => undefined);
      if (probed) push(probed);
    }
    return out;
  }

  /** Gates key activations (Enter/Space, typed newlines/spaces, submit) on the effective target. */
  private async gateActivations(
    ps: PageState,
    r: Resolved | undefined,
    modes: KeyActivation[],
    verb: string,
  ): Promise<void> {
    for (const mode of [...new Set(modes)]) {
      const candidates = await this.activationTargets(ps, r, mode);
      await this.gate.enforce({ verb, url: ps.page.url(), candidates });
    }
  }

  // ───────────────────────── Navigation ─────────────────────────

  async navigate(
    url: string,
    ctx: ActionContext & { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' } = {},
  ): Promise<ActionResult> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new TgError(
        'INVALID_ARGUMENT',
        `Invalid URL "${truncate(url, 100)}". Use an absolute URL such as http://localhost:4200/`,
      );
    }
    await this.policy.assertAllowed(parsed.toString());
    return this.run({ snapshot: 'full', ...ctx }, 'navigate', safeUrlForLog(url), async (s, ps) => {
      this.events.emit('navigation.started', { sessionId: s.id, pageId: ps.id, url: safeUrlForLog(url) });
      const t = Date.now();
      let status: number | undefined;
      ps.blockedNavigation = undefined;
      const blocked = () => {
        const b = ps.blockedNavigation;
        if (b && b.at >= t)
          throw new TgError('DOMAIN_NOT_ALLOWED', `Redirect blocked: ${b.reason}`, {
            context: { url: b.url },
          });
      };
      try {
        const resp = await ps.page.goto(parsed.toString(), {
          waitUntil: ctx.waitUntil ?? 'domcontentloaded',
          timeout: this.timeout(this.cfg.browser.navigationTimeout),
        });
        status = resp?.status();
      } catch (e) {
        blocked();
        const err = toTgError(e, 'NAVIGATION_FAILED');
        err.context.url = safeUrlForLog(url);
        throw err;
      }
      blocked();
      const final = ps.page.url();
      const d = await this.policy.check(final);
      if (!d.allowed)
        throw new TgError('DOMAIN_NOT_ALLOWED', `Redirected to a blocked destination: ${d.reason}`, {
          context: { url: safeUrlForLog(final) },
        });
      ps.lastSnapshot = undefined;
      this.events.emit('navigation.completed', {
        sessionId: s.id,
        pageId: ps.id,
        url: safeUrlForLog(final),
        ...(status !== undefined ? { status } : {}),
        durationMs: Date.now() - t,
      });
      this.record(s, 'navigate', undefined, { url: parsed.toString() }, final);
      const warn = status && status >= 400 ? { warnings: [`HTTP ${status}`] } : {};
      return {
        message: `Navigated to ${this.redactor.url(final)}${status ? ` (HTTP ${status})` : ''}`,
        extra: { ...warn, data: { status } },
      };
    });
  }

  async history(kind: 'back' | 'forward' | 'reload', ctx: ActionContext = {}): Promise<ActionResult> {
    return this.run({ snapshot: 'full', ...ctx }, kind, undefined, async (_s, ps) => {
      const o = { timeout: this.timeout(this.cfg.browser.navigationTimeout) };
      const resp =
        kind === 'back'
          ? await ps.page.goBack(o)
          : kind === 'forward'
            ? await ps.page.goForward(o)
            : await ps.page.reload(o);
      ps.lastSnapshot = undefined;
      if (!resp && kind !== 'reload') return { message: `No ${kind} history entry`, mode: 'none' };
      return { message: `${kind} → ${this.redactor.url(ps.page.url())}` };
    });
  }

  async wait(
    opts: {
      text?: string;
      textGone?: string;
      target?: Target;
      state?: 'visible' | 'hidden' | 'attached' | 'detached';
      url?: string;
      loadState?: 'load' | 'domcontentloaded' | 'networkidle';
      timeMs?: number;
      timeout?: number;
    },
    ctx: ActionContext = {},
  ): Promise<ActionResult> {
    return this.run(ctx, 'wait', undefined, async (_s, ps) => {
      const timeout = Math.min(opts.timeout ?? this.cfg.browser.timeout, 120_000);
      const frame = ps.frame();
      const done: string[] = [];
      if (opts.timeMs) {
        await ps.page.waitForTimeout(Math.min(opts.timeMs, 30_000));
        done.push(`${opts.timeMs}ms`);
      }
      if (opts.loadState) {
        await ps.page.waitForLoadState(opts.loadState, { timeout });
        done.push(opts.loadState);
      }
      if (opts.url) {
        await ps.page.waitForURL(
          opts.url.startsWith('/') && opts.url.endsWith('/') && opts.url.length > 2
            ? new RegExp(opts.url.slice(1, -1))
            : opts.url,
          { timeout },
        );
        done.push(`url ${opts.url}`);
      }
      if (opts.text) {
        await frame.getByText(opts.text).first().waitFor({ state: 'visible', timeout });
        done.push(`text "${opts.text}" visible`);
      }
      if (opts.textGone) {
        await frame.getByText(opts.textGone).first().waitFor({ state: 'hidden', timeout });
        done.push(`text "${opts.textGone}" gone`);
      }
      if (opts.target && hasTarget(opts.target)) {
        const state = opts.state ?? 'visible';
        if (opts.target.ref) {
          const r = await resolveTarget(ps, opts.target, timeout);
          if (r.kind === 'handle')
            await r.handle.waitForElementState(state === 'visible' ? 'visible' : 'hidden', { timeout });
        } else {
          const r = await resolveTarget(ps, opts.target, timeout).catch((e) => {
            if (state === 'detached' || state === 'hidden') return undefined;
            throw e;
          });
          if (r?.kind === 'locator') await r.locator.waitFor({ state, timeout });
        }
        done.push(`${describeTarget(opts.target)} ${state}`);
      }
      if (!done.length)
        throw new TgError(
          'INVALID_ARGUMENT',
          'wait needs one of: text, textGone, target, url, loadState, timeMs',
        );
      return { message: `Waited for ${done.join(', ')}` };
    });
  }

  // ───────────────────────── Interaction ─────────────────────────

  /**
   * Playwright-level timeout: the configured action timeout, capped below the caller's remaining budget
   * (minus settle + snapshot margin) so an outer tool/step timeout is a last resort (TGB-007).
   */
  private timeout(base = this.cfg.browser.timeout): number {
    const scope = currentScope();
    if (!scope) return base;
    const left = scope.deadline - Date.now() - INNER_MARGIN_MS;
    return Math.max(MIN_INNER_TIMEOUT_MS, Math.min(base, left));
  }

  /**
   * Acquires the page lock (TGB-009). Waits at most for the caller's remaining budget (or the action
   * timeout); a page whose previous action timed out but is still running reports PAGE_BUSY.
   */
  private async lockPage(ps: PageState, label: string): Promise<Release> {
    const scope = currentScope();
    const waitMs = scope ? scope.deadline - Date.now() : this.cfg.browser.timeout;
    const busy = (h: LockHolder | undefined) =>
      new TgError(
        'PAGE_BUSY',
        h
          ? `Page ${ps.id} is busy: "${h.label}" has been running for ${Date.now() - h.since}ms${h.abandoned ? ' after its caller timed out' : ''}`
          : `Page ${ps.id} is busy`,
        { retryable: true, context: { pageId: ps.id, ...(h ? { busyWith: h.label } : {}) } },
      );
    const release = await ps.lock.acquire(label, { waitMs, signal: scope?.signal, busyError: busy });
    scope?.held.add(ps.lock);
    return () => {
      scope?.held.delete(ps.lock);
      release();
    };
  }

  /** Runs a read-only inspection under the page lock (snapshots allocate refs; inspections resolve them). */
  private async locked<T>(ps: PageState, label: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.lockPage(ps, label);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async click(
    target: Target,
    opts: {
      button?: 'left' | 'right' | 'middle';
      modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
      doubleClick?: boolean;
      force?: boolean;
    } = {},
    ctx: ActionContext = {},
  ): Promise<ActionResult> {
    const action = opts.doubleClick ? 'double_click' : 'click';
    return this.run(ctx, action, describeTarget(target), async (s, ps) => {
      const r = await resolveTarget(ps, target, this.timeout());
      await this.gate.enforce({ verb: 'Click', url: ps.page.url(), candidates: [ActionExecutor.self(r)] });
      const o = {
        timeout: this.timeout(),
        ...(opts.button ? { button: opts.button } : {}),
        ...(opts.modifiers ? { modifiers: opts.modifiers } : {}),
      };
      const el = r.kind === 'handle' ? r.handle : r.locator;
      if (opts.doubleClick) await el.dblclick(o);
      else await el.click(o);
      this.record(s, action, r, opts.button ? { button: opts.button } : {}, ps.page.url());
      return {
        message: `${opts.doubleClick ? 'Double-clicked' : 'Clicked'} ${r.desc.role} "${truncate(r.desc.name, 60)}"`,
      };
    });
  }

  async hover(target: Target, ctx: ActionContext = {}): Promise<ActionResult> {
    return this.run(ctx, 'hover', describeTarget(target), async (s, ps) => {
      const r = await resolveTarget(ps, target, this.timeout());
      await (r.kind === 'handle' ? r.handle : r.locator).hover({ timeout: this.timeout() });
      this.record(s, 'hover', r, {}, ps.page.url());
      return { message: `Hovered ${r.desc.role} "${truncate(r.desc.name, 60)}"` };
    });
  }

  async fill(
    target: Target,
    value: string,
    opts: { submit?: boolean } = {},
    ctx: ActionContext = {},
  ): Promise<ActionResult> {
    return this.run(ctx, 'fill', describeTarget(target), async (s, ps) => {
      const r = await resolveTarget(ps, target, this.timeout(), opts.submit ? 'action' : 'input');
      const sensitive = this.isSensitiveField(r.desc);
      const el = r.kind === 'handle' ? r.handle : r.locator;
      if (r.desc.native === 'select')
        throw new TgError('INVALID_ARGUMENT', 'Target is a <select>; use browser_select_option');
      if (opts.submit) await this.gateActivations(ps, r, ['enter'], 'Submit');
      await el.fill(value, { timeout: this.timeout() });
      if (opts.submit) await el.press('Enter', { timeout: this.timeout() });
      this.record(
        s,
        'fill',
        r,
        { value, ...(opts.submit ? { submit: true } : {}) },
        ps.page.url(),
        sensitive,
      );
      return {
        message: `Filled ${r.desc.role} "${truncate(r.desc.name || r.desc.label || '', 60)}" with ${sensitive ? '[redacted]' : JSON.stringify(truncate(value, 40))}${opts.submit ? ' and pressed Enter' : ''}`,
      };
    });
  }

  /** Fills several fields in one call (fewer round trips and tokens). */
  async fillForm(
    fields: Array<{ target: Target; value: string | boolean }>,
    ctx: ActionContext = {},
  ): Promise<ActionResult> {
    return this.run(ctx, 'fill_form', `${fields.length} fields`, async (s, ps) => {
      const done: string[] = [];
      for (const f of fields) {
        const r = await resolveTarget(ps, f.target, this.timeout());
        const el = r.kind === 'handle' ? r.handle : r.locator;
        const sensitive = this.isSensitiveField(r.desc);
        if (typeof f.value === 'boolean') {
          await this.gate.enforce({
            verb: f.value ? 'Check' : 'Uncheck',
            url: ps.page.url(),
            candidates: [ActionExecutor.self(r)],
          });
          if (f.value) await el.check({ timeout: this.timeout() });
          else await el.uncheck({ timeout: this.timeout() });
          this.record(s, f.value ? 'check' : 'uncheck', r, {}, ps.page.url());
        } else if (r.desc.native === 'select' || (r.desc.role === 'combobox' && !r.desc.editable)) {
          const value = f.value;
          await this.gate.enforce({
            verb: 'Select',
            url: ps.page.url(),
            candidates: [ActionExecutor.self(r), { name: value, via: 'option' }],
          });
          if (r.desc.native === 'select')
            await el
              .selectOption({ label: value }, { timeout: this.timeout() })
              .catch(() => el.selectOption(value, { timeout: this.timeout() }));
          else await selectCustomOption(ps, r, [value], this.timeout());
          this.record(s, 'select', r, { values: [value] }, ps.page.url());
        } else {
          await el.fill(f.value, { timeout: this.timeout() });
          this.record(s, 'fill', r, { value: f.value }, ps.page.url(), sensitive);
        }
        done.push(r.desc.name || r.desc.label || describeTarget(f.target));
      }
      return { message: `Filled ${done.length} fields: ${done.map((d) => truncate(d, 30)).join(', ')}` };
    });
  }

  async type(
    target: Target | undefined,
    text: string,
    opts: { delayMs?: number; submit?: boolean } = {},
    ctx: ActionContext = {},
  ): Promise<ActionResult> {
    return this.run(ctx, 'type', target ? describeTarget(target) : 'focused element', async (s, ps) => {
      let r: Resolved | undefined;
      const delay = Math.min(opts.delayMs ?? 0, 500);
      if (target && hasTarget(target))
        r = await resolveTarget(ps, target, this.timeout(), opts.submit ? 'action' : 'input');
      const modes = textActivations(text);
      if (opts.submit) modes.push('enter');
      if (modes.length) await this.gateActivations(ps, r, modes, opts.submit ? 'Submit' : 'Type into');
      if (r) {
        if (r.kind === 'handle') {
          await r.handle.focus();
          await ps.page.keyboard.type(text, { delay });
        } else await r.locator.pressSequentially(text, { delay, timeout: this.timeout() });
      } else await ps.page.keyboard.type(text, { delay });
      if (opts.submit) await ps.page.keyboard.press('Enter');
      const sensitive = r ? this.isSensitiveField(r.desc) : false;
      this.record(s, 'type', r, { text, ...(opts.submit ? { submit: true } : {}) }, ps.page.url(), sensitive);
      return { message: `Typed ${sensitive ? '[redacted]' : JSON.stringify(truncate(text, 40))}` };
    });
  }

  async press(key: string, target: Target | undefined, ctx: ActionContext = {}): Promise<ActionResult> {
    if (!/^[A-Za-z0-9+]+$|^.$/.test(key))
      throw new TgError(
        'INVALID_ARGUMENT',
        `Invalid key "${key}". Examples: Enter, Tab, Escape, ArrowDown, Control+a`,
      );
    return this.run(ctx, 'press_key', target ? describeTarget(target) : undefined, async (s, ps) => {
      let r: Resolved | undefined;
      if (target && hasTarget(target)) r = await resolveTarget(ps, target, this.timeout());
      const mode = keyActivation(key);
      if (mode) await this.gateActivations(ps, r, [mode], `Press ${key} on`);
      if (r) await (r.kind === 'handle' ? r.handle : r.locator).press(key, { timeout: this.timeout() });
      else await ps.page.keyboard.press(key);
      this.record(s, 'press', r, { key }, ps.page.url());
      return { message: `Pressed ${key}` };
    });
  }

  async selectOption(target: Target, values: string[], ctx: ActionContext = {}): Promise<ActionResult> {
    return this.run(ctx, 'select_option', describeTarget(target), async (s, ps) => {
      const r = await resolveTarget(ps, target, this.timeout());
      await this.gate.enforce({
        verb: 'Select',
        url: ps.page.url(),
        candidates: [
          ActionExecutor.self(r),
          ...values.map((v): PolicyCandidate => ({ name: v, via: 'option' })),
        ],
      });
      let chosen: string[];
      if (r.desc.native === 'select') {
        const el = r.kind === 'handle' ? r.handle : r.locator;
        // Match by label first, then by value.
        try {
          chosen = await el.selectOption(
            values.map((label) => ({ label })),
            { timeout: 3000 },
          );
        } catch {
          chosen = await el.selectOption(values, { timeout: this.timeout() });
        }
      } else {
        // Custom ARIA comboboxes/listboxes (Angular Material mat-select, PrimeNG p-select, ...).
        chosen = await selectCustomOption(ps, r, values, this.timeout());
      }
      this.record(s, 'select', r, { values }, ps.page.url());
      return {
        message: `Selected ${(chosen.length === values.length ? values : chosen).map((c) => JSON.stringify(c)).join(', ')} in "${truncate(r.desc.name, 50)}"`,
      };
    });
  }

  async setChecked(target: Target, checked: boolean, ctx: ActionContext = {}): Promise<ActionResult> {
    return this.run(ctx, checked ? 'check' : 'uncheck', describeTarget(target), async (s, ps) => {
      const r = await resolveTarget(ps, target, this.timeout());
      await this.gate.enforce({
        verb: checked ? 'Check' : 'Uncheck',
        url: ps.page.url(),
        candidates: [ActionExecutor.self(r)],
      });
      const el = r.kind === 'handle' ? r.handle : r.locator;
      if (checked) await el.check({ timeout: this.timeout() });
      else await el.uncheck({ timeout: this.timeout() });
      this.record(s, checked ? 'check' : 'uncheck', r, {}, ps.page.url());
      return { message: `${checked ? 'Checked' : 'Unchecked'} "${truncate(r.desc.name, 60)}"` };
    });
  }

  async drag(source: Target, dest: Target, ctx: ActionContext = {}): Promise<ActionResult> {
    return this.run(ctx, 'drag', `${describeTarget(source)} → ${describeTarget(dest)}`, async (s, ps) => {
      const a = await resolveTarget(ps, source, this.timeout());
      const b = await resolveTarget(ps, dest, this.timeout());
      await this.gate.enforce({
        verb: 'Drag',
        url: ps.page.url(),
        candidates: [ActionExecutor.self(a), { name: b.desc.name, role: b.desc.role, via: 'destination' }],
      });
      if (a.kind === 'locator' && b.kind === 'locator')
        await a.locator.dragTo(b.locator, { timeout: this.timeout() });
      else {
        const ha = a.kind === 'handle' ? a.handle : await a.locator.elementHandle();
        const hb = b.kind === 'handle' ? b.handle : await b.locator.elementHandle();
        await ha?.scrollIntoViewIfNeeded();
        const ba = await ha?.boundingBox();
        const bb = await hb?.boundingBox();
        if (!ba || !bb) throw new TgError('ELEMENT_NOT_VISIBLE', 'Drag source or target has no bounding box');
        await ps.page.mouse.move(ba.x + ba.width / 2, ba.y + ba.height / 2);
        await ps.page.mouse.down();
        await ps.page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 8 });
        await ps.page.mouse.up();
      }
      this.record(s, 'drag', a, { to: b ? suggestLocator(b.desc).target : undefined }, ps.page.url());
      return { message: `Dragged "${truncate(a.desc.name, 40)}" to "${truncate(b.desc.name, 40)}"` };
    });
  }

  async scroll(
    opts: {
      target?: Target;
      direction?: 'up' | 'down' | 'left' | 'right';
      amount?: number;
      to?: 'top' | 'bottom';
    },
    ctx: ActionContext = {},
  ): Promise<ActionResult> {
    return this.run(
      ctx,
      'scroll',
      opts.target ? describeTarget(opts.target) : (opts.to ?? opts.direction),
      async (_s, ps) => {
        if (opts.target && hasTarget(opts.target) && !opts.direction && !opts.to) {
          const r = await resolveTarget(ps, opts.target, this.timeout());
          await (r.kind === 'handle' ? r.handle : r.locator).scrollIntoViewIfNeeded({
            timeout: this.timeout(),
          });
          return { message: `Scrolled "${truncate(r.desc.name, 50)}" into view` };
        }
        const amount = opts.amount ?? 600;
        const dir = opts.direction ?? 'down';
        const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
        const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
        if (opts.target && hasTarget(opts.target)) {
          // Scroll inside a container (virtual scroll lists, tables).
          const r = await resolveTarget(ps, opts.target, this.timeout());
          const scrollFn = (n: Element, [x, y, to]: readonly [number, number, string]) => {
            if (to === 'top') n.scrollTop = 0;
            else if (to === 'bottom') n.scrollTop = n.scrollHeight;
            else n.scrollBy(x, y);
          };
          const arg = [dx, dy, opts.to ?? ''] as const;
          if (r.kind === 'handle') await r.handle.evaluate(scrollFn, arg);
          else await r.locator.evaluate(scrollFn, arg);
        } else if (opts.to) {
          await ps.page.evaluate(
            (to) => window.scrollTo(0, to === 'top' ? 0 : document.documentElement.scrollHeight),
            opts.to,
          );
        } else await ps.page.mouse.wheel(dx, dy);
        return { message: opts.to ? `Scrolled to ${opts.to}` : `Scrolled ${dir} ${amount}px` };
      },
    );
  }

  async upload(target: Target, files: string[], ctx: ActionContext = {}): Promise<ActionResult> {
    const resolvedFiles = files.map((f) => this.permissions.checkFilePath(f, 'read'));
    await this.permissions.requireApproval(
      'highRisk',
      `Upload ${files.length} file(s)`,
      `Upload to the page: ${resolvedFiles.map((f) => path.basename(f)).join(', ')}`,
    );
    return this.run(ctx, 'upload_file', describeTarget(target), async (s, ps) => {
      const r = await resolveTarget(ps, target, this.timeout());
      const el = r.kind === 'handle' ? r.handle : r.locator;
      if (r.desc.inputType === 'file') await el.setInputFiles(resolvedFiles, { timeout: this.timeout() });
      else {
        // Clicking a custom upload button opens a file chooser.
        const [chooser] = await Promise.all([
          ps.page.waitForEvent('filechooser', { timeout: this.timeout() }),
          el.click({ timeout: this.timeout() }),
        ]);
        await chooser.setFiles(resolvedFiles);
      }
      this.record(s, 'upload', r, { files }, ps.page.url());
      return { message: `Uploaded ${resolvedFiles.map((f) => path.basename(f)).join(', ')}` };
    });
  }

  async dialog(
    accept: boolean,
    promptText: string | undefined,
    ctx: ActionContext = {},
  ): Promise<ActionResult> {
    return this.run(ctx, 'dialog', undefined, async (_s, ps) => {
      const d = ps.pendingDialog;
      if (!d) throw new TgError('ACTION_FAILED', 'No dialog is open');
      ps.pendingDialog = undefined;
      if (accept) await d.dialog.accept(promptText);
      else await d.dialog.dismiss();
      return { message: `${accept ? 'Accepted' : 'Dismissed'} ${d.type} "${truncate(d.message, 60)}"` };
    });
  }

  // ───────────────────────── Inspection ─────────────────────────

  async snapshot(
    opts: { scope?: string; page?: number; interactiveOnly?: boolean; maxChars?: number } = {},
    ctx: ActionContext = {},
  ): Promise<{
    text: string;
    snapshot: Snapshot;
    page: number;
    totalPages: number;
    sessionId: string;
    pageId: string;
  }> {
    const s = await this.sessionFor(ctx.session, ctx.project);
    const ps = await this.ensurePage(s, ctx.pageId);
    return this.locked(ps, 'snapshot', async () => {
      const snap = await captureSnapshot(ps.page, ps.refs, {
        ...this.snapshotOpts(),
        ...(opts.scope ? { scopeRef: opts.scope } : {}),
        ...(opts.interactiveOnly ? { interactiveOnly: true } : {}),
      });
      if (opts.scope && snap.nodes.length === 0) {
        throw new TgError('STALE_ELEMENT_REFERENCE', `Scope ref ${opts.scope} is not on the page`, {
          context: { ref: opts.scope },
        });
      }
      if (!opts.scope && !opts.interactiveOnly) ps.lastSnapshot = snap;
      const f = formatSnapshot(snap, {
        maxChars: Math.min(opts.maxChars ?? this.cfg.snapshot.maxChars, 200_000),
        ...(opts.page ? { page: opts.page } : {}),
      });
      snap.complete = f.complete;
      let text = f.text;
      if (ps.pendingDialog)
        text += `\n\n[dialog open] ${ps.pendingDialog.type}: "${ps.pendingDialog.message}" — call browser_dialog`;
      return { text, snapshot: snap, page: f.page, totalPages: f.totalPages, sessionId: s.id, pageId: ps.id };
    });
  }

  async screenshot(
    opts: {
      target?: Target;
      fullPage?: boolean;
      format?: 'png' | 'jpeg';
      quality?: number;
      path?: string;
      save?: boolean;
    } = {},
    ctx: ActionContext = {},
  ): Promise<{
    base64?: string;
    mimeType: string;
    path?: string;
    bytes: number;
    pageId: string;
    sessionId: string;
  }> {
    const s = await this.sessionFor(ctx.session, ctx.project);
    const ps = await this.ensurePage(s, ctx.pageId);
    return this.locked(ps, 'screenshot', async () => {
      const type = opts.format ?? 'jpeg';
      const shotOpts = {
        type,
        ...(type === 'jpeg' ? { quality: opts.quality ?? 75 } : {}),
        scale: 'css' as const,
        timeout: this.timeout(),
        // Keep the "controlled by TG Browser MCP" badge out of screenshots.
        style: INDICATOR_HIDE_CSS,
      };
      let buf: Buffer;
      if (opts.target && hasTarget(opts.target)) {
        const r = await resolveTarget(ps, opts.target, this.timeout());
        buf = await (r.kind === 'handle' ? r.handle : r.locator).screenshot(shotOpts);
      } else buf = await ps.page.screenshot({ ...shotOpts, fullPage: !!opts.fullPage });
      const mode = this.cfg.output.screenshots;
      let file: string | undefined;
      if (opts.path || opts.save || mode !== 'inline') {
        file = opts.path
          ? this.permissions.checkFilePath(opts.path, 'write', { extensions: WRITE_EXTENSIONS[type] })
          : path.join(this.artifactsDir, s.project, s.name, `screenshot-${Date.now()}.${type}`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
        this.events.emit('screenshot.created', {
          sessionId: s.id,
          pageId: ps.id,
          path: file,
          bytes: buf.length,
        });
      }
      const inline = mode !== 'file' && !(opts.path && mode === 'inline' && opts.save === false);
      return {
        ...(inline ? { base64: buf.toString('base64') } : {}),
        mimeType: `image/${type}`,
        ...(file ? { path: file } : {}),
        bytes: buf.length,
        pageId: ps.id,
        sessionId: s.id,
      };
    });
  }

  async getText(
    target: Target | undefined,
    opts: { maxChars?: number } = {},
    ctx: ActionContext = {},
  ): Promise<string> {
    const s = await this.sessionFor(ctx.session, ctx.project);
    const ps = await this.ensurePage(s, ctx.pageId);
    return this.locked(ps, 'getText', async () => {
      const max = Math.min(opts.maxChars ?? 4000, 50_000);
      let text: string;
      if (target && hasTarget(target)) {
        const r = await resolveTarget(ps, target, this.timeout(), 'read');
        text = await (r.kind === 'handle'
          ? r.handle.innerText()
          : r.locator.innerText({ timeout: this.timeout() }));
      } else text = await ps.frame().locator('body').innerText({ timeout: this.timeout() });
      text = this.redactor.text(text.replace(/\n{3,}/g, '\n\n'), { emails: false });
      return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
    });
  }

  async getElement(target: Target, ctx: ActionContext = {}): Promise<Record<string, unknown>> {
    const s = await this.sessionFor(ctx.session, ctx.project);
    const ps = await this.ensurePage(s, ctx.pageId);
    return this.locked(ps, 'getElement', async () => {
      const r = await resolveTarget(ps, target, this.timeout(), 'read');
      const el = r.kind === 'handle' ? r.handle : r.locator;
      const [box, visible, enabled] = await Promise.all([
        el.boundingBox().catch(() => null),
        el.isVisible().catch(() => false),
        el.isEnabled().catch(() => false),
      ]);
      const loc = suggestLocator(r.desc);
      return {
        ...r.desc,
        visible,
        enabled,
        box: box
          ? {
              x: Math.round(box.x),
              y: Math.round(box.y),
              w: Math.round(box.width),
              h: Math.round(box.height),
            }
          : null,
        locator: loc.expr,
      };
    });
  }

  async inputValue(target: Target, ctx: ActionContext = {}): Promise<string> {
    const s = await this.sessionFor(ctx.session, ctx.project);
    const ps = await this.ensurePage(s, ctx.pageId);
    return this.locked(ps, 'inputValue', async () => {
      const r = await resolveTarget(ps, target, this.timeout(), 'read');
      const v =
        r.kind === 'handle'
          ? await r.handle.inputValue()
          : await r.locator.inputValue({ timeout: this.timeout() });
      return this.isSensitiveField(r.desc) ? '[REDACTED]' : v;
    });
  }

  async getAttributes(
    target: Target,
    names: string[] | undefined,
    ctx: ActionContext = {},
  ): Promise<Record<string, string>> {
    const s = await this.sessionFor(ctx.session, ctx.project);
    const ps = await this.ensurePage(s, ctx.pageId);
    return this.locked(ps, 'getAttributes', async () => {
      const r = await resolveTarget(ps, target, this.timeout(), 'read');
      const attrFn = (n: Element): Record<string, string> =>
        Object.fromEntries(Array.from(n.attributes).map((a) => [a.name, a.value]));
      const attrs = r.kind === 'handle' ? await r.handle.evaluate(attrFn) : await r.locator.evaluate(attrFn);
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(attrs)) {
        if (names?.length && !names.includes(k)) continue;
        out[k] =
          (k === 'value' && this.isSensitiveField(r.desc)) || this.redactor.isSensitiveKey(k)
            ? '[REDACTED]'
            : truncate(this.redactor.text(v), 300);
      }
      return out;
    });
  }

  async ariaTree(target: Target | undefined, ctx: ActionContext = {}): Promise<string> {
    const s = await this.sessionFor(ctx.session, ctx.project);
    const ps = await this.ensurePage(s, ctx.pageId);
    return this.locked(ps, 'ariaTree', async () => {
      let yaml: string;
      if (target && hasTarget(target)) {
        const r = await resolveTarget(ps, target, this.timeout(), 'read');
        if (r.kind === 'locator') yaml = await r.locator.ariaSnapshot({ timeout: this.timeout() });
        else {
          const sel = suggestLocator(r.desc).target;
          const rr = await resolveTarget(ps, sel, this.timeout(), 'read');
          yaml = rr.kind === 'locator' ? await rr.locator.ariaSnapshot({ timeout: this.timeout() }) : '';
        }
      } else yaml = await ps.frame().locator('body').ariaSnapshot({ timeout: this.timeout() });
      return truncate(this.redactor.text(yaml, { emails: false }), this.cfg.snapshot.maxChars);
    });
  }

  async pageInfo(
    ctx: ActionContext = {},
  ): Promise<{ title: string; url: string; pageId: string; session: string }> {
    const s = await this.sessionFor(ctx.session, ctx.project);
    const ps = await this.ensurePage(s, ctx.pageId);
    return {
      title: await ps.page.title(),
      url: this.redactor.url(ps.page.url()),
      pageId: ps.id,
      session: s.name,
    };
  }

  // ───────────────────────── Tabs / frames / viewport ─────────────────────────

  async tabs(
    ctx: ActionContext = {},
  ): Promise<Array<{ pageId: string; url: string; title: string; active: boolean }>> {
    const s = await this.sessionFor(ctx.session, ctx.project);
    const info = await s.info();
    return info.pages.map((p) => ({
      pageId: p.id,
      url: this.redactor.url(p.url),
      title: p.title,
      active: p.active,
    }));
  }

  async tabCreate(url: string | undefined, ctx: ActionContext = {}): Promise<ActionResult> {
    const s = await this.sessionFor(ctx.session, ctx.project);
    if (url) await this.policy.assertAllowed(url);
    const ps = await this.sessions.openPage(s);
    if (url) return this.navigate(url, { ...ctx, pageId: ps.id });
    return this.run({ ...ctx, pageId: ps.id, snapshot: 'none' }, 'tab_create', undefined, async () => ({
      message: `Opened tab ${ps.id}`,
    }));
  }

  async tabSwitch(pageId: string, ctx: ActionContext = {}): Promise<ActionResult> {
    const s = await this.sessionFor(ctx.session, ctx.project);
    const ps = s.page(pageId);
    s.activePageId = ps.id;
    await ps.page.bringToFront().catch(() => undefined);
    return this.run({ ...ctx, pageId, snapshot: ctx.snapshot ?? 'full' }, 'tab_switch', pageId, async () => ({
      message: `Switched to tab ${pageId}`,
    }));
  }

  async tabClose(
    pageId: string | undefined,
    ctx: ActionContext = {},
  ): Promise<{ closed: string; activePageId: string | undefined }> {
    const s = await this.sessionFor(ctx.session, ctx.project);
    const ps = s.page(pageId);
    await ps.page.close();
    return { closed: ps.id, activePageId: s.activePageId };
  }

  async frames(
    ctx: ActionContext = {},
  ): Promise<Array<{ index: number; name: string; url: string; active: boolean }>> {
    const s = await this.sessionFor(ctx.session, ctx.project);
    const ps = await this.ensurePage(s, ctx.pageId);
    const active = ps.frame();
    return ps.page
      .frames()
      .map((f, i) => ({ index: i, name: f.name(), url: this.redactor.url(f.url()), active: f === active }));
  }

  async frameSwitch(
    sel: { index?: number; name?: string; url?: string; main?: boolean },
    ctx: ActionContext = {},
  ): Promise<{ index: number; url: string }> {
    const s = await this.sessionFor(ctx.session, ctx.project);
    const ps = await this.ensurePage(s, ctx.pageId);
    const frames = ps.page.frames();
    let f = sel.main ? ps.page.mainFrame() : undefined;
    if (!f && sel.index !== undefined) f = frames[sel.index];
    if (!f && sel.name) f = frames.find((x) => x.name() === sel.name);
    if (!f && sel.url) f = frames.find((x) => x.url().includes(sel.url!));
    if (!f)
      throw new TgError('FRAME_NOT_FOUND', 'No matching frame', {
        suggestion: 'Call browser_frames to list frames.',
      });
    ps.activeFrame = f === ps.page.mainFrame() ? undefined : f;
    return { index: frames.indexOf(f), url: this.redactor.url(f.url()) };
  }

  async resize(
    width: number,
    height: number,
    ctx: ActionContext = {},
  ): Promise<{ width: number; height: number }> {
    const s = await this.sessionFor(ctx.session, ctx.project);
    const ps = await this.ensurePage(s, ctx.pageId);
    await ps.page.setViewportSize({ width, height });
    return { width, height };
  }

  // ───────────────────────── Debugging ─────────────────────────

  async performance(ctx: ActionContext = {}): Promise<Record<string, unknown>> {
    const s = await this.sessionFor(ctx.session, ctx.project);
    const ps = await this.ensurePage(s, ctx.pageId);
    return ps.page.evaluate(async () => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const paints = Object.fromEntries(
        performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]),
      );
      const lcp = await new Promise<number | null>((resolve) => {
        try {
          const po = new PerformanceObserver((l) => {
            const e = l.getEntries();
            resolve(e.length ? Math.round(e[e.length - 1]!.startTime) : null);
          });
          po.observe({ type: 'largest-contentful-paint', buffered: true });
          setTimeout(() => resolve(null), 300);
        } catch {
          resolve(null);
        }
      });
      const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const byType: Record<string, { count: number; kb: number }> = {};
      for (const r of res) {
        const t = (byType[r.initiatorType] ??= { count: 0, kb: 0 });
        t.count++;
        t.kb += Math.round((r.transferSize || 0) / 1024);
      }
      const slowest = [...res]
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 5)
        .map((r) => ({ url: r.name.split('?')[0]!.slice(-100), ms: Math.round(r.duration) }));
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      return {
        ttfbMs: nav ? Math.round(nav.responseStart - nav.requestStart) : null,
        domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        loadMs: nav ? Math.round(nav.loadEventEnd) : null,
        firstContentfulPaintMs: paints['first-contentful-paint'] ?? null,
        largestContentfulPaintMs: lcp,
        resources: { total: res.length, byType },
        slowestResources: slowest,
        domNodes: document.getElementsByTagName('*').length,
        jsHeapMb: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
      };
    });
  }

  async traceStart(ctx: ActionContext = {}): Promise<{ session: string }> {
    const s = await this.sessionFor(ctx.session, ctx.project);
    await s.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    return { session: s.name };
  }

  async traceStop(
    filePath: string | undefined,
    ctx: ActionContext = {},
  ): Promise<{ path: string; bytes: number }> {
    const s = await this.sessionFor(ctx.session, ctx.project);
    const out = filePath
      ? this.permissions.checkFilePath(filePath, 'write', { extensions: WRITE_EXTENSIONS.trace })
      : path.join(this.artifactsDir, s.project, s.name, `trace-${Date.now()}.zip`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await s.context.tracing.stop({ path: out });
    this.events.emit('trace.created', { sessionId: s.id, path: out, bytes: fs.statSync(out).size });
    return { path: out, bytes: fs.statSync(out).size };
  }
}
