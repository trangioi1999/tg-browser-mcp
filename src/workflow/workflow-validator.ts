import { classifyAction } from '../harness/action-classes.js';
import { secretUsageErrors } from './secret-policy.js';
import { WorkflowSchema, type Workflow, type WorkflowInput } from './workflow-schema.js';
import { TgError } from '../shared/errors.js';
import { SAFE_NAME } from '../shared/util.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  workflow?: Workflow;
}

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g;

const REQUIRED_INPUT: Record<string, string[]> = {
  navigate: ['url'],
  fill: ['value'],
  type: ['text'],
  press: ['key'],
  select: ['values'],
  fill_form: ['fields'],
  dialog: ['accept'],
  switch_tab: ['pageId'],
};

const NEEDS_TARGET = new Set(['click', 'double_click', 'fill', 'select', 'check', 'uncheck', 'hover']);
const TARGET_KEYS = ['ref', 'role', 'label', 'testId', 'placeholder', 'text', 'selector'];

function collectVars(v: unknown, out: Set<string>): void {
  if (typeof v === 'string') for (const m of v.matchAll(VAR_RE)) out.add(m[1]!);
  else if (Array.isArray(v)) v.forEach((x) => collectVars(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => collectVars(x, out));
}

/** Static validation: schema, unique ids, dependency graph (no cycles/unknown), variables, inputs. */
export function validateWorkflow(
  input: unknown,
  runtimeVars: string[] = [],
  options: { allowSecrets?: boolean } = {},
): ValidationResult {
  const errors: string[] = secretUsageErrors(input, options.allowSecrets ?? true);
  const warnings: string[] = [];
  const parsed = WorkflowSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      warnings,
    };
  }
  const wf = parsed.data;
  const ids = new Set<string>();
  for (const s of wf.steps) {
    if (ids.has(s.id)) errors.push(`Duplicate step id "${s.id}"`);
    ids.add(s.id);
    if (!SAFE_NAME.test(s.session)) errors.push(`Step ${s.id}: invalid session name "${s.session}"`);
  }
  const index = new Map(wf.steps.map((s, i) => [s.id, i]));
  const defined = new Set<string>([...Object.keys(wf.variables), ...runtimeVars]);
  for (const [i, s] of wf.steps.entries()) {
    for (const d of s.dependsOn) {
      const j = index.get(d);
      if (j === undefined) errors.push(`Step ${s.id}: dependsOn unknown step "${d}"`);
      else if (j >= i) errors.push(`Step ${s.id}: dependsOn "${d}" must refer to an earlier step`);
    }
    for (const k of REQUIRED_INPUT[s.action] ?? []) {
      if (s.input[k] === undefined) errors.push(`Step ${s.id} (${s.action}): input.${k} is required`);
    }
    if (NEEDS_TARGET.has(s.action) && !TARGET_KEYS.some((k) => s.input[k] !== undefined)) {
      errors.push(
        `Step ${s.id} (${s.action}): needs a target (role+name, label, testId, placeholder, text or selector)`,
      );
    }
    if (s.action === 'assert' && !s.assert) errors.push(`Step ${s.id}: assert action requires "assert"`);
    if (s.action === 'extract' && !s.extract) errors.push(`Step ${s.id}: extract action requires "extract"`);
    if (s.input.ref !== undefined)
      warnings.push(`Step ${s.id}: snapshot refs are not stable across runs; prefer role/label/testId`);
    const actionClass = classifyAction(s.action, s.input);
    if (
      s.retry &&
      s.retry.attempts > 0 &&
      (actionClass === 'high-impact' || (actionClass === 'non-idempotent' && !s.idempotent))
    ) {
      warnings.push(
        `Step ${s.id}: retries are ignored for non-idempotent action "${s.action}" unless idempotent=true`,
      );
    }
    const used = new Set<string>();
    collectVars(s.input, used);
    collectVars(s.when, used);
    collectVars(s.assert, used);
    for (const v of used) {
      if (v.startsWith('secret.') || v.startsWith('env.')) continue;
      if (!defined.has(v))
        warnings.push(`Step ${s.id}: variable \${${v}} is not defined before use (provide it at run time)`);
    }
    if (s.extract) defined.add(s.extract.variable);
    if (s.assert?.matches) {
      try {
        new RegExp(s.assert.matches);
      } catch {
        errors.push(`Step ${s.id}: invalid regex in assert.matches`);
      }
    }
    if (s.extract?.pattern) {
      try {
        new RegExp(s.extract.pattern);
      } catch {
        errors.push(`Step ${s.id}: invalid regex in extract.pattern`);
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings, ...(errors.length === 0 ? { workflow: wf } : {}) };
}

export function assertValidWorkflow(
  input: WorkflowInput | unknown,
  runtimeVars: string[] = [],
  options: { allowSecrets?: boolean } = {},
): Workflow {
  const r = validateWorkflow(input, runtimeVars, options);
  if (!r.valid || !r.workflow)
    throw new TgError('WORKFLOW_INVALID', `Invalid workflow: ${r.errors.join('; ')}`, {
      context: { errors: r.errors },
    });
  return r.workflow;
}
