import type { RawNode } from './injected.js';

export interface DiffChange {
  type: 'added' | 'removed' | 'changed';
  ref?: string;
  role: string;
  name?: string;
  /** For `changed`: human-readable description of what changed. */
  detail?: string;
}

export interface SnapshotDiff {
  navigated: boolean;
  changes: DiffChange[];
  /** Number of changes omitted due to the limit. */
  omitted: number;
}

interface Flat {
  node: RawNode;
  parentRef?: string;
}

interface FlatText {
  text: string;
  /** Nearest ancestor element ref, if any. */
  parentRef?: string;
}

function flatten(
  nodes: RawNode[],
  out = new Map<string, Flat>(),
  texts: FlatText[] = [],
  parentRef?: string,
): { byRef: Map<string, Flat>; texts: FlatText[] } {
  for (const n of nodes) {
    if (n.ref) out.set(n.ref, { node: n, ...(parentRef ? { parentRef } : {}) });
    else if (n.role === 'text' && n.name) texts.push({ text: n.name, ...(parentRef ? { parentRef } : {}) });
    if (n.children) flatten(n.children, out, texts, n.ref ?? parentRef);
  }
  return { byRef: out, texts };
}

function describeChange(a: RawNode, b: RawNode): string | undefined {
  const parts: string[] = [];
  if ((a.name ?? '') !== (b.name ?? ''))
    parts.push(`name ${JSON.stringify(a.name ?? '')} → ${JSON.stringify(b.name ?? '')}`);
  if ((a.value ?? '') !== (b.value ?? ''))
    parts.push(`value ${JSON.stringify(a.value ?? '')} → ${JSON.stringify(b.value ?? '')}`);
  const sa = new Set(a.states ?? []);
  const sb = new Set(b.states ?? []);
  sa.delete('focused');
  sb.delete('focused');
  const plus = [...sb].filter((s) => !sa.has(s));
  const minus = [...sa].filter((s) => !sb.has(s));
  if (plus.length) parts.push(`+${plus.join(',+')}`);
  if (minus.length) parts.push(`-${minus.join(',-')}`);
  return parts.length ? parts.join('; ') : undefined;
}

/**
 * Computes a compact semantic diff between two snapshots of the same document.
 * Elements are matched by ref (refs are stable for the lifetime of an element).
 * Only the top-most added/removed element of a subtree is reported.
 */
export function diffSnapshots(
  prev: { docId: string; nodes: RawNode[] },
  next: { docId: string; nodes: RawNode[] },
  limit = 40,
): SnapshotDiff {
  if (prev.docId !== next.docId) return { navigated: true, changes: [], omitted: 0 };
  const a = flatten(prev.nodes);
  const b = flatten(next.nodes);
  const changes: DiffChange[] = [];

  for (const [ref, { node, parentRef }] of b.byRef) {
    const old = a.byRef.get(ref);
    if (!old) {
      if (parentRef && !a.byRef.has(parentRef) && b.byRef.has(parentRef)) continue; // parent also added
      changes.push({
        type: 'added',
        ref,
        role: node.role,
        ...(node.name ? { name: node.name } : {}),
        ...(node.value ? { detail: `value ${JSON.stringify(node.value)}` } : {}),
      });
      continue;
    }
    const d = describeChange(old.node, node);
    if (d)
      changes.push({
        type: 'changed',
        ref,
        role: node.role,
        ...(node.name ? { name: node.name } : {}),
        detail: d,
      });
  }
  for (const [ref, { node, parentRef }] of a.byRef) {
    if (b.byRef.has(ref)) continue;
    if (parentRef && !b.byRef.has(parentRef) && a.byRef.has(parentRef)) continue; // parent also removed
    changes.push({ type: 'removed', ref, role: node.role, ...(node.name ? { name: node.name } : {}) });
  }
  // Free text changes (multiset difference), useful for status messages rendered without roles.
  // Text inside an element that was itself added or removed is already covered by that element.
  const comparable = (texts: FlatText[], other: Map<string, Flat>) =>
    texts.filter((t) => !t.parentRef || other.has(t.parentRef)).map((t) => t.text);
  const count = (xs: string[]) =>
    xs.reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map<string, number>());
  const ca = count(comparable(a.texts, b.byRef));
  const cb = count(comparable(b.texts, a.byRef));
  for (const [t, n] of cb) if (n > (ca.get(t) ?? 0)) changes.push({ type: 'added', role: 'text', name: t });
  for (const [t, n] of ca) if (n > (cb.get(t) ?? 0)) changes.push({ type: 'removed', role: 'text', name: t });

  const order = { added: 0, changed: 1, removed: 2 } as const;
  changes.sort((x, y) => order[x.type] - order[y.type]);
  const omitted = Math.max(0, changes.length - limit);
  return { navigated: false, changes: changes.slice(0, limit), omitted };
}

export function formatDiff(d: SnapshotDiff): string {
  if (d.navigated) return 'Page navigated (new document).';
  if (d.changes.length === 0) return 'No visible changes.';
  const groups: Record<string, string[]> = { added: [], changed: [], removed: [] };
  for (const c of d.changes) {
    const label =
      c.role === 'text'
        ? `text: ${c.name}`
        : `${c.role}${c.name ? ` ${JSON.stringify(c.name)}` : ''}${c.ref ? ` [ref=${c.ref}]` : ''}`;
    groups[c.type]!.push(`- ${label}${c.detail ? ` (${c.detail})` : ''}`);
  }
  const out: string[] = [];
  if (groups.added!.length) out.push('Added:', ...groups.added!);
  if (groups.changed!.length) out.push('Changed:', ...groups.changed!);
  if (groups.removed!.length) out.push('Removed:', ...groups.removed!);
  if (d.omitted) out.push(`… ${d.omitted} more changes (call browser_snapshot for the full page)`);
  return out.join('\n');
}
