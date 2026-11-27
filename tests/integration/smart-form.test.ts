import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureServer } from '../fixtures/app/server.mjs';
import { testHarness } from '../helpers.js';
import type { BrowserHarness, HarnessSession } from '../../src/harness/browser-harness.js';
let app: ReturnType<typeof createFixtureServer>;
let base: string;
let h: BrowserHarness;
beforeAll(async () => {
  app = createFixtureServer();
  base = await app.listen();
  h = testHarness();
});
afterAll(async () => {
  await h?.close();
  await app?.close();
});
let counter = 0;
async function form(): Promise<HarnessSession> {
  const s = await h.createSession({ name: `form-${++counter}` });
  await s.navigate(`${base}/smart-form`);
  return s;
}
describe('smart batch fill', () => {
  it('fails fast with partial progress and supports continuing', async () => {
    const s = await form();
    const r = await s.fillForm([
      { target: { label: 'Name', exact: true }, value: 'Alice' },
      { target: { label: 'Disabled' }, value: 'x' },
      { target: { label: 'Existing' }, value: 'changed' },
    ]);
    expect(r.fieldResults?.map((f) => f.status)).toEqual(['filled', 'disabled', 'failed']);
    expect(r.fieldResults?.[2]?.code).toBe('NOT_ATTEMPTED');
    expect(r.outcome?.verificationStatus).toBe('FAILED');
    const continued = await s.fillForm(
      [
        { target: { label: 'Readonly' }, value: 'x' },
        { target: { label: 'Existing' }, value: 'changed' },
      ],
      { continueOnError: true },
    );
    expect(continued.fieldResults?.map((f) => f.status)).toEqual(['readonly', 'filled']);
  });
  it('preserves existing data and verifies sensitive read-back without echoing values', async () => {
    const s = await form();
    const r = await s.fillForm([
      { target: { label: 'Existing' }, value: 'replace', mode: 'ifEmpty' },
      { target: { label: 'Password' }, value: 'form-fixture-secret' },
    ]);
    expect(r.fieldResults?.map((f) => f.status)).toEqual(['skipped', 'filled']);
    expect(r.outcome?.verificationStatus).toBe('VERIFIED');
    expect(JSON.stringify(r)).not.toContain('form-fixture-secret');
    expect(r.data).toMatchObject({ requiredMissing: ['Name'] });
  });
  it('selects autocomplete, radio and a dependent field', async () => {
    const s = await form();
    const r = await s.fillForm([
      { target: { label: 'City' }, value: 'London' },
      { target: { role: 'radiogroup', name: 'Priority' }, value: 'Urgent' },
      { target: { label: 'Category' }, value: 'Loan' },
      { target: { label: 'Loan term' }, value: '12' },
    ]);
    expect(r.fieldResults?.every((f) => f.verified)).toBe(true);
    expect(r.outcome?.verificationStatus).toBe('VERIFIED');
    expect(await s.text({ role: 'status' })).toBe('Selected London');
  });
  it('returns ambiguity and missing field errors', async () => {
    const s = await form();
    const r = await s.fillForm(
      [
        { target: { label: 'City' }, value: 'Lon' },
        { target: { label: 'Missing' }, value: 'x' },
      ],
      { continueOnError: true },
    );
    expect(r.fieldResults?.[0]?.code).toBe('ELEMENT_AMBIGUOUS');
    expect(r.fieldResults?.[1]?.status).toBe('not_found');
  });
  it('associates validation messages and fails overall verification', async () => {
    const s = await form();
    const r = await s.fillForm([{ target: { label: 'Amount' }, value: '0' }]);
    expect(r.data).toMatchObject({ validationMessages: ['Must be greater than zero'] });
    expect(r.outcome?.verificationStatus).toBe('FAILED');
  });
  it('allows disabling read-back without claiming verification', async () => {
    const s = await form();
    const r = await s.fillForm([{ target: { label: 'Name', exact: true }, value: 'Alice' }], {
      verify: false,
    });
    expect(r.outcome?.verificationStatus).toBe('UNVERIFIED');
  });
  it('scopes duplicate fields to the requested form', async () => {
    const s = await form();
    await s.navigate(`${base}/scoped-fill`);
    const result = await s.fillForm([{ target: { label: 'Name', exact: true }, value: 'Billing only' }], {
      within: { role: 'form', name: 'Billing' },
    });
    expect(result.fieldResults?.[0]).toMatchObject({ status: 'filled', verified: true });
    expect(await h.actions.inputValue({ selector: 'input[name=shipping]' }, { session: s.name })).toBe('');
  });
});
