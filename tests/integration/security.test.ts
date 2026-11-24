import http from 'node:http';
import path from 'node:path';
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
    const ok = await s.screenshot({ path: path.join(h.config.dataDir, 'ok.png') });
    expect(ok.path).toContain('ok.png');
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
