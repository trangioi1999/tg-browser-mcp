import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ActionVerifier } from '../../src/harness/action-verifier.js';
import { DataRedactor } from '../../src/security/data-redactor.js';
import { formatAction } from '../../src/server/tool-registry.js';
import { ExpectSpecSchema, type ExpectSpec } from '../../src/harness/action-outcome.js';
import type { ActionResult } from '../../src/harness/action-pipeline.js';

function fixture(expected: ExpectSpec[] = []) {
  const entries: Array<{
    method: string;
    url: string;
    status: number | null;
    failure: string | null;
    resourceType: string;
  }> = [];
  const page = Object.assign(new EventEmitter(), {
    url: () => 'http://localhost/',
    locator: () => ({ count: async () => 0 }),
  });
  const assertions = { check: vi.fn(async () => ({ passed: true })) };
  const monitor = {
    network: vi.fn(() => ({ entries })),
    errors: vi.fn(() => ({ console: [], network: [] })),
  };
  const verifier = new ActionVerifier(
    { name: 's', project: 'p', monitor } as never,
    { id: 'page', page } as never,
    7,
    new DataRedactor(),
    assertions as never,
    expected,
  );
  const result: ActionResult = {
    success: true,
    action: 'click',
    message: 'Clicked',
    session: 's',
    sessionId: 's',
    pageId: 'page',
    durationMs: 1,
    url: page.url(),
    warnings: [],
  };
  return { verifier, result, page, entries, assertions, monitor };
}
describe('action outcomes', () => {
  it('keeps success but defaults to unverified', async () => {
    const f = fixture();
    f.result.outcome = await f.verifier.verify(f.result, false);
    expect(f.result.outcome.verificationStatus).toBe('UNVERIFIED');
    expect(formatAction(f.result, 'text').content[0]).toMatchObject({ text: expect.stringMatching(/^•/) });
    f.verifier.dispose();
  });
  it('fails on backend 500 without an expectation', async () => {
    const f = fixture();
    f.entries.push({
      method: 'POST',
      url: 'http://localhost/api?token=secret',
      status: 500,
      failure: null,
      resourceType: 'fetch',
    });
    f.result.outcome = await f.verifier.verify(f.result, false);
    expect(f.result.outcome.verificationStatus).toBe('FAILED');
    expect(formatAction(f.result, 'text').content[0]).toMatchObject({ text: expect.stringMatching(/^✗/) });
    expect(JSON.stringify(f.result.outcome)).not.toContain('token=secret');
    expect(f.monitor.network).toHaveBeenCalledWith({ pageId: 'page', sinceSeq: 7, limit: 500 });
  });
  it('verifies explicit assertions inside the held page lock and action window', async () => {
    const f = fixture([{ type: 'text', contains: 'Pending Approval' }]);
    expect((await f.verifier.verify(f.result, false)).verificationStatus).toBe('VERIFIED');
    expect(f.assertions.check).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ project: 'p', sinceSeq: 7, lockedPage: expect.anything() }),
      undefined,
    );
  });
  it('reports pending requests and dialogs as indeterminate', async () => {
    const f = fixture();
    f.entries.push({
      method: 'POST',
      url: 'http://localhost/api',
      status: null,
      failure: null,
      resourceType: 'fetch',
    });
    expect(await f.verifier.verify(f.result, true)).toMatchObject({
      verificationStatus: 'INDETERMINATE',
      retryable: false,
      observed: { network: { pending: 1 } },
    });
    f.entries.length = 0;
    f.result.dialog = { type: 'alert', message: 'hello' };
    expect(await f.verifier.verify(f.result, true)).toMatchObject({
      verificationStatus: 'INDETERMINATE',
      actionExecuted: 'dispatched',
      retryable: false,
    });
  });
  it.each(['APPROVED', 'REJECTED'])('compares response JSON in memory (%s)', async (status) => {
    const f = fixture([
      {
        type: 'response',
        urlPattern: '*/api/result',
        status: 200,
        json: [{ path: 'status', equals: 'APPROVED' }],
        timeout: 0,
      },
    ]);
    const request = { method: () => 'POST' };
    const response = {
      request: () => request,
      url: () => 'http://localhost/api/result',
      status: () => 200,
      body: async () => Buffer.from(JSON.stringify({ status, password: 'fixture-secret' })),
    };
    f.page.emit('request', request);
    f.page.emit('response', response);
    const outcome = await f.verifier.verify(f.result, false);
    expect(outcome.verificationStatus).toBe(status === 'APPROVED' ? 'VERIFIED' : 'FAILED');
    expect(JSON.stringify(outcome)).not.toContain('fixture-secret');
    expect(JSON.stringify(outcome)).not.toContain(status);
    f.verifier.dispose();
    expect(f.page.listenerCount('response')).toBe(0);
  });
  it('excludes responses whose request began before the action', async () => {
    const f = fixture([{ type: 'response', urlPattern: '*', status: 200, timeout: 0 }]);
    f.page.emit('response', { request: () => ({}), url: () => 'http://localhost/api', status: () => 200 });
    expect((await f.verifier.verify(f.result, false)).verificationStatus).toBe('FAILED');
  });
  it('validates shared expectation shapes', () => {
    expect(ExpectSpecSchema.safeParse({ type: 'response', urlPattern: '*', status: 200 }).success).toBe(true);
    expect(ExpectSpecSchema.safeParse({ type: 'response', status: '200' }).success).toBe(false);
    expect(ExpectSpecSchema.safeParse({ type: 'arbitrary-code', code: 'alert(1)' }).success).toBe(false);
  });
});

