import type { ActionExecutor } from '../harness/action-executor.js';
import type { SessionManager } from '../session/session-manager.js';
import { resolveTarget, describeTarget, hasTarget, type Target } from '../harness/target.js';
import type { Assertion } from '../workflow/workflow-schema.js';
import { TgError, toTgError } from '../shared/errors.js';
import { sleep, truncate } from '../shared/util.js';

export interface AssertionResult {
  passed: boolean;
  type: Assertion['type'];
  target?: string;
  expected?: string;
  actual?: string;
  message: string;
  durationMs: number;
}

const REDACTED = '[REDACTED]';

/** Masks the actual and expected values of a comparison on a sensitive field; keeps the verdict. */
export function redactComparison(res: { passed: boolean; actual: string; expected?: string }): {
  passed: boolean;
  actual: string;
  expected?: string;
} {
  const kind = res.expected?.match(/^(contains|non-empty)\b/)?.[1];
  return {
    passed: res.passed,
    actual: REDACTED,
    expected: kind === 'non-empty' ? 'non-empty' : kind ? `${kind} ${REDACTED}` : REDACTED,
  };
}

/**
 * Web-first assertions with auto-retry until timeout (like Playwright's expect), implemented
 * without depending on @playwright/test so it works inside the MCP server and SDK.
 */
export class AssertionEngine {
  constructor(
    private readonly sessions: SessionManager,
    private readonly actions: ActionExecutor,
  ) {}

  async check(
    a: Assertion,
    ctx: { session?: string; pageId?: string } = {},
    signal?: AbortSignal,
  ): Promise<AssertionResult> {
    const t0 = Date.now();
    const timeout = a.timeout ?? 5000;
    const deadline = t0 + timeout;
    let last: { passed: boolean; actual?: string; expected?: string } = { passed: false };
    let lastError: string | undefined;
    for (;;) {
      if (signal?.aborted) throw new TgError('WORKFLOW_FAILED', 'Cancelled');
      try {
        last = await this.evaluateOnce(a, ctx);
        lastError = undefined;
      } catch (e) {
        const err = toTgError(e);
        lastError = `${err.code}: ${err.message}`;
        last = {
          passed:
            a.type === 'hidden' &&
            (err.code === 'ELEMENT_NOT_FOUND' || err.code === 'STALE_ELEMENT_REFERENCE'),
        };
      }
      if (last.passed || Date.now() >= deadline) break;
      await sleep(Math.min(200, Math.max(10, deadline - Date.now())));
    }
    const target = a.target && hasTarget(a.target) ? describeTarget(a.target) : undefined;
    const msg = last.passed
      ? `✓ ${a.type}${target ? ` ${target}` : ''}${last.expected !== undefined ? ` = ${truncate(last.expected, 80)}` : ''}`
      : `✗ ${a.message ?? `${a.type} assertion failed`}${target ? ` (${target})` : ''}${last.expected !== undefined ? ` — expected ${truncate(last.expected, 80)}` : ''}${last.actual !== undefined ? `, got ${truncate(last.actual, 120)}` : ''}${lastError ? ` [${lastError}]` : ''}`;
    return {
      passed: last.passed,
      type: a.type,
      ...(target ? { target } : {}),
      ...(last.expected !== undefined ? { expected: last.expected } : {}),
      ...(last.actual !== undefined ? { actual: last.actual } : {}),
      message: msg,
      durationMs: Date.now() - t0,
    };
  }

  private compare(a: Assertion, actual: string): { passed: boolean; actual: string; expected?: string } {
    if (a.equals !== undefined)
      return {
        passed: actual.trim() === String(a.equals),
        actual,
        expected: JSON.stringify(String(a.equals)),
      };
    if (a.contains !== undefined)
      return {
        passed: actual.includes(a.contains),
        actual,
        expected: `contains ${JSON.stringify(a.contains)}`,
      };
    if (a.matches !== undefined)
      return { passed: new RegExp(a.matches).test(actual), actual, expected: `/${a.matches}/` };
    return { passed: actual.length > 0, actual, expected: 'non-empty' };
  }

