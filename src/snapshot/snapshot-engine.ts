import type { Frame, Page } from 'playwright';
import {
  collectScriptSource,
  installScriptSource,
  type CollectArgs,
  type CollectResult,
  type RawNode,
} from './injected.js';
import type { RefRegistry } from './element-reference.js';
import { diffSnapshots, type SnapshotDiff } from './snapshot-diff.js';

export interface SnapshotOptions {
  maxDepth: number;
  maxTextLength: number;
  includeText: boolean;
  sensitiveKeys: string[];
  maxChars: number;
  scopeRef?: string;
  /** 1-based page of the formatted output when it exceeds maxChars. */
  page?: number;
  /** Only include interactive elements (plus headings/dialogs for orientation). */
  interactiveOnly?: boolean;
  maxNodes?: number;
}

export interface Snapshot {
  id: number;
  url: string;
  title: string;
  framework?: string;
  /** Main document id: changes when the page navigates. */
  docId: string;
  nodes: RawNode[];
  nodeCount: number;
  truncatedByNodeLimit: boolean;
}

export interface FormattedSnapshot {
  text: string;
  page: number;
  totalPages: number;
  chars: number;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
  'file',
  'clickable',
]);
const ORIENTATION_ROLES = new Set([
  'heading',
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'iframe',
  'tabpanel',
  'form',
  'navigation',
  'main',
]);

async function ensureInstalled(frame: Frame): Promise<void> {
  await frame.evaluate(installScriptSource());
}

async function collectFrame(
  frame: Frame,
  refs: RefRegistry,
  args: Omit<CollectArgs, 'nextIndex'>,
  snapshotId: number,
  depthBudget: number,
): Promise<{ nodes: RawNode[]; docId: string; meta: CollectResult } | undefined> {
  try {
    await ensureInstalled(frame);
    const res = (await frame.evaluate(
      collectScriptSource({ ...args, nextIndex: refs.nextIndex }),
    )) as CollectResult;
    refs.nextIndex = res.nextIndex;
    const register = (nodes: RawNode[]) => {
      for (const n of nodes) {
        if (n.ref)
          refs.set({ ref: n.ref, frame, docId: res.docId, role: n.role, name: n.name ?? '', snapshotId });
        if (n.children) register(n.children);
      }
    };
    register(res.nodes);
    // Splice child frame snapshots into their <iframe> slots.
    if (depthBudget > 0) {
      for (const child of frame.childFrames()) {
        if (child.isDetached()) continue;
        let slotRef: string | undefined;
        try {
          const fe = await child.frameElement();
          slotRef = await fe.evaluate((el: Node) =>
            (window as unknown as { __tgSnap?: { refOf(e: Element): string | undefined } }).__tgSnap?.refOf(
              el as Element,
            ),
          );
          await fe.dispose();
        } catch {
          slotRef = undefined;
        }
        const slot = slotRef ? findNode(res.nodes, slotRef) : undefined;
        if (!slot) continue;
        const sub = await collectFrame(
          child,
          refs,
          { ...args, scopeRef: undefined },
          snapshotId,
          depthBudget - 1,
        );
        if (sub && sub.nodes.length) slot.children = sub.nodes;
      }
    }
    return { nodes: res.nodes, docId: res.docId, meta: res };
  } catch {
    return undefined;
  }
}

function findNode(nodes: RawNode[], ref: string): RawNode | undefined {
  for (const n of nodes) {
    if (n.ref === ref) return n;
    if (n.children) {
      const f = findNode(n.children, ref);
      if (f) return f;
    }
  }
  return undefined;
}

