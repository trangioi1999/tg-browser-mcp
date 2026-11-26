import { captureSnapshot, formatSnapshot, type Snapshot } from '../snapshot/snapshot-engine.js';

import { TgError } from '../shared/errors.js';
import { truncate } from '../shared/util.js';
import { hasTarget, resolveTarget, suggestLocator, type Target } from './target.js';

import { ActionPipeline, type ActionContext } from './action-pipeline.js';
export class Inspectors {
  constructor(private readonly pipeline: ActionPipeline) {}
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
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    const ps = await this.pipeline.ensurePage(s, ctx.pageId);
    return this.pipeline.locked(ps, 'snapshot', async () => {
      const snap = await captureSnapshot(ps.page, ps.refs, {
        ...this.pipeline.snapshotOpts(),
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
        maxChars: Math.min(opts.maxChars ?? this.pipeline.cfg.snapshot.maxChars, 200_000),
        ...(opts.page ? { page: opts.page } : {}),
      });
      let text = f.text;
      if (ps.pendingDialog)
        text += `\n\n[dialog open] ${ps.pendingDialog.type}: "${ps.pendingDialog.message}" — call browser_dialog`;
      return { text, snapshot: snap, page: f.page, totalPages: f.totalPages, sessionId: s.id, pageId: ps.id };
    });
  }

  async getText(
    target: Target | undefined,
    opts: { maxChars?: number } = {},
    ctx: ActionContext = {},
  ): Promise<string> {
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    const ps = await this.pipeline.ensurePage(s, ctx.pageId);
    return this.pipeline.locked(ps, 'getText', async () => {
      const max = Math.min(opts.maxChars ?? 4000, 50_000);
      let text: string;
      if (target && hasTarget(target)) {
        const r = await resolveTarget(ps, target, this.pipeline.timeout(), 'read');
        text = await (r.kind === 'handle'
          ? r.handle.innerText()
          : r.locator.innerText({ timeout: this.pipeline.timeout() }));
      } else text = await ps.frame().locator('body').innerText({ timeout: this.pipeline.timeout() });
      text = this.pipeline.redactor.text(text.replace(/\n{3,}/g, '\n\n'), { emails: false });
      return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
    });
  }

  async getElement(target: Target, ctx: ActionContext = {}): Promise<Record<string, unknown>> {
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    const ps = await this.pipeline.ensurePage(s, ctx.pageId);
    return this.pipeline.locked(ps, 'getElement', async () => {
      const r = await resolveTarget(ps, target, this.pipeline.timeout(), 'read');
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
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    const ps = await this.pipeline.ensurePage(s, ctx.pageId);
    return this.pipeline.locked(ps, 'inputValue', async () => {
      const r = await resolveTarget(ps, target, this.pipeline.timeout(), 'read');
      const v =
        r.kind === 'handle'
          ? await r.handle.inputValue()
          : await r.locator.inputValue({ timeout: this.pipeline.timeout() });
      return this.pipeline.isSensitiveField(r.desc) ? '[REDACTED]' : v;
    });
  }

  async getAttributes(
    target: Target,
    names: string[] | undefined,
    ctx: ActionContext = {},
  ): Promise<Record<string, string>> {
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    const ps = await this.pipeline.ensurePage(s, ctx.pageId);
    return this.pipeline.locked(ps, 'getAttributes', async () => {
      const r = await resolveTarget(ps, target, this.pipeline.timeout(), 'read');
      const attrFn = (n: Element): Record<string, string> =>
        Object.fromEntries(Array.from(n.attributes).map((a) => [a.name, a.value]));
      const attrs = r.kind === 'handle' ? await r.handle.evaluate(attrFn) : await r.locator.evaluate(attrFn);
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(attrs)) {
        if (names?.length && !names.includes(k)) continue;
        out[k] =
          (k === 'value' && this.pipeline.isSensitiveField(r.desc)) ||
          this.pipeline.redactor.isSensitiveKey(k)
            ? '[REDACTED]'
            : truncate(this.pipeline.redactor.text(v), 300);
      }
      return out;
    });
  }

  async ariaTree(target: Target | undefined, ctx: ActionContext = {}): Promise<string> {
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    const ps = await this.pipeline.ensurePage(s, ctx.pageId);
    return this.pipeline.locked(ps, 'ariaTree', async () => {
      let yaml: string;
      if (target && hasTarget(target)) {
        const r = await resolveTarget(ps, target, this.pipeline.timeout(), 'read');
        if (r.kind === 'locator') yaml = await r.locator.ariaSnapshot({ timeout: this.pipeline.timeout() });
        else {
          const sel = suggestLocator(r.desc).target;
          const rr = await resolveTarget(ps, sel, this.pipeline.timeout(), 'read');
          yaml =
            rr.kind === 'locator' ? await rr.locator.ariaSnapshot({ timeout: this.pipeline.timeout() }) : '';
        }
      } else yaml = await ps.frame().locator('body').ariaSnapshot({ timeout: this.pipeline.timeout() });
      return truncate(
        this.pipeline.redactor.text(yaml, { emails: false }),
        this.pipeline.cfg.snapshot.maxChars,
      );
    });
  }

  async pageInfo(
    ctx: ActionContext = {},
  ): Promise<{ title: string; url: string; pageId: string; session: string }> {
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    const ps = await this.pipeline.ensurePage(s, ctx.pageId);
    return {
      title: await ps.page.title(),
      url: this.pipeline.redactor.url(ps.page.url()),
      pageId: ps.id,
      session: s.name,
    };
  }

  async performance(ctx: ActionContext = {}): Promise<Record<string, unknown>> {
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    const ps = await this.pipeline.ensurePage(s, ctx.pageId);
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
}
