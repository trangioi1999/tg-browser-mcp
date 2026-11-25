import { describe, expect, it } from 'vitest';
import { AsyncLock } from '../../src/shared/async-lock.js';
import {
  budgetTimeoutError,
  currentScope,
  markDispatched,
  runWithBudget,
} from '../../src/harness/call-scope.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const busy = () => new Error('BUSY');

describe('AsyncLock (TGB-009)', () => {
  it('serializes holders in FIFO order', async () => {
    const lock = new AsyncLock();
    const order: string[] = [];
    const job = (name: string, ms: number) =>
      lock.run(name, { waitMs: 1000, busyError: busy }, async () => {
        order.push(`${name}:start`);
        await sleep(ms);
        order.push(`${name}:end`);
      });
    await Promise.all([job('a', 30), job('b', 5), job('c', 5)]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    expect(lock.holder).toBeUndefined();
  });

  it('fails a waiter with the busy error when its wait bound expires', async () => {
    const lock = new AsyncLock();
    const release = await lock.acquire('a', { waitMs: 0, busyError: busy });
    await expect(lock.acquire('b', { waitMs: 20, busyError: busy })).rejects.toThrow('BUSY');
    expect(lock.queued).toBe(0);
    release();
  });

  it('dequeues an aborted waiter so it never acquires', async () => {
    const lock = new AsyncLock();
    const release = await lock.acquire('a', { waitMs: 0, busyError: busy });
    const ac = new AbortController();
    let acquired = false;
    const p = lock.acquire('b', { waitMs: 1000, signal: ac.signal, busyError: busy }).then(() => {
      acquired = true;
    });
    ac.abort(new Error('gave up'));
    await expect(p).rejects.toThrow('gave up');
    release();
    await sleep(5);
    expect(acquired).toBe(false);
    expect(lock.holder).toBeUndefined();
  });

  it('abandon() fails queued and new callers fast until the holder releases', async () => {
    const lock = new AsyncLock();
    const release = await lock.acquire('slow click', { waitMs: 0, busyError: busy });
    const queued = lock.acquire('b', { waitMs: 1000, busyError: (h) => new Error(`BUSY ${h?.label}`) });
    lock.abandon();
    await expect(queued).rejects.toThrow('BUSY slow click');
    await expect(lock.acquire('c', { waitMs: 1000, busyError: busy })).rejects.toThrow('BUSY');
    release();
    const r = await lock.acquire('d', { waitMs: 0, busyError: busy });
    expect(lock.holder?.label).toBe('d');
    r();
  });
});

describe('runWithBudget (TGB-007)', () => {
  const onTimeout = (label: string, ms: number, safe = false) => ({
    onTimeout: (scope: Parameters<typeof budgetTimeoutError>[2]) =>
      budgetTimeoutError(label, ms, scope, safe),
  });

  it('is retry-safe when nothing was dispatched', async () => {
    await expect(runWithBudget(20, () => sleep(200), onTimeout('t', 20))).rejects.toMatchObject({
      code: 'ACTION_TIMEOUT',
      retryable: true,
      context: { outcome: 'NOT_STARTED' },
    });
  });

  it('is INDETERMINATE and not retry-safe after a non-idempotent dispatch', async () => {
    const err = await runWithBudget(
      20,
      async () => {
        markDispatched();
        await sleep(200);
      },
      onTimeout('browser_click', 20),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'ACTION_TIMEOUT',
      retryable: false,
      context: { outcome: 'INDETERMINATE', dispatch: 'unknown' },
    });
  });

  it('stays retry-safe after dispatch for read-only/idempotent work', async () => {
    await expect(
      runWithBudget(
        20,
        async () => {
          markDispatched();
          await sleep(200);
        },
        onTimeout('browser_snapshot', 20, true),
      ),
    ).rejects.toMatchObject({ retryable: true, context: { outcome: 'INDETERMINATE' } });
  });

  it('abandons page locks held by the timed-out call', async () => {
    const lock = new AsyncLock();
    let release: (() => void) | undefined;
    const err = await runWithBudget(
      20,
      async () => {
        release = await lock.acquire('click', { waitMs: 0, busyError: busy });
        currentScope()!.held.add(lock);
        markDispatched();
        await sleep(100);
      },
      onTimeout('x', 20),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'ACTION_TIMEOUT' });
    expect(lock.holder?.abandoned).toBe(true);
    await expect(lock.acquire('next', { waitMs: 1000, busyError: busy })).rejects.toThrow('BUSY');
    release!();
  });

  it('nests: inherits the earlier deadline and is cancelled with the parent signal', async () => {
    let innerDeadline = 0;
    const outer = Date.now() + 50;
    await expect(
      runWithBudget(
        50,
        () =>
          runWithBudget(
            10_000,
            async () => {
              innerDeadline = currentScope()!.deadline;
              await sleep(500);
            },
            onTimeout('inner', 10_000),
          ),
        onTimeout('outer', 50),
      ),
    ).rejects.toMatchObject({ code: 'ACTION_TIMEOUT' });
    expect(innerDeadline).toBeLessThanOrEqual(outer + 5);
  });

  it('rethrows an external cancellation reason and ends the scope after return', async () => {
    const ac = new AbortController();
    const p = runWithBudget(1000, () => sleep(200), { signal: ac.signal, ...onTimeout('x', 1000) });
    ac.abort(new Error('Workflow cancelled'));
    await expect(p).rejects.toThrow('Workflow cancelled');

    let seen: unknown = 'unset';
    await runWithBudget(
      1000,
      async () => {
        setTimeout(() => (seen = currentScope()), 20);
      },
      onTimeout('x', 1000),
    );
    await sleep(40);
    expect(seen).toBeUndefined();
  });
});
