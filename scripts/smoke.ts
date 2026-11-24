import { BrowserHarness } from '../src/harness/browser-harness.js';
import { createFixtureServer } from '../tests/fixtures/app/server.mjs';

const app = createFixtureServer();
const base = await app.listen();
const h = new BrowserHarness({
  dataDir: process.env.TG_SMOKE_DIR ?? '/tmp/tg-smoke',
  browser: { headless: true },
});
try {
  const s = await h.createSession({ name: 'maker' });
  let r = await s.navigate(`${base}/login`);
  console.log(r.pageState);
  await s.fill({ label: 'Username' }, 'maker');
  await s.fill({ label: 'Password' }, 'maker123');
  r = await s.click({ role: 'button', name: 'Sign in' });
  console.log('---after login---\n', r.message, '\n', r.pageState);
  const snap = await s.snapshot();
  console.log(snap.text);
  r = await s.select({ label: 'Request Type' }, 'Loan');
  console.log(r.message, r.pageState);
  r = await s.select({ role: 'combobox', name: 'Priority' }, 'High');
  console.log(r.message, r.pageState);
  r = await s.fill({ label: 'Customer Name' }, 'Test Customer');
  r = await s.click({ role: 'button', name: 'Submit' });
  console.log('---submit---\n', r.message, '\n', r.pageState, r.errors);
} finally {
  await h.close();
  await app.close();
}
