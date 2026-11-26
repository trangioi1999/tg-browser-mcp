import { DataRedactor } from '../security/data-redactor.js';
/** Persist only redacted records, including resolved workflow secret environment values. */
export function sanitize<T>(value: T): T {
  const redactor = new DataRedactor();
  const secrets = Object.entries(process.env)
    .filter(([k, v]) => k.startsWith('TG_SECRET_') && v)
    .map(([, v]) => v!);
  const walk = (v: unknown, key = ''): unknown => {
    if (typeof v === 'string') {
      if (redactor.isSensitiveKey(key) && key !== 'session') return '[REDACTED]';
      for (const secret of secrets) v = (v as string).split(secret).join('[secret]');
      return redactor.text((v as string).replace(/https?:\/\/[^\s<>"']+/g, (url) => redactor.url(url)));
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value) as T;
}
