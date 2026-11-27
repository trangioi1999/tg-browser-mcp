import { AsyncLocalStorage } from 'node:async_hooks';
import type { RefGuard } from '../snapshot/injected.js';

/**
 * Collects the guards of elements an action resolved with a mutating intent (input/action), so that a
 * VERIFIED outcome can mark exactly those elements verified in Browser Memory (doc 06 §2.2).
 */
const store = new AsyncLocalStorage<RefGuard[]>();

export function collectActed<T>(fn: () => T): { result: T; acted: RefGuard[] } {
  const acted: RefGuard[] = [];
  return { result: store.run(acted, fn), acted };
}

export function noteActed(guard: RefGuard | undefined): void {
  if (guard) store.getStore()?.push(guard);
}
