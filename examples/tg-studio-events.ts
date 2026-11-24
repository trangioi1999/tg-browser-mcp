/** Shows the typed event stream TG Studio can subscribe to: npx tsx examples/tg-studio-events.ts */
import { BrowserHarness } from '../src/sdk.js';
import { createFixtureServer } from '../tests/fixtures/app/server.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Demo data goes to a temp dir; omit dataDir to use ~/.tg-browser.
const dataDir = mkdtempSync(join(tmpdir(), 'tg-example-'));

const app = createFixtureServer();
const base = await app.listen();
const harness = new BrowserHarness({
  dataDir,
  project: 'studio-demo',
  browser: { headless: true },
  logLevel: 'warn',
});
harness.events.onAny((event, payload) => console.log(event.padEnd(22), JSON.stringify(payload)));
harness.setApprovalHandler(async ({ title }) => (console.log(`[approval] ${title} → declined`), 'declined'));
try {
  const s = await harness.createSession({ name: 'agent-a', agentId: 'frontend-agent' });
  await s.navigate(`${base}/dynamic`);
  await s.click({ role: 'button', name: 'Load items' });
  await s.screenshot({ save: true });
} finally {
  await harness.close();
  await app.close();
}
