import type { ElementHandle, Frame, Locator } from 'playwright';
import { TgError } from '../shared/errors.js';
import type { ElementDescription, RefGuard } from './injected.js';

export type ResolveIntent = 'read' | 'input' | 'action';

export function compareGuards(old: RefGuard, current: RefGuard, intent: ResolveIntent): void {
  const context = { old, new: current };
  if (old.role !== current.role || old.tag !== current.tag || old.inputType !== current.inputType)
    throw new TgError('STALE_ELEMENT_REFERENCE', 'Target element type changed', { context });
  const keysMatch = JSON.stringify(old.keys) === JSON.stringify(current.keys);
  if (old.rowKey !== current.rowKey || old.container !== current.container || !keysMatch)
    throw new TgError('TARGET_CHANGED', 'Target business identity changed', { context });
  const keyedInput =
    intent === 'input' &&
    Object.keys(old.keys).length > 0 &&
    ['input', 'textarea', 'select'].includes(old.tag);
  if (old.name !== current.name && intent !== 'read' && !keyedInput)
    throw new TgError('TARGET_CHANGED', 'Target name changed', { context });
}

/** Independent Playwright utility-world reads. Never evaluate page-supplied code for approval names.
 * DOM labels themselves remain untrusted, and a page can race the subsequent action. */
export async function crossCheckDescription(
  el: ElementHandle<Element> | Locator,
  desc: ElementDescription,
  frame: Frame,
): Promise<ElementDescription> {
  const [ariaLabel, labelledBy, type, id, nameAttr, placeholder, title] = await Promise.all(
    ['aria-label', 'aria-labelledby', 'type', 'id', 'name', 'placeholder', 'title'].map((a) =>
      el.getAttribute(a),
    ),
  );
  let name: string | undefined;
  if (labelledBy) {
    const texts = await Promise.all(
      labelledBy
        .trim()
        .split(/\s+/)
        .map(async (id) => {
          const label = frame.locator(`[id=${JSON.stringify(id)}]`);
          return (await label.count()) === 1 ? await label.innerText() : '';
        }),
    );
    if (texts.some(Boolean)) name = texts.join(' ');
  } else {
    if (ariaLabel) name = ariaLabel;
    else if (desc.tag === 'input' && ['submit', 'reset', 'button'].includes(type || ''))
      name = (await el.inputValue()) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
    else if (desc.tag === 'input' && type === 'image') name = (await el.getAttribute('alt')) || 'Submit';
    else if (['button', 'link', 'menuitem', 'tab', 'option'].includes(desc.role) && desc.tag !== 'input')
      name = (await el.innerText()) || title || '';
  }
  if (name !== undefined && name.replace(/\s+/g, ' ').trim() !== desc.name)
    throw new TgError('TARGET_CHANGED', 'Target name differs from independent DOM read', {
      context: { old: desc.name, new: name },
    });
  return {
    ...desc,
    inputType: type || desc.inputType,
    id: id || undefined,
    placeholder: placeholder || undefined,
    // Include the native name attribute in the secondary masking decision.
    label: [desc.label, nameAttr].filter(Boolean).join(' ') || undefined,
  };
}

/** Same conservative name/label/id decision as ActionExecutor.isSensitiveField. */
export function isSensitiveDescription(desc: ElementDescription, keys: string[]): boolean {
  return (
    desc.inputType === 'password' ||
    keys.some(
      (key) =>
        key &&
        [desc.name, desc.label, desc.id].some((value) => value?.toLowerCase().includes(key.toLowerCase())),
    )
  );
}
