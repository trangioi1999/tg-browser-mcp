import { createHash } from 'node:crypto';
import type { RawNode } from '../snapshot/injected.js';
import { isStableId, memoryKey, memoryLabel, safePlaceholder } from './sanitize.js';

/**
 * Persistent element fingerprints and page shape/label hashes (doc 03 §5, doc 07 §2). Pure functions.
 * A fingerprint holds the *shape* of an element only: never its value, row key or cell text.
 */
export interface ElementFingerprint {
  role: string;
  tag: string;
  inputType?: string;
  keys: { testId?: string; formControl?: string; nameAttr?: string; id?: string };
  /** Normalized nearest named form/dialog/region (`form:Request`). */
  container?: string;
  /** Nearest fieldset legend or landmark (`navigation:Main`). */
  group?: string;
  /** Normalized accessible name, ≤ 200 chars. */
  name: string;
  required?: boolean;
  placeholder?: string;
}

export interface Locator {
  kind: 'testId' | 'role' | 'label' | 'placeholder';
  value: string;
  name?: string;
}

export interface FingerprintedElement {
  semanticKey: string;
  fingerprint: ElementFingerprint;
  hash: string;
  locators: Locator[];
}

/** Roles remembered as elements. Rows, cells, list items, options and text are never remembered. */
const ELEMENT_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'file',
  'clickable',
  'heading',
  'dialog',
  'alertdialog',
  'form',
  'navigation',
  'main',
  'region',
  'search',
  'table',
  'grid',
  'treegrid',
  'columnheader',
]);

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function containerOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Raw guard containers are `role:name:id`; ids are kept only when stable-looking.
  const [role = '', name = '', id = ''] = raw.split(':');
  const label = memoryLabel(name, 80);
  const stable = id && isStableId(id) ? `#${id}` : '';
  return `${role}:${label}${stable}`.slice(0, 120);
}

function groupOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const i = raw.indexOf(':');
  return `${raw.slice(0, i)}:${memoryLabel(raw.slice(i + 1), 80)}`.slice(0, 120);
}

/** Fingerprint of one snapshot node (undefined when the node is not remembered). */
export function fingerprintOf(n: RawNode): ElementFingerprint | undefined {
  if (!ELEMENT_ROLES.has(n.role)) return undefined;
  const g = n.guard;
  if (!g) return undefined;
  // Row-scoped controls carry business row keys (table cell data): not remembered.
  if (g.rowKey !== undefined && n.role !== 'columnheader') return undefined;
  const keys: ElementFingerprint['keys'] = {};
  const testId = memoryKey(g.keys['data-testid'] ?? g.keys['data-test-id'] ?? g.keys['data-test']);
  if (testId) keys.testId = testId;
  const fc = memoryKey(g.keys.formcontrolname);
  if (fc) keys.formControl = fc;
  const nameAttr = memoryKey(g.keys.name);
  if (nameAttr) keys.nameAttr = nameAttr;
  if (g.keys.id && isStableId(g.keys.id)) keys.id = g.keys.id;
  const fp: ElementFingerprint = {
    role: n.role,
    tag: g.tag,
    keys,
    name: memoryLabel(n.name ?? g.name ?? ''),
  };
  if (g.inputType) fp.inputType = g.inputType.toLowerCase();
  const container = containerOf(g.container);
  if (container) fp.container = container;
  const group = groupOf(g.group);
  if (group) fp.group = group;
  if (n.states?.includes('required')) fp.required = true;
  const placeholder = safePlaceholder(n.description?.placeholder);
  if (placeholder) fp.placeholder = placeholder;
  return fp;
}

/** Strongest available identity key (doc 07 §3 pass order). */
export function strongKey(fp: ElementFingerprint): string | undefined {
  if (fp.keys.testId) return `tid:${fp.keys.testId}`;
  if (fp.keys.formControl) return `fc:${fp.keys.formControl}`;
  if (fp.keys.nameAttr) return `name:${fp.keys.nameAttr}`;
  if (fp.keys.id) return `id:${fp.keys.id}`;
  return undefined;
}

export function semanticKeyOf(fp: ElementFingerprint): string {
  const strong = strongKey(fp);
  const scope = fp.container ?? fp.group ?? '';
  if (strong) return `${fp.role}|${strong}|${fp.container ?? ''}`.slice(0, 400);
  return `${fp.role}|${JSON.stringify(fp.name)}|${scope}`.slice(0, 400);
}

export function fingerprintHash(fp: ElementFingerprint): string {
  return sha(
    JSON.stringify([
      fp.role,
      fp.tag,
      fp.inputType ?? '',
      fp.keys,
      fp.container ?? '',
      fp.group ?? '',
      fp.name,
      !!fp.required,
    ]),
  );
}

export function locatorsOf(fp: ElementFingerprint): Locator[] {
  const out: Locator[] = [];
  if (fp.keys.testId) out.push({ kind: 'testId', value: fp.keys.testId });
  if (fp.name && fp.role !== 'clickable') out.push({ kind: 'role', value: fp.role, name: fp.name });
  if (fp.placeholder) out.push({ kind: 'placeholder', value: fp.placeholder });
  return out;
}

function walk(nodes: RawNode[], fn: (n: RawNode) => void): void {
  for (const n of nodes) {
    fn(n);
    if (n.children) walk(n.children, fn);
  }
}

/**
 * All remembered elements of a snapshot in document order with unique semantic keys (duplicates get an
 * ordinal suffix `#2`, `#3`, which marks them as positional and therefore never verification targets).
 */
export function extractElements(nodes: RawNode[]): FingerprintedElement[] {
  const out: FingerprintedElement[] = [];
  const seen = new Map<string, number>();
  walk(nodes, (n) => {
    const fp = fingerprintOf(n);
    if (!fp) return;
    const base = semanticKeyOf(fp);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    out.push({
      semanticKey: count === 1 ? base : `${base}#${count}`,
      fingerprint: fp,
      hash: fingerprintHash(fp),
      locators: locatorsOf(fp),
    });
  });
  return out;
}

/** Page shape hash: sorted multiset of (role, tag, inputType, strong key, container role). */
export function shapeHash(elements: FingerprintedElement[]): string {
  return sha(
    elements
      .map(({ fingerprint: f }) =>
        [f.role, f.tag, f.inputType ?? '', strongKey(f) ?? '', (f.container ?? '').split(':')[0]].join(
          '\u0001',
        ),
      )
      .sort()
      .join('\n'),
  );
}

/** Page label hash: sorted multiset of normalized names. */
export function labelHash(elements: FingerprintedElement[]): string {
  return sha(
    elements
      .map((e) => `${e.fingerprint.role}\u0001${e.fingerprint.name}`)
      .sort()
      .join('\n'),
  );
}
