import type { FieldResult } from './form-filler.js';
import { interruptedOutcome } from './action-outcome.js';
import { classifyAction } from './action-classes.js';
import { ActionVerifier, type VerificationSignals } from './action-verifier.js';
import { AssertionEngine } from '../testing/assertion-engine.js';
import { Inspectors } from './inspectors.js';
import type { ActionOutcome, ExpectSpec } from './action-outcome.js';
import path from 'node:path';
import type { TgConfig } from '../config/schema.js';
import type { DomainPolicy } from '../security/domain-policy.js';

import { type PermissionManager } from '../security/permission-manager.js';
import {
  PolicyGate,
  probeActivation,
  type KeyActivation,
  type PolicyCandidate,
} from '../security/policy-gate.js';
import type { DataRedactor } from '../security/data-redactor.js';
import type { TypedEmitter } from '../shared/events.js';
import type { LockHolder, Release } from '../shared/async-lock.js';
import { currentScope, markDispatched } from './call-scope.js';
import type { SessionManager } from '../session/session-manager.js';
import type { PageState, Session } from '../session/session.js';
import { captureSnapshot, formatSnapshot } from '../snapshot/snapshot-engine.js';
import { diffSnapshots, formatDiff, type SnapshotDiff } from '../snapshot/snapshot-diff.js';
import { formatConsole, formatNetwork } from '../network/network-monitor.js';
import { TgError, toTgError } from '../shared/errors.js';
import { shortId, sleep } from '../shared/util.js';
import { type Resolved } from './target.js';

import type { ElementDescription } from '../snapshot/injected.js';

export type SnapshotMode = 'diff' | 'full' | 'none';

export interface ActionContext {
  session?: string;
  /** Project namespace of `session` (default: the configured project). */
  project?: string;
  pageId?: string;
  snapshot?: SnapshotMode;
  correlationId?: string;
  expect?: ExpectSpec[];
  verificationSignals?: VerificationSignals;
  /** Internal conservative override for submit and custom controls. */
  retryable?: boolean;
}

export interface ActionResult {
  success: true;
  outcome?: ActionOutcome;
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
  fieldResults?: FieldResult[];
  image?: { base64: string; mimeType: string };
}

const SETTLE_MAX_MS = 2000;
/** Budget kept free after the Playwright action for settle, snapshot and formatting. */
const INNER_MARGIN_MS = SETTLE_MAX_MS + 3000;
const MIN_INNER_TIMEOUT_MS = 500;

export class ActionPipeline {
  readonly gate: PolicyGate;

  constructor(
    readonly cfg: TgConfig,
    readonly sessions: SessionManager,
    readonly policy: DomainPolicy,
    readonly permissions: PermissionManager,
    readonly redactor: DataRedactor,
    readonly events: TypedEmitter,
  ) {
    this.gate = new PolicyGate(permissions);
  }

  get artifactsDir(): string {
    return path.join(this.cfg.dataDir, 'artifacts');
  }

  async sessionFor(name?: string, project?: string): Promise<Session> {
    return name ? this.sessions.get(name, project) : this.sessions.ensureActive();
  }

  async ensurePage(s: Session, pageId?: string): Promise<PageState> {
    if (pageId) return s.page(pageId);
    if (s.activePageId && s.pages.get(s.activePageId) && !s.pages.get(s.activePageId)!.page.isClosed())
      return s.page();
    return this.sessions.openPage(s);
  }

  snapshotOpts() {
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
  async settle(s: Session, ps: PageState, startSeq: number): Promise<void> {
    const deadline = Date.now() + SETTLE_MAX_MS;
    await ps.page.waitForLoadState('domcontentloaded', { timeout: SETTLE_MAX_MS }).catch(() => undefined);
    while (Date.now() < deadline) {
      if (ps.pendingDialog) return;
      const pending = s.monitor
        .network({ pageId: ps.id, sinceSeq: startSeq, limit: 500 })
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

  async finish(
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
      res.dialog = { type: ps.pendingDialog.type, message: this.redactor.text(ps.pendingDialog.message) };
      res.warnings.push(
        `A ${ps.pendingDialog.type} dialog is open: "${this.redactor.text(ps.pendingDialog.message)}". Call browser_dialog to accept or dismiss it.`,
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
    const errs = s.monitor.errors(ps.id, startSeq);
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
  async run(
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
    const verifier = new ActionVerifier(
      s,
      ps,
      startSeq,
      this.redactor,
      new AssertionEngine(this.sessions, {
        getText: (...args) => new Inspectors(this).getText(...args),
        isSensitiveField: (desc) => this.isSensitiveField(desc),
      }),
      ctx.expect,
      ctx.verificationSignals,
    );
    let dialogListener: (() => void) | undefined;
    try {
      if (ps.pendingDialog && action !== 'dialog') {
        throw new TgError(
          'ACTION_FAILED',
          `A ${ps.pendingDialog.type} dialog is blocking the page: "${this.redactor.text(ps.pendingDialog.message)}"`,
          { suggestion: 'Call browser_dialog with accept=true or false first.' },
        );
      }
      const dialogWatch = new Promise<'dialog'>((resolve) => {
        dialogListener = () => resolve('dialog');
        ps.page.once('dialog', dialogListener);
      });
      await verifier.ready();
      if (currentScope()?.signal.aborted) throw currentScope()!.signal.reason;
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
      res.outcome = await verifier.verify(
        res,
        (ctx.retryable ?? ['fill', 'check', 'uncheck', 'hover', 'navigate', 'wait'].includes(action)) &&
          classifyAction(action, { name: targetDesc }) !== 'high-impact',
      );
      res.durationMs = Date.now() - t0;
      this.events.emit('action.completed', {
        sessionId: s.id,
        pageId: ps.id,
        action,
        durationMs: res.durationMs,
        correlationId,
      });
      return res;
    } catch (e) {
      let err = toTgError(e, 'ACTION_FAILED');
      if (['ACTION_TIMEOUT', 'NAVIGATION_TIMEOUT', 'BROWSER_DISCONNECTED'].includes(err.code)) {
        err.context.actionOutcome = interruptedOutcome('unknown');
        err = new TgError(err.code, err.message, { context: err.context, retryable: false });
      }
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
      if (dialogListener) ps.page.off('dialog', dialogListener);
      verifier.dispose();
      release();
    }
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

  static self(r: Resolved): PolicyCandidate {
    return { name: r.desc.name, role: r.desc.role, via: 'target' };
  }

  /**
   * Elements a key activation would trigger: on the resolved target, or on the focused element of every
   * frame for page-level keys (the keyboard goes to whichever frame has focus).
   */
  async activationTargets(
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
        out.push(ActionPipeline.self(r));
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
  async gateActivations(
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

  /**
   * Playwright-level timeout: the configured action timeout, capped below the caller's remaining budget
   * (minus settle + snapshot margin) so an outer tool/step timeout is a last resort (TGB-007).
   */
  timeout(base = this.cfg.browser.timeout): number {
    const scope = currentScope();
    if (!scope) return base;
    const left = scope.deadline - Date.now() - INNER_MARGIN_MS;
    return Math.max(MIN_INNER_TIMEOUT_MS, Math.min(base, left));
  }

  /**
   * Acquires the page lock (TGB-009). Waits at most for the caller's remaining budget (or the action
   * timeout); a page whose previous action timed out but is still running reports PAGE_BUSY.
   */
  async lockPage(ps: PageState, label: string): Promise<Release> {
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
  async locked<T>(ps: PageState, label: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.lockPage(ps, label);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