/** Captures an accessibility-oriented snapshot of the page (all frames, open shadow roots). */
export async function captureSnapshot(
  page: Page,
  refs: RefRegistry,
  opts: SnapshotOptions,
): Promise<Snapshot> {
  const snapshotId = ++refs.snapshotId;
  const args: Omit<CollectArgs, 'nextIndex'> = {
    maxDepth: opts.maxDepth,
    maxTextLength: opts.maxTextLength,
    includeText: opts.includeText && !opts.interactiveOnly,
    sensitiveKeys: opts.sensitiveKeys,
    maxNodes: opts.maxNodes ?? 4000,
    ...(opts.scopeRef ? { scopeRef: opts.scopeRef } : {}),
  };
  let frame = page.mainFrame();
  if (opts.scopeRef) {
    const entry = refs.get(opts.scopeRef);
    if (entry && !entry.frame.isDetached()) frame = entry.frame;
  }
  let res = await collectFrame(frame, refs, args, snapshotId, 3);
  if (!res) {
    // Page may be mid-navigation; wait briefly and retry once.
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
    res = await collectFrame(frame, refs, args, snapshotId, 3);
  }
  let nodes = res?.nodes ?? [];
  if (opts.interactiveOnly) nodes = filterInteractive(nodes);
  return {
    id: snapshotId,
    url: page.url(),
    title: res?.meta.title ?? (await page.title().catch(() => '')),
    ...(res?.meta.framework ? { framework: res.meta.framework } : {}),
    docId: res?.docId ?? '',
    nodes,
    nodeCount: res?.meta.nodeCount ?? 0,
    truncatedByNodeLimit: res?.meta.truncatedByNodeLimit ?? false,
  };
}

function filterInteractive(nodes: RawNode[]): RawNode[] {
  const out: RawNode[] = [];
  for (const n of nodes) {
    const kids = n.children ? filterInteractive(n.children) : [];
    if (INTERACTIVE_ROLES.has(n.role) || ORIENTATION_ROLES.has(n.role)) {
      const copy: RawNode = { ...n };
      if (kids.length) copy.children = kids;
      else delete copy.children;
      out.push(copy);
    } else out.push(...kids);
  }
  return out;
}

function quote(s: string): string {
  return JSON.stringify(s);
}

export function formatNode(n: RawNode): string {
  if (n.role === 'text') return `text: ${n.name ?? ''}`;
  let s = n.role;
  if (n.name) s += ` ${quote(n.name)}`;
  if (n.level) s += ` [level=${n.level}]`;
  if (n.states?.length) s += ` [${n.states.join(', ')}]`;
  if (n.ref) s += ` [ref=${n.ref}]`;
  if (n.value !== undefined && n.value !== '') s += `: ${quote(n.value)}`;
  return s;
}

export function formatLines(nodes: RawNode[], indent = 0, out: string[] = []): string[] {
  const pad = '  '.repeat(indent);
  for (const n of nodes) {
    out.push(`${pad}- ${formatNode(n)}`);
    if (n.children?.length) formatLines(n.children, indent + 1, out);
  }
  return out;
}

/** Formats the snapshot as compact text with header, paginated to maxChars. */
export function formatSnapshot(
  s: Snapshot,
  opts: { maxChars: number; page?: number; header?: boolean },
): FormattedSnapshot {
  const header = [`Page: ${s.title || '(untitled)'}`, `URL: ${s.url}`];
  if (s.framework) header.push(`Framework: ${s.framework}`);
  const lines = formatLines(s.nodes);
  if (lines.length === 0) lines.push('(no visible content)');
  if (s.truncatedByNodeLimit) lines.push('… node limit reached; use scope=<ref> to inspect a region');
  const budget = Math.max(500, opts.maxChars - header.join('\n').length - 120);
  const pages: string[][] = [[]];
  let size = 0;
  for (const l of lines) {
    if (size + l.length + 1 > budget && pages[pages.length - 1]!.length) {
      pages.push([]);
      size = 0;
    }
    pages[pages.length - 1]!.push(l.length > budget ? `${l.slice(0, budget - 1)}…` : l);
    size += l.length + 1;
  }
  const totalPages = pages.length;
  const page = Math.min(Math.max(1, opts.page ?? 1), totalPages);
  const body = pages[page - 1]!.join('\n');
  const footer =
    totalPages > 1
      ? `\n[snapshot page ${page}/${totalPages} — call browser_snapshot with page=${page + 1 <= totalPages ? page + 1 : 1} for more, or scope=<ref>]`
      : '';
  const text = `${opts.header === false ? '' : `${header.join('\n')}\n\n`}${body}${footer}`;
  return { text, page, totalPages, chars: text.length };
}

export { diffSnapshots, type SnapshotDiff };
