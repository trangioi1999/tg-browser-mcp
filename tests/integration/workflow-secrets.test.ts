import fs from 'node:fs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createFixtureServer } from '../fixtures/app/server.mjs';
import { testHarness } from '../helpers.js';
import { WorkflowEngine } from '../../src/workflow/workflow-engine.js';
import { assertValidWorkflow } from '../../src/workflow/workflow-validator.js';

const app = createFixtureServer();
const h = testHarness();
const engine = new WorkflowEngine(h);
let base: string;
beforeAll(async () => {
  base = await app.listen();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await h.close();
  await app.close();
  fs.rmSync(h.config.dataDir, { recursive: true, force: true });
});
it('fills a saved login secret and refuses URL exfiltration before dispatch', async () => {
  vi.stubEnv('TG_SECRET_LOGIN', 'fixture-password');
  expect(() =>
    engine.start({
      name: 'exfil',
      steps: [{ id: 'open', action: 'navigate', input: { url: `${base}/?pw=\${secret.LOGIN}` } }],
    }),
  ).toThrow(/secrets are only allowed/);
  engine.saveDefinition(
    assertValidWorkflow({
      name: 'login',
      steps: [
        { id: 'open', action: 'navigate', input: { url: `${base}/login` } },
        { id: 'password', action: 'fill', input: { label: 'Password', value: '${secret.LOGIN}' } },
      ],
    }),
  );
  const run = await engine.execute(engine.loadDefinition('login'));
  expect(run.status).toBe('passed');
  expect(await h.session('default').raw.page().page.getByLabel('Password').inputValue()).toBe(
    'fixture-password',
  );
  expect(await h.actions.inputValue({ label: 'Password' }, { session: 'default' })).toBe('[REDACTED]');
});
