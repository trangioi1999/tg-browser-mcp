/** Runs examples/workflows/maker-checker.json, prints a report, writes a Playwright spec. */
import fs from 'node:fs';
import {
  BrowserHarness,
  WorkflowEngine,
  generatePlaywrightTest,
  markdownReport,
  validateWorkflow,
} from '../src/sdk.js';
import { createFixtureServer } from '../tests/fixtures/app/server.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Demo data goes to a temp dir; omit dataDir to use ~/.tg-browser.
const dataDir = mkdtempSync(join(tmpdir(), 'tg-example-'));

process.env.TG_SECRET_MAKER_PASSWORD ??= 'maker123';
process.env.TG_SECRET_CHECKER_PASSWORD ??= 'checker123';
const def = JSON.parse(fs.readFileSync(new URL('./workflows/maker-checker.json', import.meta.url), 'utf8'));
const app = createFixtureServer();
const base = await app.listen();
const harness = new BrowserHarness({ dataDir, browser: { headless: true }, logLevel: 'warn' });
try {
  const run = await new WorkflowEngine(harness).execute(def, { variables: { BASE_URL: base } });
  console.log(markdownReport([run]));
  const v = validateWorkflow(def);
  if (v.workflow) fs.writeFileSync('maker-checker.generated.spec.ts', generatePlaywrightTest(v.workflow));
  console.log('Wrote maker-checker.generated.spec.ts');
  process.exitCode = run.status === 'passed' ? 0 : 1;
} finally {
  await harness.close();
  await app.close();
}
