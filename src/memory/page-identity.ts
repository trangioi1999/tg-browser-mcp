import { createHash } from 'node:crypto';
import type { RawNode } from '../snapshot/injected.js';
import { cleanText, memoryLabel } from './sanitize.js';

/** Query parameters that select a page mode (variant) rather than a record (doc 07 §4). */
const MODE_PARAMS = new Set(['mode', 'tab', 'view', 'step', 'action', 'section']);

function segment(s: string): string {
  let d: string;
  try {
    d = decodeURIComponent(s);
  } catch {
    d = s;
  }
  if (!d) return d;
  if (/^\d+$/.test(d)) return ':id';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d)) return ':id';
  if (/^[0-9a-f]{12,}$/i.test(d)) return ':id';
  // Business keys such as REQ001, INV-2024-17, user@example.com.
  if (/\d/.test(d) && /^[A-Za-z0-9._~@+-]+$/.test(d) && (d.match(/\d/g) ?? []).length >= 2) return ':id';
  if (/@/.test(d)) return ':id';
  if (d.length > 40) return ':id';
  return cleanText(d, 40).replace(/[^\w.~-]/g, '_');
}

function normalizePath(p: string): string {
  const parts = p.split('/').map(segment);
  const out = parts.join('/').replace(/\/{2,}/g, '/');
  return out.length > 1 ? out.replace(/\/$/, '') : out || '/';
}

/**
 * Route key: normalized path pattern (`/requests/:id`). Query strings and fragments are dropped, except
 * hash-routing fragments (`#/requests/12` → `#/requests/:id`). Template placeholders (`${base}`) are kept
 * as `:var`, so workflow URLs and live URLs normalize alike.
 */
export function routeKey(url: string): string {
  const templated = url.replace(/\$\{[^}]*\}/g, (m, offset: number) => (offset === 0 ? '' : ':var'));
  let path = templated;
  let hash = '';
  try {
    const u = new URL(templated, 'http://placeholder.invalid');
    path = u.pathname;
    hash = u.hash;
  } catch {
    path = templated.split(/[?#]/)[0] ?? '/';
  }
  let key = normalizePath(path.startsWith('/') ? path : `/${path}`);
  if (/^#!?\//.test(hash)) key += `#${normalizePath(hash.replace(/^#!?/, '').split('?')[0]!)}`;
  return key.slice(0, 300);
}

function walk(nodes: RawNode[], fn: (n: RawNode) => void): void {
  for (const n of nodes) {
    fn(n);
    if (n.children) walk(n.children, fn);
  }
}

/** Primary heading: first level-1 heading, else the first heading. Normalized (digits → #) and short. */
export function primaryHeading(nodes: RawNode[]): string {
  let first: string | undefined;
  let h1: string | undefined;
  walk(nodes, (n) => {
    if (n.role !== 'heading' || !n.name) return;
    first ??= n.name;
    if (n.level === 1) h1 ??= n.name;
  });
  return memoryLabel(h1 ?? first ?? '', 80);
}

/** Page key = route key + primary heading signature (doc 05 `pages.page_key`). */
export function pageKey(route: string, nodes: RawNode[]): string {
  const heading = primaryHeading(nodes);
  if (!heading) return route;
  return `${route} ${createHash('sha256').update(heading).digest('hex').slice(0, 12)}`;
}

/**
 * Variant key from observable state (doc 07 §4): open dialogs, selected tabs and URL mode parameters.
 * Expanded sections are not included (too volatile for a page dimension in Phase 2).
 */
export function variantKey(url: string, nodes: RawNode[]): string {
  const parts: string[] = [];
  walk(nodes, (n) => {
    if ((n.role === 'dialog' || n.role === 'alertdialog') && n.name !== undefined)
      parts.push(`dialog=${memoryLabel(n.name, 60)}`);
    if (n.role === 'tab' && n.states?.includes('selected'))
      parts.push(`tab=${memoryLabel(n.name ?? '', 60)}`);
  });
  try {
    const u = new URL(url);
    for (const [k, v] of u.searchParams)
      if (MODE_PARAMS.has(k.toLowerCase()) && /^[A-Za-z_-]{1,30}$/.test(v))
        parts.push(`${k.toLowerCase()}=${v}`);
  } catch {
    // no query
  }
  return [...new Set(parts)].sort().join('|').slice(0, 300);
}
