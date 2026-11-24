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
  // Headless in CI, so force the badge on.
  h = testHarness({ browser: { indicator: true } });
});
afterAll(async () => {
  await h?.close();
  await app?.close();
});

describe('"controlled by TG Browser MCP" indicator', () => {
  it('is shown on every page but invisible to the agent and to clicks', async () => {
    const s = await h.createSession({ name: 'maker' });
    const r = await s.navigate(`${base}/dynamic`);
    const page = s.raw.page().page;
    const info = await page.evaluate(() => {
      const host = document.getElementById('__tg-browser-indicator');
      if (!host) return null;
      const box = host.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        ariaHidden: host.getAttribute('aria-hidden'),
        shadowOpen: !!host.shadowRoot,
        hitIsHost: hit === host,
        width: box.width,
      };
    });
    expect(info).toEqual({
      ariaHidden: 'true',
      shadowOpen: false,
      hitIsHost: false,
      width: expect.any(Number),
    });
    expect(info!.width).toBeGreaterThan(20);
    // Not part of snapshots / ARIA tree / diffs.
    expect(r.pageState).not.toContain('TG Browser MCP');
    expect(await h.actions.ariaTree(undefined, { session: 'maker' })).not.toContain('TG Browser MCP');
    const c = await s.click({ role: 'button', name: 'Increment' });
    expect(c.pageState).toContain('"Count: 0" → "Count: 1"');
    expect(c.pageState).not.toContain('TG Browser MCP');
    // Survives navigation.
    await s.navigate(`${base}/login`);
    expect(await page.locator('#__tg-browser-indicator').count()).toBe(1);
  });

  it('is off by default for headless browsers', async () => {
    const h2 = testHarness();
    try {
      const s = await h2.createSession({ name: 'x' });
      await s.navigate(`${base}/`);
      expect(await s.raw.page().page.locator('#__tg-browser-indicator').count()).toBe(0);
    } finally {
      await h2.close();
    }
  });
});
