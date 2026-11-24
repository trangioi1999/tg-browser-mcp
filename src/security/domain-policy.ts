import dns from 'node:dns/promises';
import net from 'node:net';
import type { TgConfig } from '../config/schema.js';
import { TgError } from '../shared/errors.js';

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

/** Cloud metadata endpoints: blocked unconditionally, regardless of allowlists. */
const METADATA_HOSTS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  'fd00:ec2::254',
  '100.100.100.200',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
]);

const ALWAYS_SAFE_SCHEMES = new Set(['about:', 'data:', 'blob:']);
const WEB_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

export function matchHost(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase().trim();
  const h = host.toLowerCase();
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  return h === p;
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Returns the embedded IPv4 address of an IPv4-mapped/compatible IPv6 address in either textual
 * form (::ffff:1.2.3.4 or the WHATWG-normalized hex form ::ffff:102:304), else undefined.
 */
export function mappedIpv4(host: string): string | undefined {
  const h = stripBrackets(host).toLowerCase();
  if (!net.isIPv6(h)) return undefined;
  const m = /^(?:0{0,4}:){0,5}(?::|0{0,4}:)?ffff:(.+)$/.exec(h) ?? /^::(.+)$/.exec(h);
  if (!m) return undefined;
  const rest = m[1]!;
  if (net.isIPv4(rest)) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (!hex) return undefined;
  const a = parseInt(hex[1]!, 16);
  const b = parseInt(hex[2]!, 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

export function isLoopback(host: string): boolean {
  const v4 = mappedIpv4(host);
  if (v4) return v4.startsWith('127.');
  const h = stripBrackets(host).toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (net.isIPv4(h)) return h.startsWith('127.');
  if (net.isIPv6(h)) return h === '::1' || h === '0:0:0:0:0:0:0:1';
  return false;
}

/** Private, link-local, CGNAT, ULA, unspecified, or IPv4-mapped private addresses. */
export function isPrivateIp(ip: string): boolean {
  const h = stripBrackets(ip).toLowerCase();
  if (net.isIPv4(h)) {
    const [a = 0, b = 0] = h.split('.').map(Number);
    return (
      a === 10 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (net.isIPv6(h)) {
    const v4 = mappedIpv4(h);
    if (v4) return isPrivateIp(v4);
    return h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  }
  return false;
}

export function isMetadataHost(host: string): boolean {
  const h = stripBrackets(host).toLowerCase();
  const v4 = mappedIpv4(h);
  return METADATA_HOSTS.has(h) || (!!v4 && METADATA_HOSTS.has(v4));
}

/**
 * Domain/network policy. Evaluated for navigations, redirects, popups and (optionally) every
 * sub-request, so a page cannot pivot the browser to internal targets (SSRF) or cloud metadata.
 *
 * DNS-rebinding defence: hostnames that are not explicitly allowlisted are resolved, and the
 * resolved addresses are checked against loopback/private/metadata rules. Results are cached
 * briefly; the browser performs its own resolution, so this narrows (but cannot fully close)
 * the TOCTOU window. Use `allowedDomains` in high-assurance setups.
 */
export class DomainPolicy {
  private readonly dnsCache = new Map<string, { at: number; addrs: string[] }>();
  private readonly cfg: TgConfig['security'];
  private readonly resolver: (host: string) => Promise<string[]>;

  constructor(cfg: TgConfig['security'], resolver?: (host: string) => Promise<string[]>) {
    this.cfg = cfg;
    this.resolver =
      resolver ??
      (async (host) => {
        const res = await dns.lookup(host, { all: true, verbatim: true });
        return res.map((r) => r.address);
      });
  }

  /** Synchronous checks that need no DNS. Returns undefined when DNS resolution is required. */
  checkStatic(rawUrl: string): PolicyDecision & { needsDns?: boolean; host?: string } {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { allowed: false, reason: 'Invalid URL' };
    }
    if (ALWAYS_SAFE_SCHEMES.has(url.protocol)) return { allowed: true };
    if (url.protocol === 'file:') {
      return this.cfg.allowFileUrls
        ? { allowed: true }
        : { allowed: false, reason: 'file: URLs are disabled by policy' };
    }
    if (!WEB_SCHEMES.has(url.protocol)) {
      return { allowed: false, reason: `Scheme ${url.protocol} is not allowed` };
    }
    if (url.username || url.password) {
      return { allowed: false, reason: 'URLs with embedded credentials are not allowed' };
    }
    const host = stripBrackets(url.hostname.toLowerCase());
    if (isMetadataHost(host))
      return { allowed: false, reason: 'Cloud metadata endpoints are always blocked' };
    if (this.cfg.blockedDomains.some((p) => matchHost(p, host))) {
      return { allowed: false, reason: `Host ${host} is in blockedDomains` };
    }
    const explicitlyAllowed = this.cfg.allowedDomains.some((p) => matchHost(p, host));
    if (this.cfg.allowedDomains.length > 0 && !explicitlyAllowed) {
      // localhost is still permitted with allowLocalhost even when an allowlist is set.
      if (!(this.cfg.allowLocalhost && isLoopback(host))) {
        return { allowed: false, reason: `Host ${host} is not in allowedDomains` };
      }
    }
    if (isLoopback(host)) {
      return this.cfg.allowLocalhost || explicitlyAllowed
        ? { allowed: true }
        : { allowed: false, reason: 'localhost access is disabled (security.allowLocalhost=false)' };
    }
    if (net.isIP(host)) {
      if (isPrivateIp(host) && !this.cfg.allowPrivateNetwork && !explicitlyAllowed) {
        return {
          allowed: false,
          reason: `Private network address ${host} is blocked (security.allowPrivateNetwork=false)`,
        };
      }
      return { allowed: true };
    }
    if (explicitlyAllowed || this.cfg.allowPrivateNetwork) return { allowed: true };
    return { allowed: true, needsDns: true, host };
  }

  async check(rawUrl: string): Promise<PolicyDecision> {
    const s = this.checkStatic(rawUrl);
    if (!s.allowed || !s.needsDns || !s.host) return s.allowed ? { allowed: true } : s;
    const addrs = await this.resolve(s.host);
    if (!addrs) return { allowed: true }; // Unresolvable: let the browser surface the DNS error.
    for (const a of addrs) {
      if (isMetadataHost(a))
        return { allowed: false, reason: `${s.host} resolves to a cloud metadata address` };
      if (isLoopback(a) && !this.cfg.allowLocalhost)
        return { allowed: false, reason: `${s.host} resolves to loopback` };
      if (isPrivateIp(a)) {
        return {
          allowed: false,
          reason: `${s.host} resolves to private address ${a} (possible DNS rebinding / SSRF)`,
        };
      }
    }
    return { allowed: true };
  }

  async assertAllowed(rawUrl: string): Promise<void> {
    const d = await this.check(rawUrl);
    if (!d.allowed) {
      throw new TgError('DOMAIN_NOT_ALLOWED', `Navigation blocked: ${d.reason}`, {
        context: { url: safeUrlForLog(rawUrl) },
      });
    }
  }

  private async resolve(host: string): Promise<string[] | undefined> {
    const hit = this.dnsCache.get(host);
    if (hit && Date.now() - hit.at < 30_000) return hit.addrs;
    try {
      const addrs = await this.resolver(host);
      this.dnsCache.set(host, { at: Date.now(), addrs });
      return addrs;
    } catch {
      return undefined;
    }
  }
}

/** URL without query string/fragment/credentials, for logs and error context. */
export function safeUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    const hadQuery = u.search.length > 0;
    u.search = '';
    u.hash = '';
    return u.toString() + (hadQuery ? '?…' : '');
  } catch {
    return '[invalid-url]';
  }
}
