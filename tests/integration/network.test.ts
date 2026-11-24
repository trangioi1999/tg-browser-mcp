import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureServer } from '../fixtures/app/server.mjs';
import { createTestProxy } from '../fixtures/test-proxy.js';
import { testHarness } from '../helpers.js';

let app: ReturnType<typeof createFixtureServer>;
let base: string;
let appHost: string;

beforeAll(async () => {
  app = createFixtureServer();
  base = await app.listen();
  appHost = new URL(base).host;
});
afterAll(async () => {
  await app?.close();
});

describe('proxy & enterprise network (local test proxy)', () => {
  it('routes browser traffic through an authenticated proxy using env credentials', async () => {
    const proxy = createTestProxy({
      user: 'alice',
      pass: 's3cret',
      rewrite: { 'intranet.test': appHost, 'intranet.test:80': appHost },
    });
    const proxyUrl = await proxy.listen();
    process.env.TGT_PROXY_USER = 'alice';
    process.env.TGT_PROXY_PASS = 's3cret';
    const h = testHarness({
      network: {
        mode: 'manual',
        proxy: {
          enabled: true,
          server: proxyUrl,
          usernameEnv: 'TGT_PROXY_USER',
          passwordEnv: 'TGT_PROXY_PASS',
          bypass: [],
        },
      },
      // intranet.test only resolves through the proxy; allow it explicitly.
      security: { allowedDomains: ['intranet.test'] },
    });
    try {
      const s = await h.createSession({ name: 'proxied' });
      const r = await s.navigate('http://intranet.test/login');
      expect(r.pageState).toContain('heading "Sign in"');
      expect(proxy.seen.some((x) => x.startsWith('GET intranet.test/login'))).toBe(true);
      const st = h.proxy.status();
      expect(st.authenticated).toBe(true);
      expect(JSON.stringify(st)).not.toContain('s3cret');
      const diag = await h.diagnose('http://intranet.test/login');
      expect(diag.viaProxy).toBe(proxyUrl);
      expect(diag.steps.map((x) => `${x.step}:${x.ok}`)).toEqual(['policy:true', 'proxy:true', 'http:true']);
    } finally {
      await h.close();
      await proxy.close();
    }
  });

  it('diagnoses proxy authentication failures', async () => {
    const proxy = createTestProxy({ user: 'alice', pass: 'right' });
    const proxyUrl = await proxy.listen();
    const h = testHarness({
      network: { mode: 'manual', proxy: { enabled: true, server: proxyUrl, bypass: [] } },
      security: { allowedDomains: ['intranet.test'] },
    });
    try {
      const d = await h.diagnose('http://intranet.test/');
      expect(d.ok).toBe(false);
      expect(d.steps.find((x) => x.step === 'proxy')).toMatchObject({
        ok: false,
        code: 'NETWORK_PROXY_FAILED',
      });
      expect(d.conclusion).toContain('407');
    } finally {
      await h.close();
      await proxy.close();
    }
  });

  it('diagnoses direct connections, DNS failures and policy blocks', async () => {
    const h = testHarness();
    try {
      const ok = await h.diagnose(`${base}/`);
      expect(ok.ok).toBe(true);
      expect(ok.steps.map((x) => x.step)).toEqual(['policy', 'dns', 'tcp', 'http']);
      const dns = await h.diagnose('http://does-not-exist.invalid/');
      expect(dns.steps.find((x) => x.step === 'dns')).toMatchObject({
        ok: false,
        code: 'NETWORK_DNS_FAILED',
      });
      const blocked = await h.diagnose('http://169.254.169.254/');
      expect(blocked.steps[0]).toMatchObject({ step: 'policy', ok: false, code: 'DOMAIN_NOT_ALLOWED' });
    } finally {
      await h.close();
    }
  });

  it('captures and filters network activity', async () => {
    const h = testHarness();
    try {
      const s = await h.createSession({ name: 'net' });
      await s.navigate(`${base}/dynamic`);
      await s.click({ role: 'button', name: 'Load items' });
      const m = s.raw.monitor;
      expect(m.network({ url: '/api/items' }).entries[0]).toMatchObject({
        method: 'GET',
        status: 200,
        resourceType: 'fetch',
      });
      expect(m.network({ resourceType: 'document' }).total).toBeGreaterThan(0);
      expect(m.network({ method: 'POST' }).total).toBe(0);
      const seq = m.lastSeq;
      await s.click({ role: 'button', name: 'Load items' });
      expect(m.network({ sinceSeq: seq }).total).toBe(1);
    } finally {
      await h.close();
    }
  });
});
