import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureServer } from '../fixtures/app/server.mjs';
import { testHarness, tmpDir } from '../helpers.js';

let app: ReturnType<typeof createFixtureServer>;
let base: string;
beforeAll(async () => {
  app = createFixtureServer();
  base = await app.listen();
});
afterAll(async () => {
  await app?.close();
});

const freePort = () =>
  new Promise<number>((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });

describe('browser lifecycle', () => {
  it('persists a dedicated profile across restarts', async () => {
    const dataDir = tmpDir();
    const mk = () =>
      testHarness({ dataDir, browser: { persistent: true, userDataDir: path.join(dataDir, 'profile') } });
    let h = mk();
    let s = await h.createSession({ name: 'default', persistent: true });
    await s.navigate(`${base}/login`);
    await s.fill({ label: 'Username' }, 'maker');
    await s.fill({ label: 'Password' }, 'maker123');
    await s.click({ role: 'button', name: 'Sign in' });
    await h.close();
    expect(fs.existsSync(path.join(dataDir, 'profile'))).toBe(true);
    h = mk();
    s = await h.createSession({ name: 'default', persistent: true });
    await s.navigate(`${base}/api/whoami`);
    expect(await s.text()).toContain('"maker"');
    await h.close();
  });

  it('connects to an existing Chromium over CDP (localhost only) and refuses remote endpoints', async () => {
    const port = await freePort();
    const external = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: [`--remote-debugging-port=${port}`],
    });
    const h = testHarness({ security: { approval: { highRisk: 'allow' } } });
    try {
      const s = await h.sessions.connect(`http://127.0.0.1:${port}`, 'cdp');
      expect(s.connected).toBe(true);
      await h.actions.navigate(`${base}/`, { session: 'cdp' });
      expect((await h.actions.pageInfo({ session: 'cdp' })).title).toBe('Home');
      await expect(h.sessions.connect('http://10.0.0.5:9222', 'remote')).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
      await h.sessions.close('cdp');
      expect(external.isConnected()).toBe(true); // user's browser keeps running
    } finally {
      await h.close();
      await external.close();
    }
  });

  it('detects a crashed/closed browser and relaunches on next use', async () => {
    const h = testHarness();
    try {
      const s1 = await h.createSession({ name: 'a' });
      await s1.navigate(`${base}/`);
      const id = h.browsers.list()[0]!.id;
      const closed = new Promise((r) => h.events.on('browser.closed', r));
      await s1.raw.context.browser()!.close();
      await closed;
      expect(h.browsers.list().find((b) => b.id === id)).toBeUndefined();
      await expect(h.actions.navigate(`${base}/`, { session: 'a' })).rejects.toMatchObject({
        code: expect.stringMatching(/SESSION_NOT_FOUND|BROWSER_DISCONNECTED/),
      });
      const s2 = await h.createSession({ name: 'b' });
      const r = await s2.navigate(`${base}/`);
      expect(r.pageState).toContain('Acme Business Process Automation');
    } finally {
      await h.close();
    }
  });

  it('fails clearly when the requested browser is not installed', async () => {
    const h = testHarness({ browser: { executablePath: '/nonexistent/chrome' } });
    try {
      await expect(h.createSession({ name: 'x' })).rejects.toMatchObject({ code: 'BROWSER_NOT_FOUND' });
    } finally {
      await h.close();
    }
  });
});
