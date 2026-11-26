import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureServer } from '../fixtures/app/server.mjs';
import { testHarness, tmpDir } from '../helpers.js';
import { WorkflowEngine } from '../../src/workflow/workflow-engine.js';
import { WorkflowRecorder } from '../../src/workflow/workflow-recorder.js';
import { generatePlaywrightTest } from '../../src/testing/test-generator.js';
import { markdownReport, junitReport } from '../../src/testing/report-generator.js';
import { assertValidWorkflow } from '../../src/workflow/workflow-validator.js';
import type { BrowserHarness } from '../../src/harness/browser-harness.js';

const definition = JSON.parse(fs.readFileSync(path.resolve('examples/workflows/maker-checker.json'), 'utf8'));
let app: ReturnType<typeof createFixtureServer>;
let base: string;
let h: BrowserHarness;
let engine: WorkflowEngine;

beforeAll(async () => {
  app = createFixtureServer();
  base = await app.listen();
  process.env.TG_SECRET_MAKER_PASSWORD = 'maker123';
  process.env.TG_SECRET_CHECKER_PASSWORD = 'checker123';
  h = testHarness();
  engine = new WorkflowEngine(h);
});
afterAll(async () => {
  await h?.close();
  await app?.close();
});

describe('maker-checker business workflow (E2E)', () => {
  it('runs the complete multi-user workflow with variables, extraction and assertions', async () => {
    const events: string[] = [];
    h.events.on('workflow.completed', () => events.push('completed'));
    const run = await engine.execute(definition, { variables: { BASE_URL: base } });
    if (run.status !== 'passed') console.error(JSON.stringify(run, null, 1));
    expect(run.status).toBe('passed');
    expect(run.steps.every((s) => s.status === 'passed')).toBe(true);
    expect(run.variables.REQUEST_ID).toMatch(/^REQ-\d+$/);
    // Secrets never appear in the run record or step messages.
    const serialized = JSON.stringify(run);
    expect(serialized).not.toContain('maker123');
    expect(serialized).not.toContain('checker123');
    expect(app.requests.get(run.variables.REQUEST_ID!)?.status).toBe('Approved');
    expect(events).toEqual(['completed']);
    // Checkpoint persisted.
    expect(engine.getRun(run.runId).status).toBe('passed');
    const md = markdownReport([run]);
    expect(md).toContain('**1/1 runs passed**');
    expect(junitReport([run])).toContain('<testsuite name="Maker Checker Workflow"');
  });

  it('reports failures with diagnostics and does not retry non-idempotent submissions', async () => {
    // Establish authentication independently of the preceding workflow test.
    const maker = h.sessions.find('maker') ? h.session('maker') : await h.createSession({ name: 'maker' });
    await maker.navigate(`${base}/login`);
    await maker.fill({ label: 'Username' }, 'maker');
    await maker.fill({ label: 'Password' }, 'maker123');
    await maker.click({ role: 'button', name: 'Sign in' });
    const wf = {
      name: 'Failing',
      steps: [
        { id: 'open', session: 'maker', action: 'navigate', input: { url: `${base}/request/create` } },
        {
          id: 'submit-empty',
          session: 'maker',
          action: 'click',
          input: { role: 'button', name: 'Submit' },
          retry: { attempts: 3, delayMs: 10 },
        },
        {
          id: 'expect-ok',
          session: 'maker',
          action: 'assert',
          assert: {
            type: 'text',
            target: { role: 'alert' },
            contains: 'submitted successfully',
            timeout: 500,
          },
          retry: { attempts: 1, delayMs: 10 },
        },
        { id: 'never', session: 'maker', action: 'navigate', input: { url: `${base}/` } },
      ],
    };
    const run = await engine.execute(wf);
    expect(run.status).toBe('failed');
    expect(run.steps.find((s) => s.id === 'submit-empty')!.attempts).toBe(1);
    expect(run.failure?.stepId).toBe('expect-ok');
    expect(run.failure?.code).toBe('ASSERTION_FAILED');
    expect(run.failure?.message).toContain('Customer Name is required');
    expect(fs.existsSync(run.failure!.screenshot!)).toBe(true);
    expect(run.steps.find((s) => s.id === 'never')!.status).toBe('pending');
  });

  it('supports conditions, dependency skipping and cancellation', async () => {
    const wf = {
      name: 'Conditional',
      variables: { MODE: 'fast' },
      steps: [
        { id: 'a', session: 'c1', action: 'navigate', input: { url: `${base}/dynamic` } },
        {
          id: 'b',
          session: 'c1',
          action: 'click',
          input: { role: 'button', name: 'Increment' },
          when: "${MODE} == 'slow'",
        },
        {
          id: 'c',
          session: 'c1',
          action: 'assert',
          assert: { type: 'text', target: { role: 'status' }, equals: 'Count: 0' },
        },
        { id: 'd', session: 'c1', action: 'wait', input: { timeMs: 20000 } },
      ],
    };
    const { runId, promise } = engine.start(wf);
    await new Promise((r) => setTimeout(r, 4000));
    expect(engine.cancel(runId)).toBe(true);
    const run = await promise;
    expect(run.steps.find((s) => s.id === 'b')!.status).toBe('skipped');
    expect(run.steps.find((s) => s.id === 'c')!.status).toBe('passed');
    expect(run.status).toBe('cancelled');
  });

  it('records actions into a replayable workflow with semantic locators and secret placeholders', async () => {
    const recorder = new WorkflowRecorder(h.actions);
    await h.createSession({ name: 'rec' });
    const s = h.session('rec');
    recorder.start('Recorded login', ['rec']);
    await s.navigate(`${base}/login`);
    const snap = await s.snapshot();
    const userRef = /textbox "Username" \[required\] \[ref=(e\d+)\]/.exec(snap.text)![1]!;
    await s.fill({ ref: userRef }, 'maker');
    await s.fill({ label: 'Password' }, 'maker123');
    await s.click({ role: 'button', name: 'Sign in' });
    const wf = recorder.stop();
    expect(wf.steps.map((x) => x.action)).toEqual(['navigate', 'fill', 'fill', 'click']);
    expect(wf.steps[1]!.input).toMatchObject({ role: 'textbox', name: 'Username', value: 'maker' });
    expect(JSON.stringify(wf)).not.toContain('maker123');
    expect(wf.steps[2]!.input!.value).toBe('${secret.PASSWORD}');
    // Replay in a fresh session.
    process.env.TG_SECRET_PASSWORD = 'maker123';
    const replay = await engine.execute({ ...wf, steps: wf.steps.map((x) => ({ ...x, session: 'replay' })) });
    expect(replay.status).toBe('passed');
  });

  it('generates a Playwright test that passes when run with @playwright/test', async () => {
    const wf = assertValidWorkflow(definition);
    const code = generatePlaywrightTest(wf);
    const dir = tmpDir('tgb-gen-');
    fs.writeFileSync(path.join(dir, 'maker-checker.spec.ts'), code);
    fs.writeFileSync(
      path.join(dir, 'playwright.config.ts'),
      `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: '.', reporter: 'line', use: { channel: 'chrome', headless: true }, timeout: 60000 });\n`,
    );
    fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'dir');
    // Async on purpose: the fixture server runs in this process and must keep serving.
    const { stdout: out } = await promisify(execFile)(
      process.execPath,
      [
        path.resolve('node_modules/@playwright/test/cli.js'),
        'test',
        '--config',
        path.join(dir, 'playwright.config.ts'),
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          BASE_URL: base,
          TG_SECRET_MAKER_PASSWORD: 'maker123',
          TG_SECRET_CHECKER_PASSWORD: 'checker123',
        },
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    expect(out).toMatch(/1 passed/);
  }, 150_000);
});
