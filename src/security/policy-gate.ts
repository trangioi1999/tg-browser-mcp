import type { PermissionManager } from './permission-manager.js';
import { safeUrlForLog } from './domain-policy.js';

/**
 * Policy gate for mutating browser actions (TGB-002 / S-01).
 *
 * Destructive-name approval used to happen only in `click`; Enter/Space on the same button, fill/type
 * with submit, select, check and drag bypassed `security.approval.destructive`. Every mutating action
 * now classifies its *effective* target — the element that will actually be activated — and passes it
 * through {@link PolicyGate.enforce}:
 *  - the resolved element (click, check, select, drag source/destination);
 *  - the focused element for page-level keys (press/type without a target);
 *  - for Enter in a form field: the field, the form's default submit button and the form itself.
 * Enter/Space on buttons and links are treated exactly like clicks.
 */

/** One element (or value) an action would activate. */
export interface PolicyCandidate {
  name: string;
  role?: string;
  /** How the candidate relates to the action target. */
  via: 'target' | 'focused' | 'submit' | 'form' | 'option' | 'destination';
}

export interface PolicyRequest {
  /** Action label used in the approval title, e.g. `Click`, `Press Enter on`, `Select`. */
  verb: string;
  /** Page URL (only the safe form is shown to the human). */
  url: string;
  candidates: PolicyCandidate[];
}

/** How a key press activates the focused element. */
export type KeyActivation = 'enter' | 'space';

/**
 * Classifies a Playwright key expression (`Enter`, `Control+Enter`, ` `, `Space`, `Shift+Space`). Returns
 * undefined for keys that do not activate elements (Tab, Escape, arrows, letters...).
 */
export function keyActivation(key: string): KeyActivation | undefined {
  const base = key === '+' ? '+' : (key.split('+').pop() ?? key);
  if (/^(enter|numpadenter|return)$/i.test(base)) return 'enter';
  if (base === ' ' || /^space$/i.test(base)) return 'space';
  return undefined;
}

/**
 * Activations implied by typed text: keyboard.type sends a newline as Enter and a space as Space
 * (which clicks a focused button).
 */
export function textActivations(text: string): KeyActivation[] {
  const out: KeyActivation[] = [];
  if (/[\r\n]/.test(text)) out.push('enter');
  if (text.includes(' ')) out.push('space');
  return out;
}

/** In-page probe result. */
export interface ProbedTarget {
  name: string;
  role: string;
  via: 'self' | 'submit' | 'form';
}

/**
 * Runs inside the page (Playwright evaluate): returns the elements a key activation would trigger.
 * `el` is the resolved target, or null to use the document's focused element (descending into open
 * shadow roots). Must stay self-contained: no imports, no closures, no named inner functions.
 */
