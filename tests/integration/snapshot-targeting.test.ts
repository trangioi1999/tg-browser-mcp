import { afterAll, beforeAll, expect, it } from 'vitest';
import { createFixtureServer } from '../fixtures/app/server.mjs';
import { testHarness } from '../helpers.js';
import { installScriptSource } from '../../src/snapshot/injected.js';
const app = createFixtureServer();
const h = testHarness({ security: { approval: { destructive: 'ask' } } });
let base: string;
let seq = 0;
beforeAll(async () => {
  base = await app.listen();
});
afterAll(async () => {
  await h.close();
  await app.close();
});
async function setup(route = '/virtual-table') {
  const s = await h.createSession({ name: `target-${++seq}` });
  await s.navigate(base + route);
  const ps = s.raw.page();
  const snap = await s.snapshot();
  const ref = /button "Approve" \[ref=(e\d+)\]/.exec(snap.text)?.[1];
  return { s, ps, snap, ref: ref! };
}
it('refuses recycled rows without approving a different record', async () => {
  const { s, ps, ref } = await setup();
  await ps.page.getByTestId('viewport').evaluate((el) => {
    el.scrollTop = 400;
  });
  await ps.page.waitForFunction(
    () => document.querySelector('tr')?.getAttribute('data-row-key') === 'REQ009',
  );
  await expect(s.click({ ref })).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
  expect(await ps.page.locator('#log').textContent()).toBe('none');
});
it('keeps identity when counters change or a row moves with its node', async () => {
  const { s, ps, ref, snap } = await setup();
  await ps.page.locator('tbody').evaluate((body) => {
    body.querySelector('.counter')!.textContent = '999';
    body.append(body.firstElementChild!);
    document.querySelector('#live')!.textContent = 'Count 2';
  });
  const result = await ps.refs.resolve(ref);
  await result.handle.click();
  await result.handle.dispose();
  expect(await ps.page.locator('#log').textContent()).toBe('REQ001');
  const live = /button "Count 0" \[ref=(e\d+)\]/.exec(snap.text)![1]!;
  expect(await s.text({ ref: live })).toBe('Count 2');
  const read = await ps.refs.resolve(live, 'read');
  expect(read.desc.name).toBe('Count 2');
  await read.handle.dispose();
  await expect(ps.refs.resolve(live, 'action')).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
});
it('rejects changed action labels and accepts a fresh snapshot', async () => {
  const { ps, ref, s } = await setup();
  await ps.page
    .locator('tr button')
    .first()
    .evaluate((el) => {
      el.textContent = 'Reject';
    });
  await expect(ps.refs.resolve(ref)).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
  await s.snapshot();
  const fresh = await ps.refs.resolve(ref);
  expect(fresh.desc.name).toBe('Reject');
  await fresh.handle.dispose();
});
it('emits slotted elements once and includes unassigned slot fallback', async () => {
  const { snap } = await setup();
  expect(snap.text.match(/button "Slotted action"/g)).toHaveLength(1);
  expect(snap.text.match(/button "Fallback action"/g)).toHaveLength(1);
});
it('protects names, ref mapping, and masking from hostile page prototypes', async () => {
  const { s, ps, snap } = await setup('/hostile');
  expect(snap.text).toContain('Delete everything');
  expect(snap.text).not.toContain('fixture-private-value');
  expect(snap.text).toContain('••••');
  const ref = /button "Delete everything" \[ref=(e\d+)\]/.exec(snap.text)![1]!;
  await expect(s.click({ ref })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
  await expect(s.click({ selector: '#danger' })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
  expect(await ps.page.locator('#log').textContent()).toBe('none');
  await expect(
    ps.page.evaluate(() =>
      (window as unknown as { __tgSnap: { collect(a: object): unknown } }).__tgSnap.collect({}),
    ),
  ).rejects.toThrow('Unauthorized');
});
it('fails closed on a pre-existing fake engine in an already-loaded document', async () => {
  const { ps } = await setup();
  const browser = ps.page.context().browser()!;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(base + '/hostile');
    await expect(page.evaluate(installScriptSource())).rejects.toThrow('TARGET_CHANGED');
  } finally {
    await context.close();
  }
});
