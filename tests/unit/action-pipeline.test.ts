import './pipeline-coverage.js';

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ActionPipeline } from '../../src/harness/action-pipeline.js';
import { parseConfig } from '../../src/config/load-config.js';
import { AsyncLock } from '../../src/shared/async-lock.js';
import { DataRedactor } from '../../src/security/data-redactor.js';
import { runWithBudget, budgetTimeoutError } from '../../src/harness/call-scope.js';

vi.mock('../../src/snapshot/snapshot-engine.js', () => ({
  captureSnapshot: vi.fn(async () => ({ docId: 'doc', nodes: [], url: 'http://localhost/' })),
  formatSnapshot: () => ({ text: 'snapshot' }),
}));

function fixture() {
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => false,
    locator: () => ({ count: async () => 0 }),
    url: () => 'http://localhost/',
    waitForLoadState: async () => undefined,
    frames: () => [],
  });
  const ps = {
    id: 'p',
    page,
    refs: {},
    lock: new AsyncLock(),
    pendingDialog: undefined,
    lastSnapshot: undefined,
  };
  const session = {
    id: 's',
    name: 'session',
    activePageId: 'p',
    pages: new Map([['p', ps]]),
    page: () => ps,
    newPagesQueue: [] as string[],
    monitor: { lastSeq: 0, network: () => ({ entries: [] }), errors: () => ({ console: [], network: [] }) },
  };
  const sessions = {
    get: vi.fn(() => session),
    ensureActive: async () => session,
    openPage: vi.fn(async () => ps),
  };
  const events = { emit: vi.fn() };
  const pipeline = new ActionPipeline(
    parseConfig({}),
    sessions as never,
    {} as never,
    {} as never,
    new DataRedactor(),
    events as never,
  );
  return { pipeline, ps, session, sessions, events, page };
}

describe('ActionPipeline', () => {
  it('resolves sessions/pages and observes an action under a lock', async () => {
    const { pipeline, ps, sessions, events } = fixture();
    const result = await pipeline.run(
      { session: 'session', project: 'project', pageId: 'p' },
      'click',
      'button',
      async () => {
        expect(ps.lock.holder).toBeDefined();
        return { message: 'clicked', extra: { data: 1 } };
      },
    );
    expect(sessions.get).toHaveBeenCalledWith('session', 'project');
    expect(result).toMatchObject({ success: true, pageState: 'snapshot', data: 1 });
    expect(events.emit).toHaveBeenCalledWith('action.completed', expect.anything());
    expect(ps.lock.holder).toBeUndefined();
  });
  it('diffs successive observations and supports none/full modes', async () => {
    const { pipeline } = fixture();
    const fn = async () => ({ message: 'done' });
    await pipeline.run({}, 'wait', undefined, fn);
    expect((await pipeline.run({}, 'wait', undefined, fn)).diff?.changes).toEqual([]);
    expect((await pipeline.run({ snapshot: 'none' }, 'wait', undefined, fn)).pageState).toBeUndefined();
    expect((await pipeline.run({ snapshot: 'full' }, 'wait', undefined, fn)).pageState).toBe('snapshot');
  });
  it('normalizes errors, emits failure, and releases the lock', async () => {
    const { pipeline, ps, events } = fixture();
    await expect(
      pipeline.run({}, 'click', 'button', async () => {
        throw new Error('broken');
      }),
    ).rejects.toMatchObject({ code: 'ACTION_FAILED', context: { target: 'button' } });
    expect(events.emit).toHaveBeenCalledWith(
      'action.failed',
      expect.objectContaining({ code: 'ACTION_FAILED' }),
    );
    expect(ps.lock.holder).toBeUndefined();
  });
  it('opens a page when there is no active page and reports new pages', async () => {
    const { pipeline, session, sessions } = fixture();
    session.activePageId = '';
    session.newPagesQueue.push('p', 'missing');
    expect(
      (await pipeline.run({}, 'wait', undefined, async () => ({ message: 'done' }))).newPages,
    ).toHaveLength(2);
    expect(sessions.openPage).toHaveBeenCalled();
  });
  it('reports a dialog race and blocks subsequent actions', async () => {
    const { pipeline, ps, page } = fixture();
    const result = await pipeline.run({}, 'click', undefined, async () => {
      Object.assign(ps, { pendingDialog: { type: 'alert', message: 'hello' } });
      page.emit('dialog');
      return new Promise<never>(() => {});
    });
    expect(result.dialog).toEqual({ type: 'alert', message: 'hello' });
    await expect(pipeline.run({}, 'click', undefined, async () => ({ message: 'no' }))).rejects.toMatchObject(
      { code: 'ACTION_FAILED' },
    );
    expect((await pipeline.run({}, 'dialog', undefined, async () => ({ message: 'handled' }))).message).toBe(
      'handled',
    );
  });
  it('releases inspection locks even after failure', async () => {
    const { pipeline, ps } = fixture();
    await expect(
      pipeline.locked(ps as never, 'read', async () => {
        throw new Error('read');
      }),
    ).rejects.toThrow('read');
    expect(ps.lock.holder).toBeUndefined();
  });
  it('keeps abandoned work locked and caps inner timeouts', async () => {
    const { pipeline, ps } = fixture();
    expect(pipeline.timeout(1234)).toBe(1234);
    let finish!: () => void;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await expect(
      runWithBudget(
        20,
        () =>
          pipeline.run({}, 'click', undefined, async () => {
            expect(pipeline.timeout()).toBe(500);
            await work;
            return { message: 'done' };
          }),
        { onTimeout: (s) => budgetTimeoutError('click', 20, s, false) },
      ),
    ).rejects.toMatchObject({ retryable: false });
    await expect(pipeline.lockPage(ps as never, 'next')).rejects.toMatchObject({ code: 'PAGE_BUSY' });
    finish();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ps.lock.holder).toBeUndefined();
  });
});