export function probeActivation(el: Element | null, mode: 'enter' | 'space'): ProbedTarget[] {
  let e: Element | null = el;
  if (!e) {
    e = document.activeElement;
    while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
  }
  if (!e || e === document.body || e === document.documentElement) return [];
  const tag = e.tagName.toLowerCase();
  // Focus inside a child frame: that frame is probed separately.
  if (tag === 'iframe' || tag === 'frame') return [];
  const type = (e.getAttribute('type') || '').toLowerCase();
  const buttonTypes = ['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'color', 'range'];
  const isField =
    (tag === 'input' && !buttonTypes.includes(type)) ||
    tag === 'textarea' ||
    tag === 'select' ||
    (e as HTMLElement).isContentEditable === true;
  const picked: Array<{ node: Element; via: 'self' | 'submit' | 'form' }> = [];
  if (mode === 'space') {
    // Space in a text field types a space; elsewhere it activates the element (button, checkbox...).
    if (!isField) picked.push({ node: e, via: 'self' });
  } else {
    picked.push({ node: e, via: 'self' });
    if (isField && tag !== 'textarea') {
      const form =
        (e as HTMLInputElement).form || (e.closest('form') as HTMLFormElement | null) || undefined;
      if (form) {
        // Implicit submission uses the form's first enabled submit button (its "default button").
        const submitter = Array.from(form.elements).find((x) => {
          const t = x.tagName.toLowerCase();
          const ty = (x.getAttribute('type') || '').toLowerCase();
          const isSubmit =
            (t === 'button' && (ty === '' || ty === 'submit')) ||
            (t === 'input' && (ty === 'submit' || ty === 'image'));
          return isSubmit && !(x as HTMLButtonElement).disabled;
        });
        if (submitter) picked.push({ node: submitter, via: 'submit' });
        picked.push({ node: form, via: 'form' });
      }
    }
  }
  return picked.map((p) => {
    const n = p.node;
    const t = n.tagName.toLowerCase();
    const parts: string[] = [];
    const aria = n.getAttribute('aria-label');
    if (aria) parts.push(aria);
    const labelledBy = n.getAttribute('aria-labelledby');
    if (labelledBy)
      for (const id of labelledBy.split(/\s+/)) {
        const ref = id ? document.getElementById(id) : null;
        if (ref && ref.textContent) parts.push(ref.textContent);
      }
    const labels = (n as HTMLInputElement).labels;
    if (labels) for (const l of Array.from(labels)) if (l.textContent) parts.push(l.textContent);
    if (t === 'input') {
      const v = (n as HTMLInputElement).value;
      const ty = (n.getAttribute('type') || '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(ty) && v) parts.push(v);
      const alt = n.getAttribute('alt');
      if (alt) parts.push(alt);
    }
    if (t === 'form') {
      for (const a of ['name', 'id', 'action']) {
        const v = n.getAttribute(a);
        if (v) parts.push(v);
      }
    } else if (t !== 'input' && t !== 'select' && t !== 'textarea' && n.textContent) {
      parts.push(n.textContent);
    }
    const title = n.getAttribute('title');
    if (title) parts.push(title);
    if (t !== 'form') {
      const ph = n.getAttribute('placeholder');
      if (ph) parts.push(ph);
    }
    const name = parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    const role = n.getAttribute('role') || (t === 'a' ? 'link' : t === 'input' ? `input[${n.getAttribute('type') || 'text'}]` : t);
    return { name, role, via: p.via };
  });
}

export class PolicyGate {
  constructor(private readonly permissions: PermissionManager) {}

  /** The first candidate whose name matches a destructive pattern, if any. */
  match(candidates: PolicyCandidate[]): PolicyCandidate | undefined {
    return candidates.find((c) => this.permissions.isDestructiveName(c.name));
  }

  /**
   * Enforces `security.approval.destructive` for the action's effective targets. Prompts at most once
   * per call, and the title names the *effective destructive* element (e.g. a form's default submit
   * button), not the harmless element the agent addressed, so the human sees what is being approved.
   */
  async enforce(req: PolicyRequest): Promise<void> {
    const hit = this.match(req.candidates);
    if (!hit) return;
    const clip = (n: string) => (n.length > 120 ? `${n.slice(0, 117)}…` : n);
    const name = clip(hit.name);
    const where = safeUrlForLog(req.url);
    // The element the agent addressed (e.g. the text field Enter is pressed in), when it differs from the hit.
    const origin = req.candidates.find((c) => c !== hit && (c.via === 'target' || c.via === 'focused') && c.name);
    const from = origin ? ` from "${clip(origin.name)}"` : '';
    const how =
      hit.via === 'submit'
        ? ` (Enter${from} submits the form via its default button "${name}")`
        : hit.via === 'form'
          ? ` (Enter${from} submits form "${name}")`
          : hit.via === 'option'
            ? ` (option "${name}")`
            : hit.via === 'destination'
              ? ` (drop target "${name}")`
              : hit.via === 'focused'
                ? ` (focused ${hit.role ?? 'element'} "${name}")`
                : '';
    const subject = hit.via === 'target' ? `${hit.role ?? 'element'} "${name}"` : `"${name}"`;
    await this.permissions.requireApproval(
      'destructive',
      `${req.verb} "${name}"`,
      `The agent wants to ${req.verb.toLowerCase()} ${subject} on ${where}${how}. This looks like a destructive action.`,
    );
  }
}
