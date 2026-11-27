import type { ElementHandle, Frame, Locator } from 'playwright';
import type { PageState } from '../session/session.js';
import { toTgError, TgError } from '../shared/errors.js';
import { selectCustomOption } from '../adapters/generic/combobox.js';
import { resolveTarget, suggestLocator, type Target, type Resolved } from './target.js';
import type { ActionPipeline } from './action-pipeline.js';

export interface FillField {
  target: Target;
  value: string | boolean | string[];
  mode?: 'replace' | 'ifEmpty';
}
export interface FillOptions {
  continueOnError?: boolean;
  verify?: boolean;
  within?: Target;
}
export interface FieldResult {
  index: number;
  name?: string;
  status: 'filled' | 'skipped' | 'failed' | 'not_found' | 'disabled' | 'readonly';
  code?: string;
  reason?: string;
  verified?: boolean;
}
export interface FillReport {
  fields: FieldResult[];
  requiredMissing: string[];
  validationMessages: string[];
}

/** Runs inside the page; returns only the control state needed for deterministic comparisons. */
function readControl(n: Element) {
  const input = n as HTMLInputElement;
  const select = n as HTMLSelectElement;
  const role = n.getAttribute('role');
  const selected = n.querySelectorAll('[aria-selected="true"]');
  return {
    value:
      'value' in n ? String(input.value) : (n.getAttribute('aria-valuetext') ?? (n.textContent ?? '').trim()),
    values:
      n.tagName === 'SELECT'
        ? Array.from(select.selectedOptions).flatMap((o) => [o.value, o.label])
        : Array.from(selected).map((o) => (o.textContent ?? '').trim()),
    checked: input.checked || n.getAttribute('aria-checked') === 'true',
    readonly: input.readOnly || n.getAttribute('aria-readonly') === 'true',
    radio: role === 'radiogroup' ? !!n.querySelector(':checked,[aria-checked="true"]') : false,
  };
}

