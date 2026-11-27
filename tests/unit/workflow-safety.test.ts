import { workflowTools, testingTools } from '../../src/tools/workflow-tools.js';
import type { ToolContext, ToolDef } from '../../src/server/tool-registry.js';
import { AssertionEngine } from '../../src/testing/assertion-engine.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserHarness } from '../../src/harness/browser-harness.js';
import { classifyAction } from '../../src/harness/action-classes.js';
import { WorkflowEngine, interpolate, interpolateActionInput } from '../../src/workflow/workflow-engine.js';
import { assertValidWorkflow, validateWorkflow } from '../../src/workflow/workflow-validator.js';
import { writeFileAtomic } from '../../src/workflow/atomic-write.js';

const dirs: string[] = [];
function setup(allowInlineSecrets = false) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-safety-'));
  dirs.push(dataDir);
  const h = new BrowserHarness({ dataDir, logLevel: 'silent', workflows: { allowInlineSecrets } });
  vi.spyOn(h.sessions, 'find').mockReturnValue({
    id: 's',
    name: 'default',
    project: 'default',
    pages: new Map(),
  } as never);
  return { h, engine: new WorkflowEngine(h) };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});
const fill = { id: 'a', action: 'fill', input: { label: 'Password', value: '${secret.PW}' } };