  private async evaluateOnce(
    a: Assertion,
    ctx: { session?: string; pageId?: string },
  ): Promise<{ passed: boolean; actual?: string; expected?: string }> {
    const session = ctx.session ? this.sessions.get(ctx.session) : await this.sessions.ensureActive();
    const ps = session.page(ctx.pageId);
    const target = a.target as Target | undefined;
    const needTarget =
      ['visible', 'hidden', 'value', 'count', 'attribute', 'enabled', 'disabled', 'checked'].includes(
        a.type,
      ) ||
      (a.type === 'text' && target && hasTarget(target));
    if (needTarget && (!target || !hasTarget(target)))
      throw new TgError('INVALID_ARGUMENT', `Assertion ${a.type} requires a target`);

    switch (a.type) {
      case 'url':
        return this.compare(a, ps.page.url());
      case 'title':
        return this.compare(a, await ps.page.title());
      case 'no_console_errors': {
        const errs = session.monitor.errors(ps.id).console;
        return {
          passed: errs.length === 0,
          actual: errs.map((e) => e.text).join(' | ') || 'none',
          expected: 'no console errors',
        };
      }
      case 'no_failed_requests': {
        const errs = session.monitor.errors(ps.id).network;
        return {
          passed: errs.length === 0,
          actual: errs.map((e) => `${e.method} ${e.url} ${e.status ?? e.failure}`).join(' | ') || 'none',
          expected: 'no failed requests',
        };
      }
      case 'text': {
        const text = await this.actions.getText(
          target && hasTarget(target) ? target : undefined,
          { maxChars: 20_000 },
          ctx,
        );
        return this.compare(a, text);
      }
      case 'count': {
        if (target!.ref) throw new TgError('INVALID_ARGUMENT', 'count assertions need a locator, not a ref');
        const { locator } = await this.locatorFor(ps, target!);
        const n = await locator.count();
        return { passed: n === Number(a.equals ?? 1), actual: String(n), expected: String(a.equals ?? 1) };
      }
      default: {
        const r = await resolveTarget(ps, target!, 1000);
        const el = r.kind === 'handle' ? r.handle : r.locator;
        if (a.type === 'visible')
          return {
            passed: await el.isVisible(),
            expected: 'visible',
            actual: (await el.isVisible()) ? 'visible' : 'hidden',
          };
        if (a.type === 'hidden')
          return {
            passed: !(await el.isVisible()),
            expected: 'hidden',
            actual: (await el.isVisible()) ? 'visible' : 'hidden',
          };
        if (a.type === 'enabled' || a.type === 'disabled') {
          const en = await el.isEnabled();
          return {
            passed: a.type === 'enabled' ? en : !en,
            expected: a.type,
            actual: en ? 'enabled' : 'disabled',
          };
        }
        if (a.type === 'checked') {
          const c = await el.isChecked();
          const want = a.equals === undefined ? true : a.equals === true || a.equals === 'true';
          return { passed: c === want, expected: String(want), actual: String(c) };
        }
        // Values of password/sensitive fields never appear in results or messages (S-07). The decision is
        // made Node-side from the element description, like ActionExecutor.inputValue.
        const sensitive = this.actions.isSensitiveField(r.desc);
        if (a.type === 'value') {
          const res = this.compare(a, await el.inputValue());
          return sensitive ? redactComparison(res) : res;
        }
        if (a.type === 'attribute') {
          if (!a.attribute) throw new TgError('INVALID_ARGUMENT', 'attribute assertion requires "attribute"');
          const res = this.compare(a, (await el.getAttribute(a.attribute)) ?? '');
          return sensitive && a.attribute.toLowerCase() === 'value' ? redactComparison(res) : res;
        }
        throw new TgError('INVALID_ARGUMENT', `Unknown assertion ${a.type}`);
      }
    }
  }

  private async locatorFor(ps: import('../session/session.js').PageState, t: Target) {
    const frame = ps.frame();
    type Role = Parameters<typeof frame.getByRole>[0];
    const locator = t.role
      ? frame.getByRole(t.role as Role, t.name !== undefined ? { name: t.name, exact: t.exact ?? true } : {})
      : t.label
        ? frame.getByLabel(t.label)
        : t.testId
          ? frame.getByTestId(t.testId)
          : t.placeholder
            ? frame.getByPlaceholder(t.placeholder)
            : t.text
              ? frame.getByText(t.text, { exact: t.exact ?? false })
              : frame.locator(t.selector!);
    return { locator };
  }
}
