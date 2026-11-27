import path from 'node:path';
import { fillFields, type FillField, type FillOptions } from './form-filler.js';
import type { TgConfig } from '../config/schema.js';
import type { DomainPolicy } from '../security/domain-policy.js';
import { safeUrlForLog } from '../security/domain-policy.js';
import { type PermissionManager } from '../security/permission-manager.js';
import { keyActivation, textActivations, type PolicyCandidate } from '../security/policy-gate.js';
import type { DataRedactor } from '../security/data-redactor.js';
import type { TypedEmitter } from '../shared/events.js';
import type { SessionManager } from '../session/session-manager.js';
import type { Session } from '../session/session.js';
import { TgError, toTgError } from '../shared/errors.js';
import { truncate } from '../shared/util.js';
import {
  describeTarget,
  hasTarget,
  resolveTarget,
  suggestLocator,
  type Resolved,
  type Target,
} from './target.js';
import { selectCustomOption } from '../adapters/generic/combobox.js';
import type { ElementDescription } from '../snapshot/injected.js';
import { ActionPipeline, type ActionContext, type ActionResult } from './action-pipeline.js';
export type { ActionContext, ActionResult, SnapshotMode } from './action-pipeline.js';
import { Inspectors } from './inspectors.js';
import { ArtifactService } from './artifact-service.js';
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

export class ActionExecutor {
  onRecorded: ((a: RecordedAction) => void) | undefined;
  private readonly pipeline: ActionPipeline;
  private readonly inspectors: Inspectors;
  private readonly artifacts: ArtifactService;

  constructor(
    private readonly cfg: TgConfig,
    private readonly sessions: SessionManager,
    private readonly policy: DomainPolicy,
    private readonly permissions: PermissionManager,
    private readonly redactor: DataRedactor,
    private readonly events: TypedEmitter,
  ) {
    this.pipeline = new ActionPipeline(cfg, sessions, policy, permissions, redactor, events);
    this.inspectors = new Inspectors(this.pipeline);
    this.artifacts = new ArtifactService(this.pipeline);
  }

  get artifactsDir(): string {
    return this.pipeline.artifactsDir;
  }

  /** Browser Memory (observe-only, opt-in via `memory.enabled`). */
  get memory() {
    return this.pipeline.memory;
  }

