import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureServer } from '../fixtures/app/server.mjs';
import { testHarness } from '../helpers.js';
import type { BrowserHarness } from '../../src/harness/browser-harness.js';

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

async function login(session: string, user: string, pw: string) {
  const s = h.sessions.find(session) ? h.session(session) : await h.createSession({ name: session });
  await s.navigate(`${base}/login`);
  await s.fill({ label: 'Username' }, user);
  await s.fill({ label: 'Password' }, pw);
  await s.click({ role: 'button', name: 'Sign in' });
  return s;
}

describe('browser harness (real browser)', () => {
  it('navigates and returns a semantic snapshot with refs, without duplicating labels', async () => {
    const s = await h.createSession({ name: 'snap' });
    const r = await s.navigate(`${base}/login`);
    expect(r.newPages).toBeUndefined(); // the session's own first tab is not a website popup
    expect(r.pageState).toContain('Page: Login');
    expect(r.pageState).toMatch(/textbox "Username" \[required\] \[ref=e\d+\]/);
    expect(r.pageState).toMatch(/button "Sign in" \[ref=e\d+\]/);
    expect(r.pageState).not.toContain('text: Username');
    expect(r.pageState).not.toMatch(/<\w+/); // no raw HTML
  });

  it('clicks and fills using refs, returning a diff', async () => {
    const s = h.session('snap');
    const snap = await s.snapshot();
    const ref = (re: RegExp) => re.exec(snap.text)![1]!;
    await s.fill({ ref: ref(/textbox "Username" \[required\] \[ref=(e\d+)\]/) }, 'maker');
    await s.fill({ ref: ref(/textbox "Password" \[required\] \[ref=(e\d+)\]/) }, 'maker123');
    const r = await s.click({ ref: ref(/button "Sign in" \[ref=(e\d+)\]/) });
    expect(r.url).toContain('/request/create');
    expect(r.pageState).toContain('heading "Create Request"');
  });

  it('reports stale refs after navigation instead of acting on the wrong element', async () => {
    const s = h.session('snap');
    const before = await s.snapshot();
    const submitRef = /button "Submit" \[ref=(e\d+)\]/.exec(before.text)![1]!;
    await s.navigate(`${base}/dynamic`);
    await expect(s.click({ ref: submitRef })).rejects.toMatchObject({ code: 'STALE_ELEMENT_REFERENCE' });
    await expect(s.click({ ref: 'e99999' })).rejects.toMatchObject({ code: 'ELEMENT_NOT_FOUND' });
    await expect(s.click({ ref: 'bogus' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('keeps refs stable within a document and reports dynamic changes', async () => {
    const s = h.session('snap');
    const snap = await s.snapshot();
    const inc = /button "Increment" \[ref=(e\d+)\]/.exec(snap.text)![1]!;
    let r = await s.click({ ref: inc });
    expect(r.pageState).toContain('"Count: 0" → "Count: 1"');
    r = await s.click({ ref: inc });
    expect(r.pageState).toContain('"Count: 1" → "Count: 2"');
    r = await s.click({ role: 'button', name: 'Load items' });
    expect(r.pageState).toMatch(/Added:[\s\S]*Alpha/);
  });

  it('handles native select, ARIA combobox, checkbox, and form submission', async () => {
    const s = await login('maker', 'maker', 'maker123');
    let r = await s.select({ label: 'Request Type' }, 'Card Issue');
    expect(r.pageState).toContain('"-- choose --" → "Card Issue"');
    r = await s.select({ role: 'combobox', name: 'Priority' }, 'High');
    expect(r.pageState).toContain('"Normal" → "High"');
    await expect(s.select({ role: 'combobox', name: 'Priority' }, 'Galactic')).rejects.toMatchObject({
      code: 'ELEMENT_NOT_FOUND',
      context: { available: ['Low', 'Normal', 'High'] },
    });
    // A failed pick must not leave the popup open over the controls below (it covered "Urgent" on Windows).
    expect(await s.raw.page().page.locator('#prio-list').isVisible()).toBe(false);
    r = await s.check({ label: 'Urgent' });
    expect(r.pageState).toContain('+checked');
    await s.fill({ label: 'Customer Name' }, 'ACME Corp');
    r = await s.click({ role: 'button', name: 'Submit' });
    expect(r.pageState).toMatch(/alert "Request REQ-\d+ submitted successfully"/);
    expect(r.pageState).toContain('Removed:');
  });

  it('fills several fields in one call', async () => {
    const s = h.session('maker');
    await s.navigate(`${base}/request/create`);
    const r = await s.fillForm([
      { target: { label: 'Customer Name' }, value: 'Batch Co' },
      { target: { label: 'Request Type' }, value: 'Loan' },
      { target: { role: 'combobox', name: 'Priority' }, value: 'Low' },
      { target: { label: 'Urgent' }, value: true },
    ]);
    expect(r.message).toContain('Filled 4 fields');
    expect(r.pageState).toContain('"Normal" → "Low"');
  });

  it('isolates sessions: cookies of one user never leak into another', async () => {
    const checker = await login('checker', 'checker', 'checker123');
    const maker = h.session('maker');
    const who = async (s: typeof maker) => (await s.navigate(`${base}/api/whoami`), s.text());
    expect(await who(maker)).toContain('"maker"');
    expect(await who(checker)).toContain('"checker"');
    const anon = await h.createSession({ name: 'anon' });
    expect(await who(anon)).toContain('"user":null');
  });

  it('handles alert/confirm/prompt dialogs without hanging', async () => {
    const s = await h.createSession({ name: 'dialogs' });
    await s.navigate(`${base}/dialogs`);
    let r = await s.click({ role: 'button', name: 'Ask confirm' });
    expect(r.dialog).toMatchObject({ type: 'confirm', message: 'Proceed?' });
    await expect(s.click({ role: 'button', name: 'Show alert' })).rejects.toThrow(/dialog is blocking/);
    r = await s.dialog(true);
    expect(r.pageState).toContain('"Idle" → "Confirmed"');
    await s.click({ role: 'button', name: 'Ask prompt' });
    r = await s.dialog(true, 'Tran');
    expect(r.pageState).toContain('Name: Tran');
  });

  it('detects new tabs opened by the page', async () => {
    const s = await h.createSession({ name: 'tabs' });
    await s.navigate(`${base}/tabs`);
    const r = await s.click({ role: 'link', name: 'Open dynamic in new tab' });
    expect(r.newPages?.length).toBe(1);
    const tabs = await h.actions.tabs({ session: 'tabs' });
    expect(tabs).toHaveLength(2);
    const own = await h.actions.tabCreate(undefined, { session: 'tabs' });
    expect(own.newPages).toBeUndefined();
    expect(await h.actions.tabs({ session: 'tabs' })).toHaveLength(3);
    const sw = await h.actions.tabSwitch(r.newPages![0]!.pageId, { session: 'tabs' });
    expect(sw.pageState).toContain('Dynamic rendering');
  });

  it('snapshots iframes and open shadow DOM, and acts inside them via refs', async () => {
    const s = await h.createSession({ name: 'frames' });
    const r = await s.navigate(`${base}/frames`);
    expect(r.pageState).toMatch(/iframe "Embedded form" \[ref=e\d+\]\n\s+- textbox "Frame input"/);
    expect(r.pageState).toContain('button "Shadow button"');
    const frameInput = /textbox "Frame input" \[ref=(e\d+)\]/.exec(r.pageState!)![1]!;
    await s.fill({ ref: frameInput }, 'hello');
    const btn = /button "Frame submit" \[ref=(e\d+)\]/.exec(r.pageState!)![1]!;
    let c = await s.click({ ref: btn });
    expect(c.pageState).toContain('Frame says hello');
    c = await s.click({ role: 'button', name: 'Shadow button' });
    expect(c.pageState).toContain('shadow clicked');
  });

  it('captures API failures, console errors and uncaught exceptions', async () => {
    const s = await h.createSession({ name: 'errors' });
    await s.navigate(`${base}/api-failure`);
    const r = await s.click({ role: 'button', name: 'Load data' });
    expect(r.errors?.network).toMatch(/GET .*\/api\/broken → 500/);
    expect(r.errors?.console).toContain('Failed to load data: HTTP 500');
    const e = s.raw.monitor.errors();
    expect(e.console.some((x) => x.type === 'pageerror' && x.text.includes('Unhandled render failure'))).toBe(
      true,
    );
    const net = s.raw.monitor.network({ status: 500 });
    expect(net.total).toBe(1);
    expect(net.entries[0]!.requestHeaders).toBeDefined();
  });

  it('redacts sensitive field values in snapshots and attributes', async () => {
    const s = await h.createSession({ name: 'secrets' });
    const r = await s.navigate(`${base}/secret-form`);
    expect(r.pageState).not.toContain('hunter2-secret');
    expect(r.pageState).not.toContain('tok_live_ABCDEF1234567890');
    expect(r.pageState).toMatch(/textbox "Password" \[ref=e\d+\]: "••••"/);
    expect(r.pageState).toMatch(/textbox "API token" \[ref=e\d+\]: "••••"/);
    const attrs = await h.actions.getAttributes({ label: 'Password' }, undefined, { session: 'secrets' });
    expect(attrs.value).toBe('[REDACTED]');
    const shot = await s.screenshot({ format: 'png' });
    expect(shot.base64!.length).toBeGreaterThan(1000);
  });

  it('paginates very large pages and supports scoped / interactive-only snapshots', async () => {
    const s = await h.createSession({ name: 'large' });
    await s.navigate(`${base}/large`);
    const p1 = await s.snapshot();
    expect(p1.totalPages).toBeGreaterThan(1);
    expect(p1.text.length).toBeLessThanOrEqual(h.config.snapshot.maxChars + 200);
    const p2 = await s.snapshot({ page: 2 });
    expect(p2.text).toContain(`snapshot page 2/${p1.totalPages}`);
    const listRef = /list "Many" \[ref=(e\d+)\]/.exec(p1.text)![1]!;
    const scoped = await s.snapshot({ scope: listRef });
    expect(scoped.text).toContain('Item number 0');
    expect(scoped.text).not.toContain('banner');
    const io = await s.snapshot({ interactiveOnly: true });
    expect(io.text).not.toContain('text:');
  });

  it('saves and restores a logged-in session (encrypted)', async () => {
    const saved = await h.sessions.save('maker');
    expect(saved.cookies).toBeGreaterThan(0);
    await h.sessions.close('maker');
    const s = await h.sessions.restore('maker');
    expect(s.name).toBe('maker');
    const m = h.session('maker');
    await m.navigate(`${base}/api/whoami`);
    expect(await m.text()).toContain('"maker"');
  });

  it('emits typed lifecycle events', async () => {
    const seen: string[] = [];
    const off = h.events.onAny((e) => seen.push(e));
    const s = await h.createSession({ name: 'events' });
    await s.navigate(`${base}/`);
    await s.click({ role: 'link', name: 'Dialogs' });
    await expect(s.click({ ref: 'e999999' })).rejects.toThrow();
    off();
    expect(seen).toEqual(
      expect.arrayContaining([
        'session.created',
        'navigation.started',
        'navigation.completed',
        'action.started',
        'action.completed',
        'action.failed',
      ]),
    );
  });
});

describe('custom combobox option matching (D18)', () => {
  it('picks an exact or unique substring match and refuses ambiguous ones', async () => {
    const s = await h.createSession({ name: 'combo' });
    await s.navigate(`${base}/combobox-ambiguous`);
    const combo = { role: 'combobox', name: 'Account' };
    const page = s.raw.page().page;
    // "Account" is contained in three options and matches none exactly: ambiguous, nothing is clicked.
    await expect(s.select(combo, 'Account')).rejects.toMatchObject({
      code: 'ELEMENT_AMBIGUOUS',
      context: { candidates: ['Savings Account', 'Checking Account', 'Account Closure'] },
    });
    expect(await page.locator('#acct').textContent()).toBe('Choose…');
    expect(await page.locator('#acct-list').isVisible()).toBe(false);
    // Two options with the same text are ambiguous as well.
    await expect(s.select(combo, 'Joint')).rejects.toMatchObject({ code: 'ELEMENT_AMBIGUOUS' });
    expect(await page.locator('#acct').textContent()).toBe('Choose…');
    // A unique substring and an exact (case-insensitive) match still work.
    await s.select(combo, 'Checking');
    expect(await page.locator('#acct').textContent()).toBe('Checking Account');
    await s.select(combo, 'loan');
    expect(await page.locator('#acct').textContent()).toBe('Loan');
    await s.close();
  });
});

describe('SDK sessions in non-default projects (D8)', () => {
  it('act on the session of their own project, never a same-named session elsewhere', async () => {
    const p2 = await h.createSession({ name: 'proj-user', project: 'p2' });
    expect(p2.project).toBe('p2');
    const r = await p2.navigate(`${base}/login`);
    expect(r.pageState).toContain('Page: Login');
    await p2.fill({ label: 'Username' }, 'maker');
    expect((await p2.snapshot()).text).toContain('Page: Login');
    const saved = await p2.save();
    expect(saved.project).toBe('p2');
    // A same-named session in the default project is a different session.
    const dflt = await h.createSession({ name: 'proj-user' });
    await dflt.navigate(`${base}/dynamic`);
    expect(p2.raw.pages.get(p2.raw.activePageId!)!.page.url()).toContain('/login');
    expect(h.session('proj-user', 'p2').raw.id).toBe(p2.raw.id);
    await p2.close();
    await dflt.close();
  });

  it('let name-addressed tools (no project param) reach a session that exists in one other project', async () => {
    const only = await h.createSession({ name: 'elsewhere', project: 'p3' });
    await only.navigate(`${base}/login`);
    // MCP page tools pass only `session`; the name exists in exactly one project.
    const snap = await h.actions.snapshot({}, { session: 'elsewhere' });
    expect(snap.sessionId).toBe(only.raw.id);
    const twin = await h.createSession({ name: 'elsewhere', project: 'p4' });
    await expect(h.actions.snapshot({}, { session: 'elsewhere' })).rejects.toMatchObject({
      code: 'SESSION_AMBIGUOUS',
      suggestion: expect.stringContaining('session id'),
    });
    // The id stays unambiguous.
    expect((await h.actions.snapshot({}, { session: twin.raw.id })).sessionId).toBe(twin.raw.id);
    await only.close();
    await twin.close();
  });
});

describe('labels bound to controls', () => {
  it('are not reported as separate clickable elements (cursor:pointer labels)', async () => {
    const s = await h.createSession({ name: 'labels' });
    await s.raw
      .page()
      .page.setContent(
        '<style>label{cursor:pointer}</style><ul><li><input type="checkbox" id="t1"><label for="t1">Learn <a href="#c3">Card 3</a></label></li>' +
          '<li><input type="checkbox" id="t2"><label for="t2">Write notes</label></li></ul><div style="cursor:pointer" onclick="1">Fake button</div>',
      );
    const snap = await s.snapshot();
    expect(snap.text).not.toMatch(/clickable \[ref|clickable "Write notes"/);
    expect(snap.text).toContain('checkbox "Write notes"');
    expect(snap.text).toContain('link "Card 3"');
    expect(snap.text).toContain('clickable "Fake button"'); // heuristic still works for real div buttons
  });
});
