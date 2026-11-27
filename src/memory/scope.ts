import { SAFE_NAME } from '../shared/util.js';

/** Isolation key of all memory rows (doc 06 §2.5). */
export interface ScopeKey {
  project: string;
  origin: string;
  environment: string;
  /** Caller-declared label (e.g. `maker`); never derived from cookies or tokens. */
  authContext: string;
}

/** Normalized `scheme://host[:port]` for http(s) pages; other schemes are never remembered. */
export function normalizeOrigin(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  return `${u.protocol}//${u.host.toLowerCase()}`;
}

export function isScopeLabel(v: string): boolean {
  return SAFE_NAME.test(v);
}

/** Resolves the scope of a page URL. Labels come from configuration / the SDK caller, not from model args. */
export function resolveScope(
  url: string,
  labels: { project: string; environment: string; authContext: string },
): ScopeKey | undefined {
  const origin = normalizeOrigin(url);
  if (!origin) return undefined;
  for (const v of [labels.project, labels.environment, labels.authContext])
    if (!isScopeLabel(v)) return undefined;
  return { origin, ...labels };
}