describe('workflow safety', () => {
  it.each(['navigate', 'assert', 'extract', 'when', 'target'])('rejects secrets in %s', (destination) => {
    const step =
      destination === 'navigate'
        ? { id: 'a', action: 'navigate', input: { url: 'http://localhost/?pw=${secret.PW}' } }
        : destination === 'assert'
          ? { id: 'a', action: 'assert', assert: { type: 'text', equals: '${secret.PW}' } }
          : destination === 'extract'
            ? { id: 'a', action: 'extract', extract: { variable: 'X', pattern: '${secret.PW}' } }
            : destination === 'when'
              ? { ...fill, when: '${secret.PW}' }
              : { ...fill, input: { label: '${secret.PW}', value: 'x' } };
    expect(validateWorkflow({ name: 'login', steps: [step] }).valid).toBe(false);
  });
  it('denies untrusted inline secrets and allows trusted SDK and saved login fills', async () => {
    vi.stubEnv('TG_SECRET_PW', 'password');
    const { h, engine } = setup();
    const spy = vi.spyOn(h.actions, 'fill').mockResolvedValue({ message: 'filled' } as never);
    const wf = assertValidWorkflow({ name: 'login', steps: [fill] });
    expect(() => engine.start(wf, { source: 'untrusted-inline' })).toThrow(/inline secrets are disabled/);
    expect((await engine.execute(wf)).status).toBe('passed');
    engine.saveDefinition(wf);
    expect((await engine.execute(engine.loadDefinition('login'))).status).toBe('passed');
    expect(spy.mock.calls[0]?.[1]).toBe('password');
  });
  it('allows configured inline login and blocks runtime alias exfiltration', async () => {
    vi.stubEnv('TG_SECRET_PW', 'password');
    const { h, engine } = setup(true);
    vi.spyOn(h.actions, 'fill').mockResolvedValue({ message: 'filled' } as never);
    expect(
      (await engine.execute({ name: 'login', steps: [fill] }, { source: 'untrusted-inline' })).status,
    ).toBe('passed');
    expect(() => interpolate('${secret.PW}', {}, new Set())).toThrow(/only allowed/);
    expect(() => interpolate('${env.TG_SECRET_PW}', {}, new Set())).toThrow(/only allowed/);
    expect(() => interpolate('${URL}', { URL: '${secret.PW}' }, new Set())).toThrow(/destination/);
  });
  it.each(['workflow_create', 'workflow_execute', 'test_execute'])(
    'blocks MCP %s inline secrets by default',
    async (name) => {
      const { h, engine } = setup();
      const context = {
        harness: h,
        workflows: engine,
        config: h.config,
        signal: new AbortController().signal,
      } as ToolContext;
      const tool = [...workflowTools, ...testingTools].find((t) => t.name === name)! as ToolDef;
      await expect(tool.handler({ definition: { name: 'login', steps: [fill] } }, context)).rejects.toThrow(
        /inline secrets are disabled/,
      );
      expect(engine.listDefinitions()).toEqual([]);
      expect(engine.listRuns()).toEqual([]);
    },
  );
  it('marks permitted MCP inline execution as untrusted, without exposing the source option', async () => {
    vi.stubEnv('TG_SECRET_PW', 'password');
    const { h, engine } = setup(true);
    vi.spyOn(h.actions, 'fill').mockResolvedValue({ message: 'filled' } as never);
    const start = vi.spyOn(engine, 'start');
    const tool = workflowTools.find((t) => t.name === 'workflow_execute')! as ToolDef;
    await tool.handler({ definition: { name: 'login', steps: [fill] } }, {
      harness: h,
      workflows: engine,
      config: h.config,
      signal: new AbortController().signal,
    } as ToolContext);
    expect(start.mock.calls[0]?.[1]?.source).toBe('untrusted-inline');
    expect(tool.input).not.toHaveProperty('source');
  });
  it('allows secrets only in fill_form field values, at validation and interpolation', async () => {
    vi.stubEnv('TG_SECRET_PW', 'password');
    const { h, engine } = setup();
    const fillForm = vi.spyOn(h.actions, 'fillForm').mockResolvedValue({ message: 'filled' } as never);
    const input = { fields: [{ label: 'Password', value: '${secret.PW}' }] };
    const workflow = { name: 'form', steps: [{ id: 'form', action: 'fill_form', input }] };
    expect(validateWorkflow(workflow).valid).toBe(true);
    expect((await engine.execute(workflow)).status).toBe('passed');
    expect(fillForm.mock.calls[0]?.[0]).toEqual([{ target: { label: 'Password' }, value: 'password' }]);
    for (const key of ['label', 'selector', 'target']) {
      const bad = {
        fields: [{ value: 'literal', [key]: key === 'target' ? { label: '${secret.PW}' } : '${secret.PW}' }],
      };
      expect(validateWorkflow({ ...workflow, steps: [{ ...workflow.steps[0], input: bad }] }).valid).toBe(
        false,
      );
      expect(() => interpolateActionInput('fill_form', bad, {}, new Set())).toThrow(/only allowed/);
    }
    expect(() =>
      interpolateActionInput(
        'fill_form',
        { fields: [{ label: '${LABEL}', value: 'x' }] },
        { LABEL: '${secret.PW}' },
        new Set(),
      ),
    ).toThrow(/destination/);
  });
  it('dispatches Submit once and attributes a later assertion failure to that assertion', async () => {
    const { h, engine } = setup();
    const click = vi.spyOn(h.actions, 'click').mockResolvedValue({ message: 'clicked' } as never);
    vi.spyOn(AssertionEngine.prototype, 'check').mockResolvedValue({
      passed: false,
      message: 'Customer Name is required',
    } as never);
    const run = await engine.execute({
      name: 'submit',
      steps: [
        {
          id: 'submit-empty',
          action: 'click',
          input: { role: 'button', name: 'Submit' },
          retry: { attempts: 3, delayMs: 0 },
        },
        { id: 'expect-ok', action: 'assert', assert: { type: 'text', contains: 'submitted successfully' } },
      ],
    });
    expect(click).toHaveBeenCalledTimes(1);
    expect(run.steps[0]?.status).toBe('passed');
    expect(run.failure?.stepId).toBe('expect-ok');
    expect(run.failure?.code).toBe('ASSERTION_FAILED');
  });
  it.each([
    [{ label: 'Field', value: 'x', submit: true }, false, 1],
    [{ label: 'Field', value: 'x' }, false, 3],
    [{ label: 'Field', value: 'x', submit: true }, true, 3],
    [{ label: 'Approve', value: 'x' }, true, 1],
  ] as const)('uses input-aware retry classes (%j)', async (input, idempotent, count) => {
    const { h, engine } = setup();
    const { TgError } = await import('../../src/shared/errors.js');
    const spy = vi
      .spyOn(h.actions, 'fill')
      .mockRejectedValue(new TgError('ACTION_TIMEOUT', 'failed', { retryable: true }));
    const run = await engine.execute({
      name: 'retry',
      steps: [{ id: 'a', action: 'fill', input, idempotent, retry: { attempts: 2, delayMs: 0 } }],
    });
    expect(spy).toHaveBeenCalledTimes(count);
    expect(run.steps[0]?.attempts).toBe(count);
  });
  it('classifies reads, typing, press, clicks and high-impact targets', () => {
    expect(classifyAction('snapshot')).toBe('read');
    for (const [action, input] of [
      ['type', { text: 'x\n' }],
      ['press', { key: 'Enter' }],
      ['press', { key: 'Space' }],
      ['click', { name: 'Menu' }],
    ] as const)
      expect(classifyAction(action, input)).toBe('non-idempotent');
    expect(classifyAction('click', { role: 'button', name: 'Delete' })).toBe('high-impact');
  });
  it('keeps valid runs when other files are torn or malformed', async () => {
    const { h, engine } = setup();
    vi.spyOn(h.actions, 'fill').mockResolvedValue({ message: 'ok' } as never);
    const run = await engine.execute({
      name: 'ok',
      steps: [{ ...fill, input: { label: 'Field', value: 'x' } }],
    });
    fs.mkdirSync(engine.runsDir, { recursive: true });
    for (const [file, data] of [
      ['torn', '{'],
      ['null', 'null'],
      ['bad', '{"startedAt":3}'],
    ])
      fs.writeFileSync(path.join(engine.runsDir, `${file}.json`), data!);
    expect(engine.listRuns(1).map((r) => r.runId)).toEqual([run.runId]);
    expect(fs.readdirSync(engine.runsDir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });
  it('preserves the old checkpoint and removes temp files on rename failure', () => {
    const { engine } = setup();
    fs.mkdirSync(engine.runsDir, { recursive: true });
    const file = path.join(engine.runsDir, 'run.json');
    writeFileAtomic(file, 'old');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed');
    });
    expect(() => writeFileAtomic(file, 'new')).toThrow('rename failed');
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
    expect(fs.readdirSync(engine.runsDir)).toEqual(['run.json']);
  });
});