describe('verification evidence boundaries', () => {
  it('fails on a new error alert without returning its raw text', async () => {
    const f = fixture();
    await f.verifier.ready();
    Object.assign(f.page, {
      locator: () => ({
        count: async () => 0,
        allTextContents: async () => ['Error: private-business-value'],
      }),
    });
    const outcome = await f.verifier.verify(f.result, false);
    expect(outcome.verificationStatus).toBe('FAILED');
    expect(JSON.stringify(outcome)).not.toContain('private-business-value');
  });
  it('fails on newly invalid controls', async () => {
    const f = fixture();
    await f.verifier.ready();
    Object.assign(f.page, { locator: () => ({ count: async () => 1, allTextContents: async () => [] }) });
    expect((await f.verifier.verify(f.result, false)).verificationStatus).toBe('FAILED');
  });
  it('uses per-field read-back checks as explicit verification', async () => {
    const f = fixture();
    f.result.fieldResults = [{ index: 0, status: 'filled', verified: true }];
    expect((await f.verifier.verify(f.result, false)).verificationStatus).toBe('VERIFIED');
    f.result.fieldResults = [{ index: 0, status: 'disabled', code: 'FIELD_DISABLED' }];
    expect((await f.verifier.verify(f.result, false)).verificationStatus).toBe('FAILED');
  });
  it('does not treat a response URL alone as business verification', async () => {
    const f = fixture([{ type: 'response', urlPattern: '*', timeout: 0 }]);
    const req = { method: () => 'GET' };
    f.page.emit('request', req);
    f.page.emit('response', { request: () => req, url: () => 'http://localhost/', status: () => 200 });
    expect((await f.verifier.verify(f.result, false)).verificationStatus).toBe('FAILED');
  });
});

describe('validation and error expectations', () => {
  it('checks associated validation text without echoing it', async () => {
    const f = fixture([{ type: 'validation', outcome: 'invalid', message: 'Required' }]);
    Object.assign(f.page, {
      locator: () => ({
        count: async () => 0,
        allTextContents: async () => [],
        evaluate: async () => ({ invalid: true, message: 'Required private-data' }),
      }),
    });
    const outcome = await f.verifier.verify(f.result, false);
    expect(outcome.verificationStatus).toBe('VERIFIED');
    expect(JSON.stringify(outcome)).not.toContain('private-data');
  });
  it('scopes no_new_errors to this action', async () => {
    const f = fixture([{ type: 'no_new_errors' }]);
    Object.assign(f.monitor, {
      errors: vi.fn(() => ({ console: [{ text: 'private-error' }], network: [] })),
    });
    expect((await f.verifier.verify(f.result, false)).verificationStatus).toBe('FAILED');
    expect(f.monitor.errors).toHaveBeenCalledWith('page', 7);
  });
});