export async function fillFields(
  pipeline: ActionPipeline,
  ps: PageState,
  fields: FillField[],
  opts: FillOptions,
  record: (r: Resolved, action: string, input: Record<string, unknown>, sensitive: boolean) => void,
): Promise<FillReport> {
  const results: FieldResult[] = [];
  let scoped = ps;
  let scopeRoot: Locator | undefined;
  let scopeFrame: Frame | undefined;
  const secretValues: string[] = [];
  if (opts.within) {
    let container = await resolveTarget(ps, opts.within, pipeline.timeout(), 'read');
    // Reconstitute a locator only if it resolves uniquely; never silently broaden a ref scope.
    if (container.kind === 'handle') {
      const original = container.handle;
      container = await resolveTarget(ps, suggestLocator(container.desc).target, pipeline.timeout(), 'read');
      const h = container.kind === 'handle' ? container.handle : await container.locator.elementHandle();
      try {
        if (!h || !(await original.evaluate((root, other) => root === other, h)))
          throw new TgError('ELEMENT_AMBIGUOUS', 'Cannot uniquely scope this form ref');
      } finally {
        if (container.kind === 'locator') await h?.dispose();
      }
    }
    if (container.kind !== 'locator') throw new TgError('INVALID_ARGUMENT', 'Use a semantic form scope');
    const locator = container.locator;
    scopeRoot = locator;
    scopeFrame = container.frame;
    const frame = new Proxy(container.frame, {
      get(target, key) {
        const source = [
          'locator',
          'getByRole',
          'getByLabel',
          'getByTestId',
          'getByPlaceholder',
          'getByText',
        ].includes(String(key))
          ? locator
          : target;
        const value: unknown = Reflect.get(source, key);
        return typeof value === 'function' ? value.bind(source) : value;
      },
    });
    scoped = Object.assign(Object.create(ps) as PageState, { frame: () => frame });
  }
  let stopped = false;
  for (const [index, field] of fields.entries()) {
    const result: FieldResult = { index, status: 'failed' };
    results.push(result);
    if (stopped) {
      result.code = 'NOT_ATTEMPTED';
      continue;
    }
    const ownedHandles: ElementHandle<Element>[] = [];
    try {
      const r = await resolveTarget(scoped, field.target, pipeline.timeout(), 'input');
      if (scopeFrame) r.frame = scopeFrame;
      const el = r.kind === 'handle' ? r.handle : r.locator;
      if (scopeRoot && r.kind === 'handle') {
        if (!(await scopeRoot.evaluate((root, child) => root.contains(child), r.handle)))
          throw new TgError('ELEMENT_NOT_FOUND', 'Field is outside the requested form');
      }
      const sensitive = pipeline.isSensitiveField(r.desc);
      if (sensitive && typeof field.value === 'string' && field.value) secretValues.push(field.value);
      result.name = pipeline.redactor.text(r.desc.name || r.desc.label || `Field ${index + 1}`);
      if (!(await el.isEnabled())) {
        result.status = 'disabled';
        result.code = 'FIELD_DISABLED';
      } else {
        const before = await (r.kind === 'handle'
          ? r.handle.evaluate(readControl)
          : r.locator.evaluate(readControl));
        if (sensitive && before.value) secretValues.push(before.value);
        if (
          before.readonly ||
          (typeof field.value === 'string' &&
            !['select'].includes(r.desc.native ?? '') &&
            !['combobox', 'radiogroup'].includes(r.desc.role) &&
            !(await el.isEditable()))
        ) {
          result.status = 'readonly';
          result.code = 'FIELD_READONLY';
        } else if (
          field.mode === 'ifEmpty' &&
          (typeof field.value === 'boolean'
            ? before.checked
            : r.desc.role === 'radiogroup'
              ? before.radio
              : !!before.value)
        ) {
          result.status = 'skipped';
          result.reason = 'ifEmpty';
          result.verified = true;
        } else {
          let radio: ElementHandle<Element> | undefined;
          if (typeof field.value === 'boolean') {
            if (!field.value && (r.desc.inputType === 'radio' || r.desc.role === 'radio'))
              throw new TgError('INVALID_ARGUMENT', 'A radio cannot be unchecked; select another option');
            await pipeline.gate.enforce({
              verb: 'Check',
              url: ps.page.url(),
              candidates: [{ name: r.desc.name, role: r.desc.role, via: 'target' }],
            });
            if (field.value) await el.check({ timeout: pipeline.timeout() });
            else await el.uncheck({ timeout: pipeline.timeout() });
            record(r, field.value ? 'check' : 'uncheck', {}, sensitive);
          } else if (r.desc.role === 'radiogroup') {
            if (Array.isArray(field.value))
              throw new TgError('INVALID_ARGUMENT', 'Radio groups require one option name');
            const candidates: ElementHandle<Element>[] =
              r.kind === 'locator'
                ? ((await r.locator
                    .getByRole('radio', { name: field.value, exact: true })
                    .elementHandles()) as ElementHandle<Element>[])
                : ((await r.handle.$$('input[type="radio"],[role="radio"]')) as ElementHandle<Element>[]);
            ownedHandles.push(...candidates);
            const matches: ElementHandle<Element>[] = [];
            for (const candidate of candidates) {
              const name = await candidate.evaluate(
                (n) =>
                  n.getAttribute('aria-label') ||
                  Array.from((n as HTMLInputElement).labels ?? [])
                    .map((l) => l.textContent ?? '')
                    .join(' ')
                    .trim() ||
                  (n.textContent ?? '').trim(),
              );
              if (r.kind === 'locator' || name === field.value) matches.push(candidate);
            }
            if (matches.length !== 1)
              throw new TgError(
                matches.length ? 'ELEMENT_AMBIGUOUS' : 'ELEMENT_NOT_FOUND',
                'Radio option must match exactly once',
              );
            radio = matches[0]!;
            await pipeline.gate.enforce({
              verb: 'Select',
              url: ps.page.url(),
              candidates: [
                { name: r.desc.name, via: 'target' },
                { name: field.value, via: 'option' },
              ],
            });
            await radio.check({ timeout: pipeline.timeout() });
            record(r, 'select', { values: [field.value] }, sensitive);
          } else if (r.desc.native === 'select' || r.desc.role === 'combobox') {
            const values = Array.isArray(field.value) ? field.value : [field.value];
            await pipeline.gate.enforce({
              verb: 'Select',
              url: ps.page.url(),
              candidates: [
                { name: r.desc.name, via: 'target' },
                ...values.map((name) => ({ name, via: 'option' as const })),
              ],
            });
            if (r.desc.native === 'select') {
              await el
                .selectOption(
                  values.map((label) => ({ label })),
                  { timeout: pipeline.timeout() },
                )
                .catch(() => el.selectOption(values, { timeout: pipeline.timeout() }));
            } else await selectCustomOption(ps, r, values, pipeline.timeout());
            record(r, 'select', { values }, sensitive);
          } else {
            if (Array.isArray(field.value))
              throw new TgError('INVALID_ARGUMENT', 'Text fields require a string');
            await el.fill(field.value, { timeout: pipeline.timeout() });
            record(r, 'fill', { value: field.value }, sensitive);
          }
          result.status = 'filled';
          if (opts.verify !== false) {
            const after = await (r.kind === 'handle'
              ? r.handle.evaluate(readControl)
              : r.locator.evaluate(readControl));
            const values = Array.isArray(field.value) ? field.value : [field.value];
            result.verified = radio
              ? await radio.isChecked()
              : typeof field.value === 'boolean'
                ? after.checked === field.value
                : r.desc.native === 'select'
                  ? values.every((v) => after.values.includes(String(v)))
                  : values.every((v) => after.value === v || after.values.includes(String(v)));
            if (!result.verified) {
              result.status = 'failed';
              result.code = 'READBACK_MISMATCH';
            }
          }
        }
      }
    } catch (e) {
      const error = toTgError(e);
      // Approval failures remain hard failures; a batch never swallows a policy decision.
      if (['APPROVAL_REQUIRED', 'PERMISSION_DENIED'].includes(error.code)) {
        error.context.fields = results;
        throw error;
      }
      result.status = error.code === 'ELEMENT_NOT_FOUND' ? 'not_found' : 'failed';
      result.code = error.code;
    } finally {
      await Promise.all(ownedHandles.map((h) => h.dispose().catch(() => undefined)));
    }
    if (!['filled', 'skipped'].includes(result.status) && !opts.continueOnError) stopped = true;
  }
  const report = await (scopeRoot ?? ps.frame().locator('body'))
    .evaluate((root) => ({
      requiredMissing: Array.from(
        root.querySelectorAll<HTMLInputElement>(
          'input[required],textarea[required],select[required],[aria-required="true"]',
        ),
      )
        .filter((n) =>
          n.type === 'checkbox'
            ? !n.checked
            : n.type === 'radio'
              ? !Array.from(root.querySelectorAll<HTMLInputElement>('input[type=radio]')).some(
                  (r) => r.name === n.name && r.checked,
                )
              : !n.value,
        )
        .map(
          (n) =>
            n.getAttribute('aria-label') ||
            Array.from(n.labels ?? [])
              .map((l) => l.textContent ?? '')
              .join(' ') ||
            n.name ||
            'Required field',
        ),
      validationMessages: Array.from(root.querySelectorAll('[aria-invalid="true"], :user-invalid')).flatMap(
        (n) =>
          `${n.getAttribute('aria-errormessage') ?? ''} ${n.getAttribute('aria-describedby') ?? ''}`
            .split(/\s+/)
            .filter(Boolean)
            .map((id) => root.ownerDocument.getElementById(id)?.textContent ?? ''),
      ),
    }))
    .catch(() => ({ requiredMissing: [], validationMessages: [] }));
  const redact = (value: string) =>
    secretValues.reduce(
      (text, secret) => text.split(secret).join('[REDACTED]'),
      pipeline.redactor.text(value),
    );
  return {
    fields: results,
    requiredMissing: report.requiredMissing.map(redact),
    validationMessages: report.validationMessages.map(redact),
  };
}
