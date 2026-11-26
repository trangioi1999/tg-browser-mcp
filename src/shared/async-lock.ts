/**
 * FIFO async mutex with bounded, cancellable waits (TGB-009).
 *
 * One lock per page serializes actions, snapshots and ref-resolving inspections, so concurrent
 * callers (HTTP clients, background workflows, SDK) cannot interleave and rebind refs.
 *
 * A holder whose caller already gave up (outer timeout) keeps the lock until its Playwright promise
 * settles; {@link AsyncLock.abandon} makes every queued and future caller fail fast with the
 * busy error instead of overlapping a possibly still-running action (TGB-007).
 */

export interface LockHolder {
  readonly label: string;
  readonly since: number;
  abandoned: boolean;
}

export type Release = () => void;

export interface AcquireOptions {
  /** Maximum time to wait in the queue. */
  waitMs: number;
  /** Aborting removes the caller from the queue; it never acquires afterwards. */
  signal?: AbortSignal | undefined;
  /** Error for "lock not available" (queue wait exceeded, or holder abandoned). */
  busyError: (holder: LockHolder | undefined) => Error;
}

interface Waiter {
  label: string;
  grant: () => void;
  fail: (e: unknown) => void;
  busyError: AcquireOptions['busyError'];
}

export class AsyncLock {
  private current: LockHolder | undefined;
  private readonly queue: Waiter[] = [];

  /** Current holder, if any. */
  get holder(): LockHolder | undefined {
    return this.current;
  }

  get queued(): number {
    return this.queue.length;
  }

  acquire(label: string, opts: AcquireOptions): Promise<Release> {
    if (opts.signal?.aborted) return Promise.reject(opts.signal.reason);
    if (!this.current) return Promise.resolve(this.take(label));
    if (this.current.abandoned) return Promise.reject(opts.busyError(this.current));
    return new Promise<Release>((resolve, reject) => {
      const onAbort = () => this.drop(w, opts.signal!.reason);
      const cleanup = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      };
      const w: Waiter = {
        label,
        busyError: opts.busyError,
        grant: () => {
          cleanup();
          resolve(this.take(label));
        },
        fail: (e) => {
          cleanup();
          reject(e);
        },
      };
      this.queue.push(w);
      const timer = setTimeout(() => this.drop(w, opts.busyError(this.current)), Math.max(0, opts.waitMs));
      timer.unref?.();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Runs `fn` while holding the lock. */
  async run<T>(label: string, opts: AcquireOptions, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(label, opts);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Marks the current holder as abandoned by its caller: queued and future callers fail fast with
   * their busy error until the holder releases.
   */
  abandon(): void {
    if (!this.current) return;
    this.current.abandoned = true;
    for (const w of this.queue.splice(0)) w.fail(w.busyError(this.current));
  }

  private take(label: string): Release {
    const h: LockHolder = { label, since: Date.now(), abandoned: false };
    this.current = h;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.current !== h) return;
      this.current = undefined;
      this.queue.shift()?.grant();
    };
  }

  private drop(w: Waiter, e: unknown): void {
    const i = this.queue.indexOf(w);
    if (i < 0) return;
    this.queue.splice(i, 1);
    w.fail(e);
  }
}
