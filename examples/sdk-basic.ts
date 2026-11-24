/** Basic SDK usage against the fixture app: npx tsx examples/sdk-basic.ts */
import { BrowserHarness } from '../src/sdk.js';
import { createFixtureServer } from '../tests/fixtures/app/server.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Demo data goes to a temp dir; omit dataDir to use ~/.tg-browser.
const dataDir = mkdtempSync(join(tmpdir(), 'tg-example-'));

const app = createFixtureServer();
const base = await app.listen();
const harness = new BrowserHarness({ dataDir, browser: { headless: true }, logLevel: 'warn' });
try {
  const session = await harness.createSession({ name: 'frontend-agent', browser: 'chrome' });
  await session.navigate(`${base}/login`);
  await session.fillForm([
    { target: { label: 'Username' }, value: 'maker' },
    { target: { label: 'Password' }, value: 'maker123' },
  ]);
  const r = await session.click({ role: 'button', name: 'Sign in' });
  console.log(r.message, '→', r.url);
  console.log((await session.snapshot({ interactiveOnly: true })).text);
} finally {
  await harness.close();
  await app.close();
}