describe('pipeline policy and observation boundaries', () => {
  it('probes resolved and focused targets without bypassing the gate', async () => {
    const { pipeline, ps, page } = fixture();
    const enforce = vi.spyOn(pipeline.gate, 'enforce').mockResolvedValue();
    const evaluate = vi.fn(async () => [
      { name: 'Submit', role: 'button', via: 'self' },
      { name: 'Form', role: 'form', via: 'form' },
    ]);
    const r = { kind: 'locator', locator: { evaluate }, desc: { name: 'Field', role: 'textbox' } };
    await pipeline.gateActivations(ps as never, r as never, ['enter', 'enter', 'space'], 'Press');
    expect(enforce).toHaveBeenCalledTimes(2);
    const handle = { evaluate, dispose: vi.fn(async () => undefined) };
    Object.assign(page, {
      frames: () => [
        { evaluateHandle: async () => ({ asElement: () => handle }) },
        { evaluateHandle: async () => ({ asElement: () => null, dispose: async () => undefined }) },
      ],
    });
    await pipeline.gateActivations(ps as never, undefined, ['enter'], 'Press');
    expect(handle.dispose).toHaveBeenCalled();
    await pipeline.activationTargets(ps as never, { kind: 'handle', handle, desc: r.desc } as never, 'enter');
    evaluate.mockRejectedValueOnce(new Error('detached'));
    expect(await pipeline.activationTargets(ps as never, r as never, 'space')).toEqual([
      { name: 'Field', role: 'textbox', via: 'target' },
    ]);
  });
  it('masks sensitivity and exposes artifact paths', () => {
    const { pipeline } = fixture();
    expect(pipeline.artifactsDir).toContain('artifacts');
    for (const desc of [
      { inputType: 'password' },
      { name: 'token' },
      { label: 'password' },
      { id: 'secret' },
    ])
      expect(pipeline.isSensitiveField(desc as never)).toBe(true);
    expect(pipeline.isSensitiveField({ name: 'Company' } as never)).toBe(false);
  });
  it('waits for action-window requests and includes monitor failures', async () => {
    const { pipeline, session } = fixture();
    let calls = 0;
    Object.assign(session.monitor, {
      network: () => ({
        entries: ++calls === 1 ? [{ status: null, failure: null, resourceType: 'fetch' }] : [],
      }),
      errors: () => ({
        console: [],
        network: [
          { method: 'GET', url: 'http://localhost/api', status: 500, resourceType: 'fetch', durationMs: 1 },
        ],
      }),
    });
    const r = await pipeline.run({}, 'wait', undefined, async () => ({ message: 'done' }));
    expect(calls).toBeGreaterThan(1);
    expect(r.errors?.network).toContain('500');
  });
});
