import { describe, expect, it, vi } from 'vitest';
import { fillFields } from '../../src/harness/form-filler.js';
import { resolveTarget } from '../../src/harness/target.js';
import { selectCustomOption } from '../../src/adapters/generic/combobox.js';
import { DataRedactor } from '../../src/security/data-redactor.js';
import { TgError } from '../../src/shared/errors.js';
vi.mock('../../src/harness/target.js', async (original) => ({
  ...(await original<typeof import('../../src/harness/target.js')>()),
  resolveTarget: vi.fn(),
}));
vi.mock('../../src/adapters/generic/combobox.js', () => ({ selectCustomOption: vi.fn(async () => []) }));
function setup(
  options: {
    disabled?: boolean;
    readonly?: boolean;
    value?: string;
    role?: string;
    native?: string;
    ignoreFill?: boolean;
  } = {},
) {
  const state = {
    value: options.value ?? '',
    values: [] as string[],
    checked: false,
    readonly: !!options.readonly,
    radio: false,
  };
  const el = {
    isEnabled: async () => !options.disabled,
    isEditable: async () => true,
    evaluate: async () => ({ ...state }),
    fill: vi.fn(async (value: string) => {
      if (!options.ignoreFill) state.value = value;
    }),
    check: async () => {
      state.checked = true;
    },
    uncheck: async () => {
      state.checked = false;
    },
    selectOption: vi.fn(async (values: Array<{ label: string }>) => {
      state.values = values.map((v) => v.label);
    }),
  };
  vi.mocked(resolveTarget).mockResolvedValue({
    kind: 'locator',
    locator: el,
    desc: {
      name: 'Field',
      role: options.role ?? 'textbox',
      native: options.native ?? 'input',
      editable: true,
    },
  } as never);
  const pipeline = {
    timeout: () => 100,
    redactor: new DataRedactor(),
    isSensitiveField: () => true,
    gate: { enforce: vi.fn(async () => undefined) },
  };
  const ps = {
    page: { url: () => 'http://localhost/' },
    frame: () => ({
      locator: () => ({
        evaluate: async () => ({
          requiredMissing: ['Name'],
          validationMessages: ['Do not echo secret-value'],
        }),
      }),
    }),
  };
  const record = vi.fn();
  const run = (fields: Parameters<typeof fillFields>[2], opts: Parameters<typeof fillFields>[3] = {}) =>
    fillFields(pipeline as never, ps as never, fields, opts, record);
  return { run, state, el, pipeline, record };
}
describe('batch fill results', () => {
  it.each(['disabled', 'readonly'] as const)(
    'prechecks %s and marks remaining fields not attempted',
    async (kind) => {
      const f = setup({ [kind]: true });
      const r = await f.run([
        { target: { label: 'Field' }, value: 'one' },
        { target: { label: 'Field' }, value: 'two' },
      ]);
      expect(r.fields.map((f) => f.status)).toEqual([kind, 'failed']);
      expect(r.fields[1]?.code).toBe('NOT_ATTEMPTED');
      expect(f.el.fill).not.toHaveBeenCalled();
    },
  );
  it('preserves existing data with ifEmpty', async () => {
    const f = setup({ value: 'keep' });
    expect(
      (await f.run([{ target: { label: 'Field' }, value: 'new', mode: 'ifEmpty' }])).fields[0],
    ).toMatchObject({ status: 'skipped', verified: true });
    expect(f.el.fill).not.toHaveBeenCalled();
  });
  it('verifies read-back and redacts sensitive validation messages', async () => {
    const f = setup();
    const r = await f.run([{ target: { label: 'Field' }, value: 'secret-value' }]);
    expect(r.fields[0]).toMatchObject({ status: 'filled', verified: true });
    expect(JSON.stringify(r)).not.toContain('secret-value');
    expect(f.record).toHaveBeenCalledWith(expect.anything(), 'fill', { value: 'secret-value' }, true);
  });
  it('reports a control that silently rejects its new value', async () => {
    const f = setup({ ignoreFill: true });
    expect((await f.run([{ target: { label: 'Field' }, value: 'new' }])).fields[0]).toMatchObject({
      status: 'failed',
      code: 'READBACK_MISMATCH',
    });
  });
  it('reports missing fields and continues when requested', async () => {
    const f = setup();
    vi.mocked(resolveTarget).mockRejectedValueOnce(new TgError('ELEMENT_NOT_FOUND', 'missing'));
    const r = await f.run(
      [
        { target: { label: 'missing' }, value: 'x' },
        { target: { label: 'Field' }, value: 'next' },
      ],
      { continueOnError: true },
    );
    expect(r.fields.map((f) => f.status)).toEqual(['not_found', 'filled']);
  });
  it('selects editable autocomplete instead of only filling text', async () => {
    const f = setup({ role: 'combobox' });
    vi.mocked(selectCustomOption).mockImplementationOnce(async () => {
      f.state.value = 'London';
      return ['London'];
    });
    const r = await f.run([{ target: { label: 'Field' }, value: 'London' }]);
    expect(selectCustomOption).toHaveBeenCalled();
    expect(f.el.fill).not.toHaveBeenCalled();
    expect(r.fields[0]?.verified).toBe(true);
  });
  it('verifies multiple native selections and checkbox state', async () => {
    const f = setup({ native: 'select' });
    const r = await f.run([{ target: { label: 'Field' }, value: ['One', 'Two'] }]);
    expect(r.fields[0]?.verified).toBe(true);
    const c = setup();
    expect((await c.run([{ target: { label: 'Field' }, value: true }])).fields[0]?.verified).toBe(true);
  });
  it('does not swallow policy failures', async () => {
    const f = setup();
    f.pipeline.gate.enforce.mockRejectedValueOnce(new TgError('APPROVAL_REQUIRED', 'human approval'));
    await expect(
      f.run([{ target: { label: 'Field' }, value: true }], { continueOnError: true }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
  });
  it('supports opting out of verification', async () => {
    const f = setup({ ignoreFill: true });
    const r = await f.run([{ target: { label: 'Field' }, value: 'new' }], { verify: false });
    expect(r.fields[0]).toMatchObject({ status: 'filled' });
    expect(r.fields[0]?.verified).toBeUndefined();
  });
});

describe('radio selection and adapter errors', () => {
  it('selects exactly one radio and verifies its state', async () => {
    const f = setup({ role: 'radiogroup' });
    const radio = {
      evaluate: async () => 'Urgent',
      check: vi.fn(async () => undefined),
      isChecked: async () => true,
      dispose: vi.fn(async () => undefined),
    };
    Object.assign(f.el, { getByRole: () => ({ elementHandles: async () => [radio] }) });
    const result = await f.run([{ target: { role: 'radiogroup', name: 'Priority' }, value: 'Urgent' }]);
    expect(result.fields[0]).toMatchObject({ status: 'filled', verified: true });
    expect(radio.check).toHaveBeenCalled();
    expect(radio.dispose).toHaveBeenCalled();
  });
  it('retains autocomplete ambiguity without leaking the supplied value', async () => {
    const f = setup({ role: 'combobox' });
    vi.mocked(selectCustomOption).mockRejectedValueOnce(
      new TgError('ELEMENT_AMBIGUOUS', 'secret-value matches two options'),
    );
    const result = await f.run([{ target: { label: 'Field' }, value: 'secret-value' }]);
    expect(result.fields[0]?.code).toBe('ELEMENT_AMBIGUOUS');
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });
});