  /** Read-only known-page summary of the page's last snapshot (memory_page_info). Never writes memory. */
  async memoryPageInfo(ctx: ActionContext = {}): Promise<string> {
    if (!this.pipeline.memory.enabled) return 'Memory is disabled (memory.enabled=false).';
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    const ps = await this.pipeline.ensurePage(s, ctx.pageId);
    const snap = ps.lastSnapshot;
    if (!snap) return 'No snapshot of this page yet: call browser_snapshot first.';
    return this.pipeline.memory.pageInfo(snap, { project: s.project, authContext: s.authContext });
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
    return this.pipeline.run({ snapshot: 'full', ...ctx }, 'navigate', safeUrlForLog(url), async (s, ps) => {
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
          timeout: this.pipeline.timeout(this.cfg.browser.navigationTimeout),
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
    return this.pipeline.run({ snapshot: 'full', ...ctx }, kind, undefined, async (_s, ps) => {
      const o = { timeout: this.pipeline.timeout(this.cfg.browser.navigationTimeout) };
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
    return this.pipeline.run(ctx, 'wait', undefined, async (_s, ps) => {
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
    return this.pipeline.run(ctx, action, describeTarget(target), async (s, ps) => {
      const r = await resolveTarget(ps, target, this.pipeline.timeout());
      await this.pipeline.gate.enforce({
        verb: 'Click',
        url: ps.page.url(),
        candidates: [ActionPipeline.self(r)],
      });
      const o = {
        timeout: this.pipeline.timeout(),
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
    return this.pipeline.run(ctx, 'hover', describeTarget(target), async (s, ps) => {
      const r = await resolveTarget(ps, target, this.pipeline.timeout());
      await (r.kind === 'handle' ? r.handle : r.locator).hover({ timeout: this.pipeline.timeout() });
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
    return this.pipeline.run(
      { ...ctx, retryable: !opts.submit },
      'fill',
      describeTarget(target),
      async (s, ps) => {
        const r = await resolveTarget(ps, target, this.pipeline.timeout(), opts.submit ? 'action' : 'input');
        const sensitive = this.isSensitiveField(r.desc);
        const el = r.kind === 'handle' ? r.handle : r.locator;
        if (r.desc.native === 'select')
          throw new TgError('INVALID_ARGUMENT', 'Target is a <select>; use browser_select_option');
        if (opts.submit) await this.pipeline.gateActivations(ps, r, ['enter'], 'Submit');
        await el.fill(value, { timeout: this.pipeline.timeout() });
        if (opts.submit) await el.press('Enter', { timeout: this.pipeline.timeout() });
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
      },
    );
  }

  /** Fills fields sequentially and retains partial progress. */
  async fillForm(
    fields: FillField[],
    ctx: ActionContext = {},
    opts: FillOptions = {},
  ): Promise<ActionResult> {
    return this.pipeline.run(
      { ...ctx, retryable: false },
      'fill_form',
      `${fields.length} fields`,
      async (s, ps) => {
        const report = await fillFields(this.pipeline, ps, fields, opts, (r, action, input, sensitive) =>
          this.record(s, action, r, input, ps.page.url(), sensitive),
        );
        const filled = report.fields.filter((f) => f.status === 'filled').length;
        return {
          message: `Filled ${filled} fields (${fields.length} requested)`,
          extra: { fieldResults: report.fields, data: report },
        };
      },
    );
  }

  async type(
    target: Target | undefined,
    text: string,
    opts: { delayMs?: number; submit?: boolean } = {},
    ctx: ActionContext = {},
  ): Promise<ActionResult> {
    return this.pipeline.run(
      ctx,
      'type',
      target ? describeTarget(target) : 'focused element',
      async (s, ps) => {
        let r: Resolved | undefined;
        const delay = Math.min(opts.delayMs ?? 0, 500);
        if (target && hasTarget(target))
          r = await resolveTarget(ps, target, this.pipeline.timeout(), opts.submit ? 'action' : 'input');
        const modes = textActivations(text);
        if (opts.submit) modes.push('enter');
        if (modes.length)
          await this.pipeline.gateActivations(ps, r, modes, opts.submit ? 'Submit' : 'Type into');
        if (r) {
          if (r.kind === 'handle') {
            await r.handle.focus();
            await ps.page.keyboard.type(text, { delay });
          } else await r.locator.pressSequentially(text, { delay, timeout: this.pipeline.timeout() });
        } else await ps.page.keyboard.type(text, { delay });
        if (opts.submit) await ps.page.keyboard.press('Enter');
        const sensitive = r ? this.isSensitiveField(r.desc) : false;
        this.record(
          s,
          'type',
          r,
          { text, ...(opts.submit ? { submit: true } : {}) },
          ps.page.url(),
          sensitive,
        );
        return { message: `Typed ${sensitive ? '[redacted]' : JSON.stringify(truncate(text, 40))}` };
      },
    );
  }

  async press(key: string, target: Target | undefined, ctx: ActionContext = {}): Promise<ActionResult> {
    if (!/^[A-Za-z0-9+]+$|^.$/.test(key))
      throw new TgError(
        'INVALID_ARGUMENT',
        `Invalid key "${key}". Examples: Enter, Tab, Escape, ArrowDown, Control+a`,
      );
    return this.pipeline.run(ctx, 'press_key', target ? describeTarget(target) : undefined, async (s, ps) => {
      let r: Resolved | undefined;
      if (target && hasTarget(target)) r = await resolveTarget(ps, target, this.pipeline.timeout());
      const mode = keyActivation(key);
      if (mode) await this.pipeline.gateActivations(ps, r, [mode], `Press ${key} on`);
      if (r)
        await (r.kind === 'handle' ? r.handle : r.locator).press(key, { timeout: this.pipeline.timeout() });
      else await ps.page.keyboard.press(key);
      this.record(s, 'press', r, { key }, ps.page.url());
      return { message: `Pressed ${key}` };
    });
  }

  async selectOption(target: Target, values: string[], ctx: ActionContext = {}): Promise<ActionResult> {
    return this.pipeline.run(ctx, 'select_option', describeTarget(target), async (s, ps) => {
      const r = await resolveTarget(ps, target, this.pipeline.timeout());
      await this.pipeline.gate.enforce({
        verb: 'Select',
        url: ps.page.url(),
        candidates: [
          ActionPipeline.self(r),
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
          chosen = await el.selectOption(values, { timeout: this.pipeline.timeout() });
        }
      } else {
        // Custom ARIA comboboxes/listboxes (Angular Material mat-select, PrimeNG p-select, ...).
        chosen = await selectCustomOption(ps, r, values, this.pipeline.timeout());
      }
      this.record(s, 'select', r, { values }, ps.page.url());
      return {
        message: `Selected ${(chosen.length === values.length ? values : chosen).map((c) => JSON.stringify(c)).join(', ')} in "${truncate(r.desc.name, 50)}"`,
      };
    });
  }

  async setChecked(target: Target, checked: boolean, ctx: ActionContext = {}): Promise<ActionResult> {
    return this.pipeline.run(ctx, checked ? 'check' : 'uncheck', describeTarget(target), async (s, ps) => {
      const r = await resolveTarget(ps, target, this.pipeline.timeout());
      await this.pipeline.gate.enforce({
        verb: checked ? 'Check' : 'Uncheck',
        url: ps.page.url(),
        candidates: [ActionPipeline.self(r)],
      });
      const el = r.kind === 'handle' ? r.handle : r.locator;
      if (checked) await el.check({ timeout: this.pipeline.timeout() });
      else await el.uncheck({ timeout: this.pipeline.timeout() });
      this.record(s, checked ? 'check' : 'uncheck', r, {}, ps.page.url());
      return { message: `${checked ? 'Checked' : 'Unchecked'} "${truncate(r.desc.name, 60)}"` };
    });
  }

  async drag(source: Target, dest: Target, ctx: ActionContext = {}): Promise<ActionResult> {
    return this.pipeline.run(
      ctx,
      'drag',
      `${describeTarget(source)} → ${describeTarget(dest)}`,
      async (s, ps) => {
        const a = await resolveTarget(ps, source, this.pipeline.timeout());
        const b = await resolveTarget(ps, dest, this.pipeline.timeout());
        await this.pipeline.gate.enforce({
          verb: 'Drag',
          url: ps.page.url(),
          candidates: [ActionPipeline.self(a), { name: b.desc.name, role: b.desc.role, via: 'destination' }],
        });
        if (a.kind === 'locator' && b.kind === 'locator')
          await a.locator.dragTo(b.locator, { timeout: this.pipeline.timeout() });
        else {
          const ha = a.kind === 'handle' ? a.handle : await a.locator.elementHandle();
          const hb = b.kind === 'handle' ? b.handle : await b.locator.elementHandle();
          await ha?.scrollIntoViewIfNeeded();
          const ba = await ha?.boundingBox();
          const bb = await hb?.boundingBox();
          if (!ba || !bb)
            throw new TgError('ELEMENT_NOT_VISIBLE', 'Drag source or target has no bounding box');
          await ps.page.mouse.move(ba.x + ba.width / 2, ba.y + ba.height / 2);
          await ps.page.mouse.down();
          await ps.page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 8 });
          await ps.page.mouse.up();
        }
        this.record(s, 'drag', a, { to: b ? suggestLocator(b.desc).target : undefined }, ps.page.url());
        return { message: `Dragged "${truncate(a.desc.name, 40)}" to "${truncate(b.desc.name, 40)}"` };
      },
    );
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
    return this.pipeline.run(
      ctx,
      'scroll',
      opts.target ? describeTarget(opts.target) : (opts.to ?? opts.direction),
      async (_s, ps) => {
        if (opts.target && hasTarget(opts.target) && !opts.direction && !opts.to) {
          const r = await resolveTarget(ps, opts.target, this.pipeline.timeout());
          await (r.kind === 'handle' ? r.handle : r.locator).scrollIntoViewIfNeeded({
            timeout: this.pipeline.timeout(),
          });
          return { message: `Scrolled "${truncate(r.desc.name, 50)}" into view` };
        }
        const amount = opts.amount ?? 600;
        const dir = opts.direction ?? 'down';
        const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
        const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
        if (opts.target && hasTarget(opts.target)) {
          // Scroll inside a container (virtual scroll lists, tables).
          const r = await resolveTarget(ps, opts.target, this.pipeline.timeout());
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
    return this.pipeline.run(ctx, 'upload_file', describeTarget(target), async (s, ps) => {
      const r = await resolveTarget(ps, target, this.pipeline.timeout());
      const el = r.kind === 'handle' ? r.handle : r.locator;
      if (r.desc.inputType === 'file')
        await el.setInputFiles(resolvedFiles, { timeout: this.pipeline.timeout() });
      else {
        // Clicking a custom upload button opens a file chooser.
        const [chooser] = await Promise.all([
          ps.page.waitForEvent('filechooser', { timeout: this.pipeline.timeout() }),
          el.click({ timeout: this.pipeline.timeout() }),
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
    return this.pipeline.run(ctx, 'dialog', undefined, async (_s, ps) => {
      const d = ps.pendingDialog;
      if (!d) throw new TgError('ACTION_FAILED', 'No dialog is open');
      ps.pendingDialog = undefined;
      if (accept) await d.dialog.accept(promptText);
      else await d.dialog.dismiss();
      return { message: `${accept ? 'Accepted' : 'Dismissed'} ${d.type} "${truncate(d.message, 60)}"` };
    });
  }

  // ───────────────────────── Tabs / frames / viewport ─────────────────────────

  async tabs(
    ctx: ActionContext = {},
  ): Promise<Array<{ pageId: string; url: string; title: string; active: boolean }>> {
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    const info = await s.info();
    return info.pages.map((p) => ({
      pageId: p.id,
      url: this.redactor.url(p.url),
      title: p.title,
      active: p.active,
    }));
  }

  async tabCreate(url: string | undefined, ctx: ActionContext = {}): Promise<ActionResult> {
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    if (url) await this.policy.assertAllowed(url);
    const ps = await this.sessions.openPage(s);
    if (url) return this.navigate(url, { ...ctx, pageId: ps.id });
    return this.pipeline.run(
      { ...ctx, pageId: ps.id, snapshot: 'none' },
      'tab_create',
      undefined,
      async () => ({
        message: `Opened tab ${ps.id}`,
      }),
    );
  }

  async tabSwitch(pageId: string, ctx: ActionContext = {}): Promise<ActionResult> {
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    const ps = s.page(pageId);
    s.activePageId = ps.id;
    await ps.page.bringToFront().catch(() => undefined);
    return this.pipeline.run(
      { ...ctx, pageId, snapshot: ctx.snapshot ?? 'full' },
      'tab_switch',
      pageId,
      async () => ({
        message: `Switched to tab ${pageId}`,
      }),
    );
  }

  async tabClose(
    pageId: string | undefined,
    ctx: ActionContext = {},
  ): Promise<{ closed: string; activePageId: string | undefined }> {
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    const ps = s.page(pageId);
    await ps.page.close();
    return { closed: ps.id, activePageId: s.activePageId };
  }

  async frames(
    ctx: ActionContext = {},
  ): Promise<Array<{ index: number; name: string; url: string; active: boolean }>> {
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    const ps = await this.pipeline.ensurePage(s, ctx.pageId);
    const active = ps.frame();
    return ps.page
      .frames()
      .map((f, i) => ({ index: i, name: f.name(), url: this.redactor.url(f.url()), active: f === active }));
  }

  async frameSwitch(
    sel: { index?: number; name?: string; url?: string; main?: boolean },
    ctx: ActionContext = {},
  ): Promise<{ index: number; url: string }> {
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    const ps = await this.pipeline.ensurePage(s, ctx.pageId);
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
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    const ps = await this.pipeline.ensurePage(s, ctx.pageId);
    await ps.page.setViewportSize({ width, height });
    return { width, height };
  }

  snapshot(...args: Parameters<Inspectors['snapshot']>): ReturnType<Inspectors['snapshot']> {
    return this.inspectors.snapshot(...args);
  }
  getText(...args: Parameters<Inspectors['getText']>): ReturnType<Inspectors['getText']> {
    return this.inspectors.getText(...args);
  }
  getElement(...args: Parameters<Inspectors['getElement']>): ReturnType<Inspectors['getElement']> {
    return this.inspectors.getElement(...args);
  }
  inputValue(...args: Parameters<Inspectors['inputValue']>): ReturnType<Inspectors['inputValue']> {
    return this.inspectors.inputValue(...args);
  }
  getAttributes(...args: Parameters<Inspectors['getAttributes']>): ReturnType<Inspectors['getAttributes']> {
    return this.inspectors.getAttributes(...args);
  }
  ariaTree(...args: Parameters<Inspectors['ariaTree']>): ReturnType<Inspectors['ariaTree']> {
    return this.inspectors.ariaTree(...args);
  }
  pageInfo(...args: Parameters<Inspectors['pageInfo']>): ReturnType<Inspectors['pageInfo']> {
    return this.inspectors.pageInfo(...args);
  }
  performance(...args: Parameters<Inspectors['performance']>): ReturnType<Inspectors['performance']> {
    return this.inspectors.performance(...args);
  }
  screenshot(...args: Parameters<ArtifactService['screenshot']>): ReturnType<ArtifactService['screenshot']> {
    return this.artifacts.screenshot(...args);
  }
  traceStart(...args: Parameters<ArtifactService['traceStart']>): ReturnType<ArtifactService['traceStart']> {
    return this.artifacts.traceStart(...args);
  }
  traceStop(...args: Parameters<ArtifactService['traceStop']>): ReturnType<ArtifactService['traceStop']> {
    return this.artifacts.traceStop(...args);
  }
  isSensitiveField(desc: ElementDescription): boolean {
    return this.pipeline.isSensitiveField(desc);
  }
}
