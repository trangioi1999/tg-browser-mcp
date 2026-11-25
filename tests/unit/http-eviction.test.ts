import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  isBusy,
  isIdle,
  pickEvictable,
  trackRequest,
  type ReapableSession,
} from '../../src/server/transports/streamable-http.js';

const sess = (lastSeen: number, inFlight = 0, runs: string[] = []): ReapableSession => ({
  lastSeen,
  inFlight,
  runs: new Set(runs),
});

describe('HTTP session reaping and eviction (D17)', () => {
  const now = 1_000_000;
  const idleMs = 60_000;

  it('never reaps a session with a request in flight or a running workflow', () => {
    expect(isIdle(sess(now - 10 * idleMs), now, idleMs)).toBe(true);
    expect(isIdle(sess(now - 10 * idleMs, 1), now, idleMs)).toBe(false);
    expect(isIdle(sess(now - 10 * idleMs, 0, ['run_1']), now, idleMs)).toBe(false);
    expect(isIdle(sess(now - 1000), now, idleMs)).toBe(false);
    expect(isBusy(sess(0, 2))).toBe(true);
  });

  it('evicts the stalest idle session, skipping busy ones', () => {
    const map = new Map<string, ReapableSession>([
      ['busy-oldest', sess(now - 100 * idleMs, 1)],
      ['workflow', sess(now - 90 * idleMs, 0, ['run_bg'])],
      ['idle-old', sess(now - 50 * idleMs)],
      ['idle-newer', sess(now - 20 * idleMs)],
      ['fresh', sess(now - 1000)],
    ]);
    expect(pickEvictable(map, now, idleMs)?.[0]).toBe('idle-old');
    map.delete('idle-old');
    map.delete('idle-newer');
    // Only busy or recently active sessions are left: nobody is evicted.
    expect(pickEvictable(map, now, idleMs)).toBeUndefined();
  });

  it('counts a request in flight until its response closes, refreshing lastSeen at both ends', () => {
    const s = sess(0);
    const res1 = new EventEmitter();
    const res2 = new EventEmitter();
    trackRequest(s, res1);
    trackRequest(s, res2);
    expect(s.inFlight).toBe(2);
    expect(s.lastSeen).toBeGreaterThan(0);
    // A long call that started long ago is still not idle.
    s.lastSeen = Date.now() - 10 * idleMs;
    expect(isIdle(s, Date.now(), idleMs)).toBe(false);
    expect(pickEvictable([['a', s]], Date.now(), idleMs)).toBeUndefined();
    res1.emit('close');
    res1.emit('close'); // idempotent
    expect(s.inFlight).toBe(1);
    res2.emit('close');
    expect(s.inFlight).toBe(0);
    // Finishing the call counts as activity.
    expect(Date.now() - s.lastSeen).toBeLessThan(1000);
    expect(isIdle(s, Date.now(), idleMs)).toBe(false);
    expect(isIdle(s, Date.now() + 2 * idleMs, idleMs)).toBe(true);
  });
});
