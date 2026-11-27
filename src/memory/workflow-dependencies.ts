import type { Workflow } from '../workflow/workflow-schema.js';
import { routeKey } from './page-identity.js';
import { cleanText, memoryLabel } from './sanitize.js';

/** A derived dependency of one workflow step (doc 10 §3). Never contains input values. */
export interface WorkflowDependency {
  stepId: string;
  session: string;
  action: string;
  kind: 'page' | 'element' | 'fills_form';
  /** Route of the last `navigate` of the step's session (static approximation; Phase 3 refines it). */
  routeKey?: string;
  /** Locator-derived key of the step target (`tid:x`, `role:button|"Save"`, `label:"Name"`). */
  targetKey?: string;
}

/** Target key from a workflow target (flattened into the step input). Refs are runtime-only: ignored. */
export function targetKey(t: Record<string, unknown>): string | undefined {
  const s = (k: string) => (typeof t[k] === 'string' && t[k] ? memoryLabel(t[k], 120) : undefined);
  const within =
    t.within && typeof t.within === 'object' ? targetKey(t.within as Record<string, unknown>) : '';
  const scope = within ? ` within ${within}` : '';
  let key: string | undefined;
  if (s('testId')) key = `tid:${s('testId')}`;
  else if (s('role'))
    key = `role:${s('role')}${s('name') !== undefined ? `|${JSON.stringify(s('name'))}` : ''}`;
  else if (s('label')) key = `label:${JSON.stringify(s('label'))}`;
  else if (s('placeholder')) key = `placeholder:${JSON.stringify(s('placeholder'))}`;
  else if (s('text')) key = `text:${JSON.stringify(s('text'))}`;
  else if (typeof t.selector === 'string' && t.selector) key = `css:${cleanText(t.selector, 120)}`;
  return key ? `${key}${scope}`.slice(0, 300) : undefined;
}

/** Derives page / element / form dependencies from a workflow definition. */
export function workflowDependencies(wf: Workflow): WorkflowDependency[] {
  const route = new Map<string, string>();
  const out: WorkflowDependency[] = [];
  for (const step of wf.steps) {
    const session = step.session ?? 'default';
    const input = step.input ?? {};
    if (step.action === 'navigate' && typeof input.url === 'string') route.set(session, routeKey(input.url));
    const base = { stepId: step.id, session, action: step.action };
    const r = route.get(session);
    if (r) out.push({ ...base, kind: 'page', routeKey: r });
    const target = targetKey(input);
    if (target) out.push({ ...base, kind: 'element', ...(r ? { routeKey: r } : {}), targetKey: target });
    if (step.action === 'fill_form') out.push({ ...base, kind: 'fills_form', ...(r ? { routeKey: r } : {}) });
  }
  return out;
}
