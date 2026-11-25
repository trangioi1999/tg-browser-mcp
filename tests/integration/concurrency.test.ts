import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFixtureServer } from '../fixtures/app/server.mjs';
import { testHarness } from '../helpers.js';
import { budgetTimeoutError, runWithBudget } from '../../src/harness/call-scope.js';
import { WorkflowEngine } from '../../src/workflow/workflow-engine.js';

/**
 * TGB-007 / TGB-009: per-page lock and timeouts that do not lie, against a submit endpoint that
 * answers after 3 s and counts every request server-side.
 */
const app = createFixtureServer();
const h = testHarness();
let base: string;
let seq = 0;
const go = { role: 'button', name: 'Go' } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  base = await app.listen();
});
afterAll(async () => {
  await h.close();
  await app.close();
});

async function slowPage() {
  const name = `conc-${++seq}`;
  const s = await h.createSession({ name });
  await s.navigate(`${base}/slow-submit?ms=3000`);
  return { name, ps: s.raw.page() };
}

const budget = (ms: number, label: string, safe = false) => ({
  onTimeout: (scope: Parameters<typeof budgetTimeoutError>[2]) => budgetTimeoutError(label, ms, scope, safe),
});

describe('timeouts and page lock (real browser)', () => {
  it('a timed-out submit is INDETERMINATE, the page is busy until it settles, and it ran exactly once', async () => {
    const { name, ps } = await slowPage();
    const before = app.slow.submits;
    const err = await runWithBudget(
      1500,
      () => h.actions.click(go, {}, { session: name }),
      budget(1500, 'browser_click'),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'ACTION_TIMEOUT',
      retryable: false,
      context: { outcome: 'INDETERMINATE' },
    });
    // The click is still settling (its request is pending): overlapping work is refused, not interleaved.
    await expect(h.actions.snapshot({}, { session: name })).rejects.toMatchObject({ code: 'PAGE_BUSY' });
    await expect(
      h.actions.click({ role: 'button', name: 'Noop' }, {}, { session: name }),
    ).rejects.toMatchObject({ code: 'PAGE_BUSY', retryable: true });
    await vi.waitFor(() => expect(ps.lock.holder).toBeUndefined(), { timeout: 5000 });
    const snap = await h.actions.snapshot({}, { session: name });
    expect(snap.text).toContain('Go');
    expect(app.slow.submits).toBe(before + 1);
  });

  it('a caller whose budget expires while queued never dispatches', async () => {
    const { name, ps } = await slowPage();
    const before = app.slow.submits;
    const first = h.actions.click(go, {}, { session: name });
    await vi.waitFor(() => expect(ps.lock.holder).toBeDefined());
    const second = runWithBudget(
      300,
      () => h.actions.click(go, {}, { session: name }),
      budget(300, 'browser_click'),
    );
    await expect(second).rejects.toMatchObject({ retryable: true });
    await first;
    await sleep(300);
    expect(app.slow.submits).toBe(before + 1);
  });

  it('serializes concurrent snapshots and actions on one page', async () => {
    const { name } = await slowPage();
    const noop = { role: 'button', name: 'Noop' } as const;
    const results = await Promise.allSettled([
      h.actions.snapshot({}, { session: name }),
      h.actions.click(noop, {}, { session: name }),
      h.actions.snapshot({}, { session: name }),
      h.actions.getText(noop, {}, { session: name }),
      h.actions.snapshot({}, { session: name }),
    ]);
    expect(results.map((r) => r.status)).toEqual(Array(5).fill('fulfilled'));
    const texts = results
      .slice(0, 5)
      .filter((_, i) => i % 2 === 0)
      .map((r) => (r as PromiseFulfilledResult<{ text: string }>).value.text);
    const ref = (t: string) => /button "Noop"[^\n]*\[ref=(e\d+)\]/.exec(t)?.[1];
    expect(texts.map(ref).every(Boolean)).toBe(true);
    expect(new Set(texts.map(ref)).size).toBe(1);
  });

  it('concurrent creates of one session name yield one session and SESSION_EXISTS (D25)', async () => {
    const results = await Promise.allSettled([
      h.createSession({ name: 'dup-create' }),
      h.createSession({ name: 'dup-create' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'SESSION_EXISTS' });
    expect(h.sessions.list().filter((s) => s.name === 'dup-create')).toHaveLength(1);
  });

  it('cancelling a workflow mid-step records the step as cancelled with dispatch unknown (doc 04 §6.3)', async () => {
    const engine = new WorkflowEngine(h);
    const { name, ps } = await slowPage();
    const before = app.slow.submits;
    const { runId, promise } = engine.start({
      name: 'cancel-mid-step',
      steps: [
        { id: 'pay', action: 'click', session: name, input: { role: 'button', name: 'Go' } },
        { id: 'after', action: 'click', session: name, input: { role: 'button', name: 'Noop' } },
      ],
    });
    await vi.waitFor(() => expect(app.slow.submits).toBe(before + 1), { timeout: 5000 });
    expect(engine.cancel(runId)).toBe(true);
    const run = await promise;
    expect(run.status).toBe('cancelled');
    const pay = run.steps.find((st) => st.id === 'pay')!;
    expect(pay.status).toBe('cancelled');
    expect(pay.message).toContain('dispatch unknown');
    expect(run.steps.find((st) => st.id === 'after')!.status).toBe('skipped');
    await vi.waitFor(() => expect(ps.lock.holder).toBeUndefined(), { timeout: 5000 });
    expect(app.slow.submits).toBe(before + 1);
  });
});
