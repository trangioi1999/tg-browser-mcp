import { describe, expect, it } from 'vitest';
import { DataRedactor } from '../../src/security/data-redactor.js';

describe('DataRedactor', () => {
  const r = new DataRedactor(['nationalId']);
  it('redacts sensitive headers', () => {
    const h = r.headers({
      Authorization: 'Bearer abc',
      Cookie: 'sid=1',
      'Content-Type': 'application/json',
      'X-Api-Key': 'k',
    });
    expect(h.Authorization).toBe('[REDACTED]');
    expect(h.Cookie).toBe('[REDACTED]');
    expect(h['X-Api-Key']).toBe('[REDACTED]');
    expect(h['Content-Type']).toBe('application/json');
  });
  it('redacts URL query secrets and credentials', () => {
    const u = r.url('https://user:pw@x.com/cb?code=abc&state=s&page=2&access_token=t');
    expect(u).not.toContain('abc');
    expect(u).not.toContain('pw');
    expect(u).toContain('page=2');
    expect(u).not.toContain('access_token=t');
  });
  it('redacts JWTs, bearer tokens, card numbers, emails in text', () => {
    const t = r.text(
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U card 4111 1111 1111 1111 mail a.b@corp.com Bearer xyz.abc',
    );
    expect(t).toContain('[REDACTED_JWT]');
    expect(t).toContain('[REDACTED_NUMBER]');
    expect(t).toContain('[REDACTED_EMAIL]');
    expect(t).toContain('Bearer [REDACTED]');
  });
  it('deep-redacts JSON by key, including custom fields', () => {
    const v = r.value({
      user: { name: 'a', password: 'p', nationalId: '123', profile: { refreshToken: 'x' } },
      items: [{ apiKey: 'k' }],
    }) as {
      user: { name: string; password: string; nationalId: string; profile: { refreshToken: string } };
      items: Array<{ apiKey: string }>;
    };
    expect(v.user.password).toBe('[REDACTED]');
    expect(v.user.nationalId).toBe('[REDACTED]');
    expect(v.user.profile.refreshToken).toBe('[REDACTED]');
    expect(v.items[0]?.apiKey).toBe('[REDACTED]');
    expect(v.user.name).toBe('a');
  });
  it('does not over-redact words containing short keys', () => {
    expect(r.isSensitiveKey('shipping')).toBe(false);
    expect(r.isSensitiveKey('dashboard')).toBe(false);
    expect(r.isSensitiveKey('pin')).toBe(true);
    expect(r.isSensitiveKey('cardNumber')).toBe(true);
    expect(r.isSensitiveKey('userPassword')).toBe(true);
  });
  it('clips bodies', () => {
    expect(r.body('x'.repeat(100), 10).length).toBeLessThan(60);
    expect(r.body('{"password":"p","a":1}', 1000)).toBe('{"password":"[REDACTED]","a":1}');
  });
  it('redacts credential query params in URLs but not JSON fields with the same name', () => {
    const u = r.url(
      'https://identitytoolkit.googleapis.com/v1/accounts:signIn?key=AIzaSyFAKEFAKEFAKE00&alt=json',
    );
    expect(u).not.toContain('AIzaSy');
    expect(u).toContain('key=REDACTED');
    expect(u).toContain('alt=json');
    expect(r.url('https://b.s3.amazonaws.com/f?X-Amz-Signature=abc&X-Amz-Credential=AKIA1')).not.toMatch(
      /abc|AKIA1/,
    );
    expect((r.value({ key: 'row-1', items: [{ key: 'a' }] }) as { key: string }).key).toBe('row-1');
  });
});
