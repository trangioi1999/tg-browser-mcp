import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureServer } from '../fixtures/app/server.mjs';
import { testHarness } from '../helpers.js';
import { WorkflowRecorder } from '../../src/workflow/workflow-recorder.js';
import { WorkflowEngine } from '../../src/workflow/workflow-engine.js';
import { captureSnapshot } from '../../src/snapshot/snapshot-engine.js';

const app = createFixtureServer();
const h = testHarness();
let base: string;
beforeAll(async () => {
  base = await app.listen();
});
afterAll(async () => {
  await h.close();
  await app.close();
});

describe('TGB-017 scoped targets and leases', () => {
  it('rejects duplicate names and scopes buttons, fields and refs to unique containers', async () => {
    const s = await h.createSession({ name: 'duplicates' });
    await s.navigate(`${base}/duplicates`);
    await expect(s.click({ role: 'button', name: 'Save' })).rejects.toMatchObject({
      code: 'ELEMENT_AMBIGUOUS',
    });
    await expect(s.fill({ label: 'Name' }, 'wrong')).rejects.toMatchObject({ code: 'ELEMENT_AMBIGUOUS' });
    for (const within of [
      { role: 'form', name: 'Second' },
      { testId: 'second' },
      { label: 'Second' },
      { selector: 'form[data-testid="second"]' },
    ]) {
      await s.click({ role: 'button', name: 'Save', within });
    }
    await h.actions.fillForm(
      [{ target: { label: 'Name', within: { role: 'form', name: 'Second' } }, value: 'right' }],
      { session: 'duplicates' },
    );
    expect(await s.raw.page().page.getByTestId('second').getByLabel('Name').inputValue()).toBe('right');
    expect(await s.raw.page().page.getByTestId('first').getByLabel('Name').inputValue()).toBe('');
    const snap = await s.snapshot();
    const forms = snap.snapshot.nodes
      .flatMap((n) => (n.role === 'form' ? [n] : (n.children ?? [])))
      .filter((n) => n.role === 'form');
    const second = forms.find((n) => n.name === 'Second')!;
    await s.click({ role: 'button', name: 'Save', within: { ref: second.ref! } });
    const buttonRef = second.children!.find((n) => n.role === 'button')!.ref!;
    await s.click({ ref: buttonRef });
    await expect(s.click({ ref: buttonRef, within: { testId: 'first' } })).rejects.toMatchObject({
      code: 'ELEMENT_NOT_FOUND',
    });
    const buttons = await s.raw
      .page()
      .page.getByTestId('second')
      .getByRole('button')
      .getAttribute('data-clicked');
    expect(buttons).toBe('yes');
    await expect(s.click({ role: 'button', name: 'Save', within: { role: 'form' } })).rejects.toMatchObject({
      code: 'ELEMENT_AMBIGUOUS',
    });
  });

  it('records duplicate names with persistent container locators and replays them', async () => {
    const recorder = new WorkflowRecorder(h.actions);
    recorder.start('scoped');
    await h.session('duplicates').click({ role: 'button', name: 'Save', within: { testId: 'second' } });
    const wf = recorder.stop();
    expect(wf.steps[0]!.input!.within).toEqual({ testId: 'second' });
    const run = await new WorkflowEngine(h).start(wf).promise;
    expect(run.status).toBe('passed');
  });

  it('marks scoped, filtered, node-limited, depth-limited and paginated snapshots incomplete', async () => {
    const s = h.session('duplicates');
    expect((await s.snapshot()).snapshot.complete).toBe(true);
    expect(
      (await h.actions.snapshot({ interactiveOnly: true }, { session: 'duplicates' })).snapshot.complete,
    ).toBe(false);
    const ps = s.raw.page();
    const opts = { maxDepth: 20, maxTextLength: 200, includeText: true, sensitiveKeys: [], maxChars: 10000 };
    expect((await captureSnapshot(ps.page, ps.refs, { ...opts, maxNodes: 1 })).complete).toBe(false);
    expect((await captureSnapshot(ps.page, ps.refs, { ...opts, maxDepth: 0 })).complete).toBe(false);
    const snap = await s.snapshot();
    const ref = /form "Second" \[ref=(e\d+)\]/.exec(snap.text)![1]!;
    expect((await h.actions.snapshot({ scope: ref }, { session: 'duplicates' })).snapshot.complete).toBe(
      false,
    );
  });

  it('refuses overlapping runs sharing a session, permits independent sessions and releases leases', async () => {
    const engine = new WorkflowEngine(h);
    const workflow = (session: string) => ({
      name: 'lease',
      steps: [{ id: 'wait', session, action: 'wait', input: { timeMs: 300 } }],
    });
    const first = engine.start(workflow('leased'));
    const conflict = await engine.start(workflow('leased')).promise;
    expect(conflict.failure?.code).toBe('SESSION_BUSY');
    const independent = engine.start(workflow('independent'));
    expect((await first.promise).status).toBe('passed');
    expect((await independent.promise).status).toBe('passed');
    expect((await engine.start(workflow('leased')).promise).status).toBe('passed');
  });
});
