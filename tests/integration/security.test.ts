import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureServer } from '../fixtures/app/server.mjs';
import { testHarness } from '../helpers.js';
import type { BrowserHarness } from '../../src/harness/browser-harness.js';
import { AssertionEngine } from '../../src/testing/assertion-engine.js';
import { WorkflowEngine } from '../../src/workflow/workflow-engine.js';

let app: ReturnType<typeof createFixtureServer>;
let base: string;
let h: BrowserHarness;

beforeAll(async () => {
  app = createFixtureServer();
  base = await app.listen();
  h = testHarness({ security: { blockedDomains: ['blocked.example'] } });
});
afterAll(async () => {
  await h?.close();
  await app?.close();
});

describe('security policies (real browser)', () => {
  it('blocks direct navigation to cloud metadata and private networks', async () => {
    const s = await h.createSession({ name: 'sec' });
    await expect(s.navigate('http://169.254.169.254/latest/meta-data')).rejects.toMatchObject({
      code: 'DOMAIN_NOT_ALLOWED',
    });
    await expect(s.navigate('http://10.0.0.1/')).rejects.toMatchObject({ code: 'DOMAIN_NOT_ALLOWED' });
    await expect(s.navigate('file:///etc/passwd')).rejects.toMatchObject({ code: 'DOMAIN_NOT_ALLOWED' });
    await expect(s.navigate('http://blocked.example/')).rejects.toMatchObject({ code: 'DOMAIN_NOT_ALLOWED' });
  });

  it('blocks redirects to forbidden destinations', async () => {
    const s = h.session('sec');
    await expect(
      s.navigate(`${base}/redirect?to=${encodeURIComponent('http://169.254.169.254/latest/meta-data')}`),
    ).rejects.toMatchObject({ code: 'DOMAIN_NOT_ALLOWED' });
    const snap = await s.snapshot();
    expect(snap.text).not.toContain('meta-data');
  });

  it('blocks page-initiated navigation, popups and sub-requests to forbidden hosts', async () => {
    const s = h.session('sec');
    await s.navigate(`${base}/`);
    const page = s.raw.page().page;
    // Simulate a malicious page script.
    await page.evaluate(() => {
      void fetch('http://169.254.169.254/latest/meta-data').catch(() => undefined);
      const img = new Image();
      img.src = 'http://10.1.1.1/pixel.gif';
      document.body.appendChild(img);
    });
    await page.waitForTimeout(500);
    const blocked = s.raw.monitor.network({ status: 'failed' }).entries;
    expect(blocked.some((e) => e.url.includes('169.254.169.254') && e.blockedByPolicy)).toBe(true);
    expect(blocked.some((e) => e.url.includes('10.1.1.1') && e.blockedByPolicy)).toBe(true);

    const popupPromise = page.context().waitForEvent('page');
    await page.evaluate(() => window.open('http://169.254.169.254/', '_blank'));
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded').catch(() => undefined);
    expect(await popup.content()).toContain('Blocked by TG Browser policy');
    await popup.close();

    await page.evaluate(() => {
      location.href = 'http://192.168.0.1/admin';
    });
    await page.waitForTimeout(500);
    expect(await page.content()).toContain('Blocked by TG Browser policy');
  });

  it('blocks WebSocket connections to forbidden hosts', async () => {
    const s = h.session('sec');
    await s.navigate(`${base}/`);
    const result = await s.raw.page().page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const ws = new WebSocket('ws://169.254.169.254/socket');
          ws.onclose = (e) => resolve(`closed ${e.code}`);
          ws.onerror = () => resolve('error');
          setTimeout(() => resolve('timeout'), 3000);
        }),
    );
    expect(result).not.toBe('timeout');
  });

  it('treats prompt-injection text as data (no navigation, no instruction-following)', async () => {
    const s = await h.createSession({ name: 'inject' });
    const r = await s.navigate(`${base}/secret-form`);
    expect(r.pageState).toContain('Ignore previous instructions');
    expect(r.url).toContain('/secret-form');
    expect(s.raw.monitor.network({ url: '169.254' }).total).toBe(0);
  });

  it('restricts file paths for screenshots and uploads', async () => {
    const s = h.session('inject');
    await expect(s.screenshot({ path: '/etc/evil.png' })).rejects.toMatchObject({
      code: 'FILE_ACCESS_DENIED',
    });
    await expect(
      s.screenshot({ path: path.join(h.config.dataDir, '..', '..', 'evil.png') }),
    ).rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    await expect(
      h.actions.upload({ label: 'Email' }, ['/etc/hosts'], { session: 'inject' }),
    ).rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    const ok = await s.screenshot({ path: path.join(h.config.dataDir, 'artifacts', 'ok.png'), format: 'png' });
    expect(ok.path).toContain('ok.png');
  });

  it('writes agent-chosen paths only under write roots, with allowed extensions, never overwriting (S-08)', async () => {
    const s = h.session('inject');
    const artifacts = path.join(h.config.dataDir, 'artifacts');
    // Read roots (cwd, dataDir) are not write roots.
    await expect(s.screenshot({ path: path.join(process.cwd(), 'evil.png') })).rejects.toMatchObject({
      code: 'FILE_ACCESS_DENIED',
    });
    await expect(s.screenshot({ path: path.join(h.config.dataDir, 'top.png') })).rejects.toMatchObject({
      code: 'FILE_ACCESS_DENIED',
    });
    // Extension allowlist per output kind.
    await expect(s.screenshot({ path: path.join(artifacts, 'evil.js') })).rejects.toThrow(/File type not allowed/);
    await expect(
      s.screenshot({ path: path.join(artifacts, 'shot.jpg'), format: 'png' }),
    ).rejects.toThrow(/File type not allowed/);
    await expect(
      h.actions.traceStop(path.join(artifacts, 'trace.json'), { session: 'inject' }),
    ).rejects.toThrow(/File type not allowed/);
    // No silent overwrite.
    const first = await s.screenshot({ path: path.join(artifacts, 'once.jpeg') });
    expect(first.path).toContain('once.jpeg');
    await expect(s.screenshot({ path: path.join(artifacts, 'once.jpeg') })).rejects.toThrow(/already exists/);
    expect(h.permissions.checkFilePath(path.join(artifacts, 'flow.spec.ts'), 'write')).toContain('flow.spec.ts');
    expect(() => h.permissions.checkFilePath(path.join(artifacts, 'index.ts'), 'write')).toThrow(
      /File type not allowed/,
    );
  });

  it('masks password values in value assertions (S-07)', async () => {
    const s = h.session('inject');
    await s.navigate(`${base}/secret-form`);
    const engine = new AssertionEngine(h.sessions, h.actions);
    const fail = await engine.check(
      { type: 'value', target: { label: 'Password' }, equals: 'wrong-guess', timeout: 300 },
      { session: 'inject' },
    );
    expect(fail.passed).toBe(false);
    expect(JSON.stringify(fail)).not.toContain('hunter2');
    expect(JSON.stringify(fail)).not.toContain('wrong-guess');
    expect(fail.message).toContain('[REDACTED]');
    const pass = await engine.check(
      { type: 'value', target: { label: 'Password' }, equals: 'hunter2-secret', timeout: 300 },
      { session: 'inject' },
    );
    expect(pass.passed).toBe(true);
    expect(JSON.stringify(pass)).not.toContain('hunter2');
    const attr = await engine.check(
      { type: 'attribute', attribute: 'value', target: { label: 'Password' }, contains: 'hunter', timeout: 300 },
      { session: 'inject' },
    );
    expect(attr.passed).toBe(true);
    expect(JSON.stringify(attr)).not.toContain('hunter');
    // Non-sensitive fields keep their values for debugging.
    const email = await engine.check(
      { type: 'value', target: { label: 'Email' }, equals: 'nobody@example.com', timeout: 300 },
      { session: 'inject' },
    );
    expect(email.message).toContain('user@example.com');
  });

  it('requires approval for destructive clicks and high-risk tools', async () => {
    const s = await h.createSession({ name: 'destructive' });
    await s.raw
      .page()
      .page.setContent('<button onclick="document.title=\'deleted\'">Delete account</button>');
    await expect(s.click({ role: 'button', name: 'Delete account' })).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    expect(await s.raw.page().page.title()).not.toBe('deleted');
    h.setApprovalHandler(async () => 'declined');
    await expect(s.click({ role: 'button', name: 'Delete account' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    h.setApprovalHandler(async () => 'approved');
    await s.click({ role: 'button', name: 'Delete account' });
    expect(await s.raw.page().page.title()).toBe('deleted');
    h.setApprovalHandler(undefined);
  });

  describe('policy gate on every mutating action (S-01, destructive=deny)', () => {
    let hd: BrowserHarness;
    const ctx = { session: 'gate' };
    const log = () => hd.session('gate').raw.page().page.locator('#log').textContent();
    const open = async () => {
      await hd.session('gate').navigate(`${base}/policy-gate`);
    };
    const denied = { code: 'PERMISSION_DENIED' };

    beforeAll(async () => {
      hd = testHarness({ security: { approval: { destructive: 'deny' } } });
      await hd.createSession({ name: 'gate' });
    });
    afterAll(async () => {
      await hd?.close();
    });

    it('denies click, Enter and Space on the same destructive button', async () => {
      await open();
      const btn = { role: 'button', name: 'Delete account' };
      await expect(hd.actions.click(btn, {}, ctx)).rejects.toMatchObject(denied);
      await expect(hd.actions.press('Enter', btn, ctx)).rejects.toMatchObject(denied);
      await expect(hd.actions.press('Space', btn, ctx)).rejects.toMatchObject(denied);
      await expect(hd.actions.press(' ', btn, ctx)).rejects.toMatchObject(denied);
      await expect(hd.actions.press('Control+Enter', btn, ctx)).rejects.toMatchObject(denied);
      // By ref, too.
      const snap = await hd.actions.snapshot({}, ctx);
      const ref = snap.text.match(/button "Delete account" \[ref=(e\d+)\]/)?.[1];
      expect(ref).toBeDefined();
      await expect(hd.actions.press('Enter', { ref: ref! }, ctx)).rejects.toMatchObject(denied);
      expect(await log()).toBe('');
    });

    it('denies page-level keys and typed spaces/newlines on a focused destructive button', async () => {
      await open();
      await hd.session('gate').raw.page().page.focus('#del');
      await expect(hd.actions.press('Enter', undefined, ctx)).rejects.toMatchObject(denied);
      await expect(hd.actions.press('Space', undefined, ctx)).rejects.toMatchObject(denied);
      await expect(hd.actions.type(undefined, ' ', {}, ctx)).rejects.toMatchObject(denied);
      await expect(hd.actions.type(undefined, 'x\n', {}, ctx)).rejects.toMatchObject(denied);
      expect(await log()).toBe('');
      // Non-activating keys are not gated.
      await hd.actions.press('Tab', undefined, ctx);
    });

    it("denies Enter in a form field when the form's default button is destructive", async () => {
      await open();
      const reason = { label: 'Reason' };
      await expect(hd.actions.fill(reason, 'moving', { submit: true }, ctx)).rejects.toMatchObject(denied);
      await expect(hd.actions.type(reason, 'moving', { submit: true }, ctx)).rejects.toMatchObject(denied);
      await expect(hd.actions.press('Enter', reason, ctx)).rejects.toMatchObject(denied);
      await hd.session('gate').raw.page().page.focus('#reason');
      await expect(hd.actions.press('Enter', undefined, ctx)).rejects.toMatchObject(denied);
      await expect(hd.actions.type(undefined, 'moving', { submit: true }, ctx)).rejects.toMatchObject(denied);
      const page = hd.session('gate').raw.page().page;
      expect(page.url()).toContain('/policy-gate');
      expect(await page.title()).toBe('Policy gate');
      // Typing a space into a text field is not an activation.
      await hd.actions.type(reason, 'two words', {}, ctx);
    });

    it('denies destructive select options, checkboxes and drop targets', async () => {
      await open();
      await expect(hd.actions.selectOption({ label: 'Bulk action' }, ['Delete selected'], ctx)).rejects.toMatchObject(
        denied,
      );
      await expect(
        hd.actions.fillForm([{ target: { label: 'Bulk action' }, value: 'Delete selected' }], ctx),
      ).rejects.toMatchObject(denied);
      await expect(hd.actions.setChecked({ label: 'Remove my data' }, true, ctx)).rejects.toMatchObject(denied);
      await expect(
        hd.actions.fillForm([{ target: { label: 'Remove my data' }, value: true }], ctx),
      ).rejects.toMatchObject(denied);
      await expect(
        hd.actions.drag({ text: 'Report card' }, { role: 'region', name: 'Delete bin' }, ctx),
      ).rejects.toMatchObject(denied);
      expect(await log()).toBe('');
      await hd.actions.selectOption({ label: 'Bulk action' }, ['Archive'], ctx);
      expect(await log()).toBe('select:archive;');
    });

    it('leaves safe actions alone', async () => {
      await open();
      await hd.actions.press('Enter', { role: 'button', name: 'Save profile' }, ctx);
      await hd.actions.fill({ label: 'Search' }, 'invoices', { submit: true }, ctx);
      expect(await log()).toBe('safe-button;search;');
    });

    it('denies a workflow press step on a destructive button', async () => {
      const run = await new WorkflowEngine(hd).execute({
        name: 'Gate press',
        steps: [
          { id: 'open', session: 'gate', action: 'navigate', input: { url: `${base}/policy-gate` } },
          {
            id: 'enter',
            session: 'gate',
            action: 'press',
            input: { key: 'Enter', role: 'button', name: 'Delete account' },
          },
        ],
      });
      expect(run.status).toBe('failed');
      expect(run.failure?.stepId).toBe('enter');
      expect(run.failure?.code).toBe('PERMISSION_DENIED');
      expect(await log()).toBe('');
    });

    it('prompts once and proceeds when the human approves (destructive=ask)', async () => {
      const ha = testHarness();
      try {
        await ha.createSession({ name: 'gate' });
        await ha.session('gate').navigate(`${base}/policy-gate`);
        const prompts: string[] = [];
        const details: string[] = [];
        ha.setApprovalHandler(async (r) => {
          prompts.push(r.title);
          details.push(r.detail);
          return 'approved';
        });
        await ha.actions.press('Enter', { role: 'button', name: 'Delete account' }, ctx);
        expect(await ha.session('gate').raw.page().page.locator('#log').textContent()).toBe('button;');
        await ha.actions.fill({ label: 'Reason' }, 'moving', { submit: true }, ctx);
        await ha.session('gate').raw.page().page.waitForURL(/\/policy-gate\/submitted/);
        // One prompt per action; for fill+submit the title names the effective destructive target (the
        // form's default submit button), not the harmless "Reason" field the agent addressed.
        expect(prompts).toEqual(['Press Enter on "Delete account"', 'Submit "Delete account permanently"']);
        expect(details[1]).toContain('Enter from "Reason" submits the form via its default button');
      } finally {
        await ha.close();
      }
    });
  });

  it('enforces an allowlist when configured', async () => {
    const h2 = testHarness({ security: { allowedDomains: ['example.com'], allowLocalhost: false } });
    try {
      const s = await h2.createSession({ name: 'allow' });
      await expect(s.navigate(`${base}/`)).rejects.toMatchObject({ code: 'DOMAIN_NOT_ALLOWED' });
    } finally {
      await h2.close();
    }
  });

  it('limits resources (sessions per harness)', async () => {
    const h3 = testHarness({ security: { maxSessions: 1 } });
    try {
      await h3.createSession({ name: 'one' });
      await expect(h3.createSession({ name: 'two' })).rejects.toMatchObject({
        code: 'RESOURCE_LIMIT_EXCEEDED',
      });
      await expect(h3.createSession({ name: '../evil' })).rejects.toThrow(/Invalid session name/);
    } finally {
      await h3.close();
    }
  });

  it('classifies connection failures', async () => {
    const srv = http.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    await new Promise<void>((r) => srv.close(() => r()));
    const s = await h.createSession({ name: 'neterr' });
    await expect(s.navigate(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({
      code: 'NETWORK_CONNECTION_FAILED',
      retryable: true,
    });
  });
});
