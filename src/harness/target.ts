import { crossCheckDescription, type ResolveIntent } from '../snapshot/guard.js';
import { z } from 'zod';
import type { ElementHandle, Frame, Locator } from 'playwright';
import { installScriptSource, snapshotAccessKey, type ElementDescription } from '../snapshot/injected.js';
import type { PageState } from '../session/session.js';
import { TgError, toTgError } from '../shared/errors.js';

/**
 * How a tool addresses an element. Prefer `ref` from a snapshot; semantic locators follow
 * Playwright best practice priority: role > label > testId > placeholder > text > CSS selector.
 */
export const TargetShape = {
  ref: z.string().optional().describe('Element ref from snapshot (preferred)'),
  role: z.string().optional(),
  name: z.string().optional(),
  exact: z.boolean().optional(),
  label: z.string().optional(),
  testId: z.string().optional(),
  placeholder: z.string().optional(),
  text: z.string().optional(),
  selector: z.string().optional().describe('CSS (last resort)'),
  nth: z.number().int().min(0).optional(),
};

export const TargetSchema = z.object(TargetShape);
export type Target = z.infer<typeof TargetSchema>;

export function hasTarget(t: Partial<Target>): boolean {
  return !!(t.ref || t.role || t.label || t.testId || t.placeholder || t.text || t.selector);
}

export function describeTarget(t: Partial<Target>): string {
  if (t.ref) return `ref=${t.ref}`;
  if (t.role) return `role=${t.role}${t.name ? ` name="${t.name}"` : ''}`;
  if (t.label) return `label="${t.label}"`;
  if (t.testId) return `testId="${t.testId}"`;
  if (t.placeholder) return `placeholder="${t.placeholder}"`;
  if (t.text) return `text="${t.text}"`;
  if (t.selector) return `selector=${t.selector}`;
  return '(none)';
}

export type Resolved =
  | { kind: 'handle'; handle: ElementHandle<Element>; desc: ElementDescription; frame: Frame; ref: string }
  | { kind: 'locator'; locator: Locator; desc: ElementDescription; frame: Frame; ref?: string };

type AriaRole = Parameters<Frame['getByRole']>[0];

function buildLocator(frame: Frame, t: Target): Locator {
  let loc: Locator;
  if (t.role) {
    loc = frame.getByRole(
      t.role as AriaRole,
      t.name !== undefined ? { name: t.name, exact: t.exact ?? true } : {},
    );
  } else if (t.label) loc = frame.getByLabel(t.label, { exact: t.exact ?? false });
  else if (t.testId) loc = frame.getByTestId(t.testId);
  else if (t.placeholder) loc = frame.getByPlaceholder(t.placeholder, { exact: t.exact ?? false });
  else if (t.text) loc = frame.getByText(t.text, { exact: t.exact ?? false });
  else if (t.selector) {
    if (/^\s*(xpath=|\/\/|\.\.)/.test(t.selector))
      throw new TgError(
        'INVALID_ARGUMENT',
        'XPath selectors are not supported; use a ref, role, label, testId or CSS selector',
      );
    loc = frame.locator(t.selector);
  } else
    throw new TgError(
      'INVALID_ARGUMENT',
      'No target given. Provide ref (from browser_snapshot) or a semantic locator (role+name, label, testId, placeholder, text).',
    );
  return loc;
}

/** Resolves a Target into a live element. Waits up to `timeout` for semantic locators to appear. */
export async function resolveTarget(
  ps: PageState,
  t: Target,
  timeout: number,
  intent: ResolveIntent = 'action',
): Promise<Resolved> {
  if (t.ref) {
    const { handle, entry, desc } = await ps.refs.resolve(t.ref, intent);
    return { kind: 'handle', handle, desc, frame: entry.frame, ref: t.ref };
  }
  const frame = ps.frame();
  let loc = buildLocator(frame, t);
  if (t.nth !== undefined) loc = loc.nth(t.nth);
  try {
    await loc.first().waitFor({ state: 'attached', timeout });
  } catch (e) {
    const err = toTgError(e);
    if (err.code === 'ACTION_TIMEOUT' || err.code === 'NAVIGATION_TIMEOUT')
      throw new TgError('ELEMENT_NOT_FOUND', `No element matches ${describeTarget(t)}`, {
        retryable: true,
        context: { target: describeTarget(t) },
      });
    throw err;
  }
  const count = await loc.count();
  if (count > 1) {
    // Prefer the single visible match when hidden duplicates exist (common with overlays/templates).
    const visible = loc.locator('visible=true');
    if ((await visible.count()) === 1) loc = visible;
    else
      throw new TgError('ELEMENT_AMBIGUOUS', `${count} elements match ${describeTarget(t)}`, {
        context: { matches: count },
        suggestion: 'Use a ref from browser_snapshot, set exact=true, or pass nth.',
      });
  }
  try {
    await frame.evaluate(installScriptSource());
  } catch (cause) {
    throw new TgError('TARGET_CHANGED', 'Snapshot engine installation could not be verified', { cause });
  }
  const raw = await loc.evaluate(
    (el, key) =>
      (window as unknown as { __tgSnap: { describe(e: Element, key: string): string } }).__tgSnap.describe(
        el,
        key,
      ),
    snapshotAccessKey,
  );
  const desc = await crossCheckDescription(loc, JSON.parse(raw) as ElementDescription, frame);
  return { kind: 'locator', locator: loc, desc, frame };
}

/** Builds the most robust Playwright locator expression for an element (used by test generation). */
export function suggestLocator(desc: ElementDescription): { expr: string; target: Target } {
  const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const standardRole = !['generic', 'clickable', 'file'].includes(desc.role);
  if (standardRole && desc.name && desc.name.length <= 80) {
    return {
      expr: `getByRole(${q(desc.role)}, { name: ${q(desc.name)}, exact: true })`,
      target: { role: desc.role, name: desc.name, exact: true },
    };
  }
  if (desc.label) return { expr: `getByLabel(${q(desc.label)})`, target: { label: desc.label } };
  if (desc.testId) return { expr: `getByTestId(${q(desc.testId)})`, target: { testId: desc.testId } };
  if (desc.placeholder)
    return { expr: `getByPlaceholder(${q(desc.placeholder)})`, target: { placeholder: desc.placeholder } };
  if (desc.name && desc.name.length <= 80)
    return { expr: `getByText(${q(desc.name)}, { exact: true })`, target: { text: desc.name, exact: true } };
  if (desc.id) return { expr: `locator(${q(`#${desc.id}`)})`, target: { selector: `#${desc.id}` } };
  return { expr: `locator(${q(desc.tag || '*')})`, target: { selector: desc.tag || '*' } };
}
