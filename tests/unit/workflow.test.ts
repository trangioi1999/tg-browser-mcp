import { describe, expect, it } from 'vitest';
import { validateWorkflow } from '../../src/workflow/workflow-validator.js';
import { evalCondition, interpolate } from '../../src/workflow/workflow-engine.js';
import { generatePlaywrightTest } from '../../src/testing/test-generator.js';
import { assertValidWorkflow } from '../../src/workflow/workflow-validator.js';
import ts from 'typescript';

const base = {
  name: 'Maker Checker',
  variables: { BASE_URL: 'http://localhost:4321' },
  steps: [
    { id: 's1', session: 'maker', action: 'navigate', input: { url: '${BASE_URL}/login' } },
    { id: 's2', session: 'maker', action: 'fill', input: { label: 'Customer Name', value: 'Test' } },
    { id: 's3', session: 'maker', action: 'click', input: { role: 'button', name: 'Submit' } },
    {
      id: 's4',
      session: 'maker',
      action: 'extract',
      extract: { variable: 'REQ', from: 'text', target: { testId: 'request-id' } },
    },
    {
      id: 's5',
      session: 'checker',
      action: 'navigate',
      input: { url: '${BASE_URL}/approval?q=${REQ}' },
      dependsOn: ['s4'],
    },
    {
      id: 's6',
      session: 'checker',
      action: 'assert',
      assert: { type: 'text', target: { testId: 'status-${REQ}' }, equals: 'Approved' },
    },
  ],
};

describe('workflow validation', () => {
  it('accepts a valid workflow and tracks extracted variables', () => {
    const r = validateWorkflow(base);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.warnings).toEqual([]);
  });
  it('detects duplicate ids, unknown/forward deps, missing inputs and targets', () => {
    const r = validateWorkflow({
      name: 'bad',
      steps: [
        { id: 'a', action: 'navigate', input: {} },
        { id: 'a', action: 'click', input: {} },
        { id: 'b', action: 'fill', input: { label: 'x' }, dependsOn: ['zzz', 'c'] },
        { id: 'c', action: 'assert' },
      ],
    });
    expect(r.valid).toBe(false);
    const all = r.errors.join('\n');
    expect(all).toMatch(/Duplicate step id "a"/);
    expect(all).toMatch(/input\.url is required/);
    expect(all).toMatch(/needs a target/);
    expect(all).toMatch(/unknown step "zzz"/);
    expect(all).toMatch(/must refer to an earlier step/);
    expect(all).toMatch(/input\.value is required/);
    expect(all).toMatch(/requires "assert"/);
  });
  it('warns about undefined variables, refs and ignored retries', () => {
    const r = validateWorkflow({
      name: 'w',
      steps: [{ id: 'a', action: 'click', input: { ref: 'e1', text: '${X}' }, retry: { attempts: 2 } }],
    });
    expect(r.valid).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/\$\{X\}/);
    expect(r.warnings.join('\n')).toMatch(/refs are not stable/);
    expect(r.warnings.join('\n')).toMatch(/retries are ignored/);
  });
  it('rejects invalid session names (path traversal)', () => {
    const r = validateWorkflow({
      name: 'w',
      steps: [{ id: 'a', session: '../etc', action: 'navigate', input: { url: 'x' } }],
    });
    expect(r.valid).toBe(false);
  });
});

describe('interpolation and conditions', () => {
  it('interpolates variables and secrets, tracking secret values', () => {
    process.env.TG_SECRET_PW = 's3cret';
    const secrets = new Set<string>();
    expect(interpolate({ a: '${X}/y', b: ['${secret.pw}'] }, { X: '1' }, secrets)).toEqual({
      a: '1/y',
      b: ['s3cret'],
    });
    expect(secrets.has('s3cret')).toBe(true);
    expect(() => interpolate('${MISSING}', {}, secrets)).toThrow(/not defined/);
    expect(() => interpolate('${secret.nope}', {}, secrets)).toThrow(/TG_SECRET_NOPE/);
  });
  it('evaluates the safe condition language', () => {
    const v = { A: 'x', E: '', F: 'false' };
    expect(evalCondition('${A}', v)).toBe(true);
    expect(evalCondition('${E}', v)).toBe(false);
    expect(evalCondition('${F}', v)).toBe(false);
    expect(evalCondition('!${E}', v)).toBe(true);
    expect(evalCondition("${A} == 'x'", v)).toBe(true);
    expect(evalCondition("${A} != 'x'", v)).toBe(false);
    expect(evalCondition('process.exit(1)', v)).toBe(true); // treated as a literal string, never executed
  });
});

describe('test generation', () => {
  it('generates syntactically valid Playwright TypeScript with semantic locators', () => {
    const wf = assertValidWorkflow({
      ...base,
      steps: [
        ...base.steps,
        {
          id: 's7',
          session: 'maker',
          action: 'fill',
          input: { label: 'Password', value: '${secret.MAKER_PASSWORD}' },
        },
        {
          id: 's8',
          session: 'maker',
          action: 'select',
          input: { label: 'Type', values: ['Loan'] },
          when: "${REQ} != ''",
        },
        { id: 's9', session: 'maker', action: 'assert', assert: { type: 'url', contains: '/request' } },
      ],
    });
    const code = generatePlaywrightTest(wf);
    expect(code).toContain("getByRole('button', { name: 'Submit', exact: true })");
    expect(code).toContain("getByLabel('Customer Name')");
    expect(code).toContain('getByTestId(`status-${vars.REQ}`)');
    expect(code).toContain("secret('MAKER_PASSWORD')");
    expect(code).toContain('makerContext = await browser.newContext()');
    expect(code).toContain('checkerContext = await browser.newContext()');
    expect(code).not.toContain('s3cret');
    const out = ts.transpileModule(code, {
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    expect(out.diagnostics ?? []).toEqual([]);
  });
});

describe('workflow file names', () => {
  it('keeps Vietnamese names readable', async () => {
    const { BrowserHarness } = await import('../../src/harness/browser-harness.js');
    const { WorkflowEngine } = await import('../../src/workflow/workflow-engine.js');
    const { WorkflowSchema } = await import('../../src/workflow/workflow-schema.js');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-slug-'));
    const engine = new WorkflowEngine(new BrowserHarness({ dataDir, logLevel: 'silent' }));
    const wf = WorkflowSchema.parse({
      name: 'Đăng nhập và tạo yêu cầu',
      steps: [{ id: 'a', action: 'navigate', input: { url: 'http://127.0.0.1/' } }],
    });
    expect(path.basename(engine.saveDefinition(wf))).toBe('dang-nhap-va-tao-yeu-cau.json');
    expect(engine.loadDefinition('Đăng nhập và tạo yêu cầu').name).toBe(wf.name);
  });
});
