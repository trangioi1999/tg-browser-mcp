import { AsyncLocalStorage } from 'node:async_hooks';
import type { AsyncLock } from '../shared/async-lock.js';
import { TgError } from '../shared/errors.js';

/**
 * Budgeted call scope (TGB-007): carries a caller's deadline and cancellation signal into the harness
 * without threading them through every tool handler.
 *
 * - Inner Playwright timeouts are capped below the remaining budget, so the outer timer is a last resort.
 * - Callers still waiting for a page lock when the budget expires are dequeued and never dispatch.
 * - When the budget expires after an action was dispatched, the page locks held by the call are marked
 *   abandoned: the page reports PAGE_BUSY until the still-running Playwright promise settles, and the
 *   caller gets an INDETERMINATE (not retry-safe) timeout.
 *
 * The harness owns this module; transports and the workflow engine wrap calls with {@link runWithBudget}.
 */
export interface CallScope {
  readonly signal: AbortSignal;
  /** Epoch ms after which the caller has given up. */
  readonly deadline: number;
  /** Set once a browser action that may change page or server state has been dispatched. */
  dispatched: boolean;
  /** Page locks currently held by this call. */
  readonly held: Set<AsyncLock>;
  /** True once the caller has received its result (later background work runs unbudgeted). */
  done: boolean;
}

const storage = new AsyncLocalStorage<CallScope>();

/** The active, unfinished call scope, if any. */
export function currentScope(): CallScope | undefined {
  const s = storage.getStore();
  return s && !s.done ? s : undefined;
}

/** Records that the current call dispatched a (possibly) state-changing action. */
export function markDispatched(): void {
  const s = currentScope();
  if (s) s.dispatched = true;
}

export interface BudgetOptions {
  /** Additional cancellation source (e.g. workflow cancel). Its reason is rethrown as-is. */
  signal?: AbortSignal | undefined;
  /** Builds the timeout error from the scope's dispatch state. */
  onTimeout: (scope: CallScope) => Error;
}

/**
 * Runs `fn` with a time budget. Nested budgets inherit the earlier deadline and are cancelled with
 * their parent. On expiry the returned promise rejects immediately; `fn` keeps running (Playwright
 * actions cannot be cancelled safely) but holds its page locks in the abandoned state until it settles.
 */
export async function runWithBudget<T>(ms: number, fn: () => Promise<T>, opts: BudgetOptions): Promise<T> {
  const parent = currentScope();
  const controller = new AbortController();
  const scope: CallScope = {
    signal: controller.signal,
    deadline: Math.min(Date.now() + ms, parent?.deadline ?? Infinity),
    dispatched: false,
    held: new Set(),
    done: false,
  };
  let rejectOuter: ((e: unknown) => void) | undefined;
  const expire = (err: unknown) => {
    if (controller.signal.aborted) return;
    controller.abort(err);
    for (const lock of scope.held) lock.abandon();
    rejectOuter?.(err);
  };
  const sources = [parent?.signal, opts.signal].filter((s): s is AbortSignal => !!s);
  const listeners = sources.map((src) => {
    const l = () => expire(src.reason);
    if (src.aborted) l();
    else src.addEventListener('abort', l, { once: true });
    return () => src.removeEventListener('abort', l);
  });
  const outer = new Promise<never>((_, reject) => {
    rejectOuter = reject;
  });
  if (controller.signal.aborted) {
    listeners.forEach((off) => off());
    throw controller.signal.reason;
  }
  const work = storage.run(scope, fn);
  work.catch(() => undefined);
  outer.catch(() => undefined);
  const timer = setTimeout(() => expire(opts.onTimeout(scope)), Math.max(0, scope.deadline - Date.now()));
  try {
    return await Promise.race([work, outer]);
  } finally {
    clearTimeout(timer);
    listeners.forEach((off) => off());
    scope.done = true;
  }
}

/**
 * Timeout error that does not lie (doc 04 §6): retry-safe only when nothing was dispatched or the
 * dispatched work is safe to repeat. Otherwise the outcome is INDETERMINATE and the page stays busy
 * until the running action settles.
 */
export function budgetTimeoutError(
  label: string,
  ms: number,
  scope: CallScope,
  safeToRepeat: boolean,
): TgError {
  if (!scope.dispatched)
    return new TgError(
      'ACTION_TIMEOUT',
      `${label} exceeded its ${ms}ms limit before any action was dispatched`,
      {
        retryable: true,
        context: { outcome: 'NOT_STARTED', dispatch: 'not_started' },
      },
    );
  if (safeToRepeat)
    return new TgError('ACTION_TIMEOUT', `${label} exceeded its ${ms}ms limit`, {
      retryable: true,
      context: { outcome: 'INDETERMINATE', dispatch: 'unknown' },
    });
  return new TgError(
    'ACTION_TIMEOUT',
    `${label} exceeded its ${ms}ms limit; the action was dispatched and may still complete`,
    {
      retryable: false,
      context: { outcome: 'INDETERMINATE', dispatch: 'unknown' },
      suggestion:
        'Do not repeat the action blindly. Wait, then call browser_snapshot (the page reports PAGE_BUSY until the action settles) and check whether it took effect.',
    },
  );
}
