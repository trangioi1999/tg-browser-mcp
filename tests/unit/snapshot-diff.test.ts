import { describe, expect, it } from 'vitest';
import { diffSnapshots, formatDiff } from '../../src/snapshot/snapshot-diff.js';
import { formatSnapshot } from '../../src/snapshot/snapshot-engine.js';
import type { RawNode } from '../../src/snapshot/injected.js';

const doc = (nodes: RawNode[], docId = 'd1') => ({ docId, nodes });

describe('snapshot diff', () => {
  const before: RawNode[] = [
    { role: 'button', name: 'Submit', ref: 'e1' },
    { role: 'status', name: 'Draft', ref: 'e2' },
    { role: 'button', name: 'Save Draft', ref: 'e3' },
    { role: 'text', name: 'hello' },
  ];
  it('reports added, changed, removed', () => {
    const after: RawNode[] = [
      { role: 'button', name: 'Submit', ref: 'e1', states: ['disabled'] },
      { role: 'status', name: 'Pending Approval', ref: 'e2' },
      { role: 'alert', name: 'Request submitted successfully', ref: 'e9' },
      { role: 'text', name: 'hello' },
    ];
    const d = diffSnapshots(doc(before), doc(after));
    expect(d.navigated).toBe(false);
    const txt = formatDiff(d);
    expect(txt).toContain('Added:\n- alert "Request submitted successfully" [ref=e9]');
    expect(txt).toContain('button "Submit" [ref=e1] (+disabled)');
    expect(txt).toContain('name "Draft" → "Pending Approval"');
    expect(txt).toContain('Removed:\n- button "Save Draft" [ref=e3]');
    expect(txt).not.toContain('hello');
  });
  it('reports only the root of an added subtree', () => {
    const after = [
      ...before,
      { role: 'dialog', name: 'Confirm', ref: 'e10', children: [{ role: 'button', name: 'OK', ref: 'e11' }] },
    ];
    const d = diffSnapshots(doc(before), doc(after));
    expect(d.changes.filter((c) => c.type === 'added').map((c) => c.ref)).toEqual(['e10']);
  });
  it('ignores focus-only changes and detects navigation', () => {
    const after = before.map((n) => (n.ref === 'e1' ? { ...n, states: ['focused'] } : n));
    expect(diffSnapshots(doc(before), doc(after)).changes).toHaveLength(0);
    expect(diffSnapshots(doc(before), doc(before, 'd2')).navigated).toBe(true);
    expect(formatDiff(diffSnapshots(doc(before), doc(before)))).toBe('No visible changes.');
  });
  it('limits the number of reported changes', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      role: 'button',
      name: `b${i}`,
      ref: `e${100 + i}`,
    }));
    const d = diffSnapshots(doc([]), doc(many), 10);
    expect(d.changes).toHaveLength(10);
    expect(d.omitted).toBe(90);
  });
  it('formats and paginates snapshots', () => {
    const nodes = Array.from({ length: 400 }, (_, i) => ({
      role: 'link',
      name: `Item number ${i}`,
      ref: `e${i}`,
    }));
    const s = {
      id: 1,
      url: 'http://x/',
      title: 'T',
      docId: 'd',
      nodes,
      nodeCount: 400,
      truncatedByNodeLimit: false,
    };
    const p1 = formatSnapshot(s, { maxChars: 2000 });
    expect(p1.totalPages).toBeGreaterThan(3);
    expect(p1.chars).toBeLessThanOrEqual(2000);
    expect(p1.text).toContain('call browser_snapshot with page=2');
    const p2 = formatSnapshot(s, { maxChars: 2000, page: 2 });
    expect(p2.text).not.toContain('Item number 0"');
  });
});

describe('snapshot diff: text inside added/removed elements', () => {
  it('does not list text that belongs to an added or removed element', () => {
    const prev: RawNode[] = [
      {
        role: 'main',
        ref: 'e1',
        children: [
          { role: 'text', name: 'Landing copy' },
          { role: 'heading', name: 'Hi', ref: 'e2' },
        ],
      },
      { role: 'status', name: 'Idle', ref: 'e3' },
      { role: 'text', name: 'Top-level note' },
    ];
    const next: RawNode[] = [
      { role: 'dialog', name: 'Sign in', ref: 'e9', children: [{ role: 'text', name: 'Welcome back' }] },
      { role: 'status', name: 'Idle', ref: 'e3', children: [{ role: 'text', name: 'Now saving' }] },
    ];
    const txt = formatDiff(diffSnapshots(doc(prev), doc(next)));
    expect(txt).toContain('dialog "Sign in" [ref=e9]');
    expect(txt).toContain('main [ref=e1]');
    expect(txt).not.toContain('Welcome back'); // inside the added dialog
    expect(txt).not.toContain('Landing copy'); // inside the removed main
    expect(txt).toContain('text: Now saving'); // inside a surviving element
    expect(txt).toContain('text: Top-level note'); // top-level text still reported
  });
});
