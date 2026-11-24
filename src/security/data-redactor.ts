/**
 * Deterministic redaction of secrets/PII in text, headers, URLs and JSON payloads.
 */

const DEFAULT_SENSITIVE_KEYS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'authorization',
  'cookie',
  'set-cookie',
  'session',
  'otp',
  'pin',
  'cvv',
  'cvc',
  'card',
  'ssn',
  'x-api-key',
  'client_secret',
  'private_key',
];

/**
 * Query parameters that carry credentials or signed-URL material. Checked only in URLs, because
 * names such as "key" or "sig" are far too common as JSON field names to redact everywhere.
 */
const SENSITIVE_QUERY_PARAMS = new Set([
  'key', // Google APIs (?key=AIza…)
  'code',
  'state',
  'sig',
  'signature',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  'x-goog-signature',
  'x-goog-credential',
  'sv', // Azure SAS (with sig)
  'se',
  'auth',
  'jwt',
]);

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
]);

const PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[REDACTED_NUMBER]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]'],
  [/\b(sk|pk|rk|ghp|gho|xox[abpr])[-_][A-Za-z0-9-_]{16,}\b/g, '[REDACTED_KEY]'],
];

export class DataRedactor {
  private readonly keys: string[];

  constructor(extraSensitive: string[] = []) {
    this.keys = [...DEFAULT_SENSITIVE_KEYS, ...extraSensitive.map((s) => s.toLowerCase())];
  }

  isSensitiveKey(key: string): boolean {
    // Tokenize camelCase / snake / kebab keys so short keys ("pin", "otp") only match whole tokens
    // (avoids redacting "shipping"), while long keys ("password") match as substrings.
    const tokens = key
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const k = tokens.join('_');
    const flat = tokens.join('');
    return this.keys.some((raw) => {
      const s = raw.replace(/-/g, '_');
      if (k === s) return true;
      if (s.length <= 4) return tokens.includes(s);
      return k.includes(s) || flat.includes(s.replace(/_/g, ''));
    });
  }

  /** Redacts tokens, JWTs, card-like numbers and emails in free text. */
  text(s: string, opts: { emails?: boolean } = {}): string {
    let out = s;
    for (const [re, rep] of PATTERNS) {
      if (rep === '[REDACTED_EMAIL]' && opts.emails === false) continue;
      out = out.replace(re, rep);
    }
    return out;
  }

  headers(h: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
      out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) || this.isSensitiveKey(k) ? '[REDACTED]' : this.text(v);
    }
    return out;
  }

  /** Redacts sensitive query parameter values while keeping the URL readable. */
  url(raw: string): string {
    try {
      const u = new URL(raw);
      if (u.username) u.username = 'REDACTED';
      if (u.password) u.password = 'REDACTED';
      for (const key of [...u.searchParams.keys()]) {
        if (this.isSensitiveKey(key) || SENSITIVE_QUERY_PARAMS.has(key.toLowerCase()))
          u.searchParams.set(key, 'REDACTED');
      }
      return u.toString();
    } catch {
      return this.text(raw);
    }
  }

  /** Deep redaction for JSON-like values. */
  value(v: unknown, depth = 0): unknown {
    if (depth > 12) return '[TRUNCATED]';
    if (typeof v === 'string') return this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.value(x, depth + 1));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        out[k] = this.isSensitiveKey(k) ? '[REDACTED]' : this.value(x, depth + 1);
      }
      return out;
    }
    return v;
  }

  /** Redacts a request/response body (JSON if parseable, otherwise text). */
  body(raw: string, maxBytes: number): string {
    const clipped =
      raw.length > maxBytes ? `${raw.slice(0, maxBytes)}…[truncated ${raw.length - maxBytes} bytes]` : raw;
    try {
      return JSON.stringify(this.value(JSON.parse(raw))).slice(0, maxBytes);
    } catch {
      return this.text(clipped);
    }
  }
}
