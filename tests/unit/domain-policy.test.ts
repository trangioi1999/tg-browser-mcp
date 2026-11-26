import { describe, expect, it, vi } from 'vitest';
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

describe('mandatory DNS metadata checks', () => {
  const addresses = [
    '169.254.169.254',
    '169.254.170.2',
    '100.100.100.200',
    'fd00:ec2::254',
    'fd00:0ec2:0:0:0:0:0:0254',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
  ];
  for (const allowedDomains of [[], ['*'], ['alias.test'], ['*.test']]) {
    for (const allowPrivateNetwork of [false, true]) {
      for (const allowLocalhost of [false, true]) {
        it(`denies metadata for ${JSON.stringify({ allowedDomains, allowPrivateNetwork, allowLocalhost })}`, async () => {
          for (const address of addresses) {
            const p = new DomainPolicy(
              sec({ allowedDomains, allowPrivateNetwork, allowLocalhost }),
              fakeDns({ 'alias.test': ['93.184.216.34', address] }),
            );
            expect(await p.check('https://alias.test/'), address).toMatchObject({
              allowed: false,
              reason: expect.stringContaining('metadata'),
            });
          }
        });
      }
    }
  }

  it('also resolves localhost names before permitting access', async () => {
    const p = new DomainPolicy(sec(), fakeDns({ localhost: ['169.254.169.254'] }));
    expect(await p.check('http://localhost/')).toMatchObject({ allowed: false });
  });

  it('preserves private and loopback configuration and allowlist exemptions', async () => {
    for (const allowedDomains of [[], ['alias.test']]) {
      for (const allowPrivateNetwork of [false, true]) {
        for (const allowLocalhost of [false, true]) {
          for (const address of ['10.0.0.1', '127.0.0.1', '::1']) {
            const p = new DomainPolicy(
              sec({ allowedDomains, allowPrivateNetwork, allowLocalhost }),
              fakeDns({ 'alias.test': [address] }),
            );
            expect((await p.check('https://alias.test/')).allowed).toBe(
              allowedDomains.length > 0 || (address === '10.0.0.1' ? allowPrivateNetwork : allowLocalhost),
            );
          }
        }
      }
    }
  });
});

it('caches DNS results for 30 seconds, then rechecks metadata', async () => {
  vi.useFakeTimers();
  try {
    const resolver = vi.fn().mockResolvedValueOnce(['93.184.216.34']).mockResolvedValue(['169.254.169.254']);
    const p = new DomainPolicy(sec({ allowedDomains: ['*'], allowPrivateNetwork: true }), resolver);
    expect((await p.check('https://alias.test/')).allowed).toBe(true);
    vi.advanceTimersByTime(29_999);
    expect((await p.check('https://alias.test/')).allowed).toBe(true);
    expect(resolver).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect((await p.check('https://alias.test/')).allowed).toBe(false);
    expect(resolver).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
