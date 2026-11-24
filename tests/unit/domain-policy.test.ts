import { describe, expect, it } from 'vitest';
import { DomainPolicy, isPrivateIp, matchHost, safeUrlForLog } from '../../src/security/domain-policy.js';
import { parseConfig } from '../../src/config/load-config.js';

const sec = (o: Record<string, unknown> = {}) => parseConfig({ security: o }).security;
const fakeDns = (map: Record<string, string[]>) => async (h: string) => {
  if (!map[h]) throw new Error('ENOTFOUND');
  return map[h]!;
};

describe('DomainPolicy', () => {
  it('always blocks cloud metadata, even when allowlisted', async () => {
    const p = new DomainPolicy(sec({ allowedDomains: ['*'], allowPrivateNetwork: true }));
    for (const u of [
      'http://169.254.169.254/latest/meta-data',
      'http://metadata.google.internal/',
      'http://[fd00:ec2::254]/',
      'http://[::ffff:169.254.169.254]/',
    ]) {
      expect((await p.check(u)).allowed, u).toBe(false);
    }
  });

  it('blocks private networks by default and allows localhost', async () => {
    const p = new DomainPolicy(sec(), fakeDns({}));
    expect((await p.check('http://10.1.2.3/')).allowed).toBe(false);
    expect((await p.check('http://192.168.1.1/')).allowed).toBe(false);
    expect((await p.check('http://localhost:4200/')).allowed).toBe(true);
    expect((await p.check('http://127.0.0.1:4200/')).allowed).toBe(true);
    expect((await p.check('http://[::1]:4200/')).allowed).toBe(true);
  });

  it('can disable localhost', async () => {
    const p = new DomainPolicy(sec({ allowLocalhost: false }));
    expect((await p.check('http://localhost:4200/')).allowed).toBe(false);
  });

  it('enforces allowlist with wildcards and blocklist precedence', async () => {
    const p = new DomainPolicy(
      sec({
        allowedDomains: ['*.corp.local', 'example.com'],
        blockedDomains: ['evil.corp.local'],
        allowLocalhost: false,
      }),
      fakeDns({ 'app.corp.local': ['10.0.0.5'] }),
    );
    expect((await p.check('https://app.corp.local/x')).allowed).toBe(true); // explicitly allowed => private ok
    expect((await p.check('https://example.com/')).allowed).toBe(true);
    expect((await p.check('https://other.com/')).allowed).toBe(false);
    expect((await p.check('https://evil.corp.local/')).allowed).toBe(false);
  });

  it('detects DNS rebinding to private addresses', async () => {
    const p = new DomainPolicy(
      sec(),
      fakeDns({ 'rebind.attacker.com': ['192.168.0.10'], 'ok.com': ['93.184.216.34'] }),
    );
    const d = await p.check('http://rebind.attacker.com/');
    expect(d.allowed).toBe(false);
    expect((await p.check('http://ok.com/')).allowed).toBe(true);
  });

  it('blocks dangerous schemes and credentials in URL', async () => {
    const p = new DomainPolicy(sec());
    expect((await p.check('file:///etc/passwd')).allowed).toBe(false);
    expect((await p.check('javascript:alert(1)')).allowed).toBe(false);
    expect((await p.check('chrome://settings')).allowed).toBe(false);
    expect((await p.check('http://user:pass@example.com/')).allowed).toBe(false);
    expect((await p.check('about:blank')).allowed).toBe(true);
    expect((await p.check('not a url')).allowed).toBe(false);
  });

  it('helpers', () => {
    expect(matchHost('*.a.com', 'x.a.com')).toBe(true);
    expect(matchHost('*.a.com', 'a.com')).toBe(true);
    expect(matchHost('*.a.com', 'xa.com')).toBe(false);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.32.0.1')).toBe(false);
    expect(isPrivateIp('100.64.0.1')).toBe(true);
    expect(safeUrlForLog('https://u:p@x.com/a?token=1#h')).toBe('https://x.com/a?…');
  });
});

describe('IPv4-mapped IPv6', () => {
  it('normalizes hex and dotted forms', async () => {
    const { mappedIpv4 } = await import('../../src/security/domain-policy.js');
    expect(mappedIpv4('[::ffff:a9fe:a9fe]')).toBe('169.254.169.254');
    expect(mappedIpv4('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(mappedIpv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(mappedIpv4('2001:db8::1')).toBeUndefined();
    const p = new DomainPolicy(sec());
    expect((await p.check('http://[::ffff:10.0.0.1]/')).allowed).toBe(false);
    expect((await p.check('http://[::ffff:127.0.0.1]:8080/')).allowed).toBe(true);
  });
});
