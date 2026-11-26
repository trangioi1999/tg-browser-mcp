import { runWithBudget, budgetTimeoutError } from '../../src/harness/call-scope.js';
import { WorkflowEngine } from '../../src/workflow/workflow-engine.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFixtureServer } from '../fixtures/app/server.mjs';
import { testHarness } from '../helpers.js';
import { formatAction } from '../../src/server/tool-registry.js';
import type { BrowserHarness } from '../../src/harness/browser-harness.js';
let app: ReturnType<typeof createFixtureServer>;
let base: string;
let h: BrowserHarness;
beforeAll(async () => {
  app = createFixtureServer();
  base = await app.listen();
  h = testHarness();
});
afterAll(async () => {
  await h?.close();
  await app?.close();
});
describe('action verification with fixture app', () => {
  it('inverts P4: backend 500 fails despite successful dispatch', async () => {
    const s = await h.createSession({ name: 'failure' });
    await s.navigate(`${base}/api-failure`);
    const r = await s.click({ role: 'button', name: 'Load data' });
    expect(r.success).toBe(true);
    expect(r.outcome?.verificationStatus).toBe('FAILED');
    expect(formatAction(r, 'text').content[0]).toMatchObject({ text: expect.stringMatching(/^✗/) });
  });
  it('rejects HTTP 200 with rejected business status and never echoes bodies', async () => {
    const s = await h.createSession({ name: 'rejected' });
    await s.navigate(`${base}/outcome?status=REJECTED`);
    const r = await s.click(
      { role: 'button', name: 'Load result' },
      {
        expect: [
          {
            type: 'response',
            urlPattern: '*/api/outcome*',
            status: 200,
            json: [{ path: 'status', equals: 'APPROVED' }],
            timeout: 50,
          },
        ],
      },
    );
    expect(r.outcome?.verificationStatus).toBe('FAILED');
    expect(JSON.stringify(r.outcome)).not.toContain('outcome-fixture-secret');
  });
  it('verifies UI business state without deadlocking text assertions', async () => {
    const s = await h.createSession({ name: 'verified' });
    await s.navigate(`${base}/outcome`);
    const r = await s.click(
      { role: 'button', name: 'Load result' },
      { expect: [{ type: 'text', target: { role: 'status' }, contains: 'Pending Approval' }] },
    );
    expect(r.outcome?.verificationStatus).toBe('VERIFIED');
  });
  it('reports a slow action-window request as pending', async () => {
    const s = await h.createSession({ name: 'pending' });
    await s.navigate(`${base}/slow-submit`);
    const r = await s.click({ role: 'button', name: 'Go' });
    expect(r.outcome).toMatchObject({
      verificationStatus: 'INDETERMINATE',
      retryable: false,
      observed: { network: { pending: 1 } },
    });
  });
  it('keeps timed-out non-idempotent actions busy with an indeterminate outcome', async () => {
    const s = await h.createSession({ name: 'timed-out' });
    await s.navigate(`${base}/slow-submit`);
    const before = app.slow.submits;
    await expect(
      runWithBudget(150, () => s.click({ role: 'button', name: 'Go' }), {
        onTimeout: (scope) => budgetTimeoutError('click', 150, scope, false),
      }),
    ).rejects.toMatchObject({
      code: 'ACTION_TIMEOUT',
      retryable: false,
      context: { actionOutcome: { verificationStatus: 'INDETERMINATE', retryable: false } },
    });
    await expect(s.click({ role: 'button', name: 'Noop' })).rejects.toMatchObject({ code: 'PAGE_BUSY' });
    await vi.waitFor(() => expect(s.raw.page().lock.holder).toBeUndefined(), { timeout: 5000 });
    expect(app.slow.submits).toBe(before + 1);
  });
  it('does not replay fill-submit when a later workflow assertion fails', async () => {
    const s = await h.createSession({ name: 'fill-once' });
    await s.navigate(`${base}/fill-submit`);
    const before = app.slow.submits;
    const run = await new WorkflowEngine(h).execute({
      name: 'fill-submit-once',
      steps: [
        {
          id: 'fill',
          action: 'fill',
          session: s.name,
          input: { label: 'Note', value: 'one', submit: true },
          retry: { attempts: 2, delayMs: 0 },
        },
        {
          id: 'verify',
          action: 'assert',
          session: s.name,
          assert: { type: 'text', contains: 'never shown', timeout: 10 },
        },
      ],
    });
    expect(run.failure?.stepId).toBe('verify');
    expect(app.slow.submits).toBe(before + 1);
  });
});
