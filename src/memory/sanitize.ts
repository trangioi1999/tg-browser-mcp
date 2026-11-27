/**
 * Untrusted-text controls for Browser Memory (doc 06 §2.3, doc 11 §3). Everything stored in memory comes
 * from web pages: it is length-limited, stripped of control / zero-width / bidi characters and normalized
 * so that record data (numbers, ids, emails, dates, tokens) does not end up in the database.
 */
export const MAX_LABEL = 200;

// C0/C1 controls, zero-width, bidi overrides/isolates, line/paragraph separators, BOM.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/** Strips control characters, collapses whitespace and caps the length. No volatile normalization. */
export function cleanText(input: unknown, max = MAX_LABEL): string {
  const s = String(input ?? '')
    .normalize('NFC')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Replaces data-like tokens with placeholders: emails → `:email`, UUIDs / long hex → `:id`, dates/times →
 * `:date`, high-entropy tokens → `:token`, remaining digit groups → `#`.
 */
export function normalizeVolatile(input: string): string {
  return input
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, ':email')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ':id')
    .replace(/\b\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\b/g, ':date')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ':date')
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g, ':token')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{12,}\b/gi, ':id')
    .replace(/\d+(?:[.,]\d+)*/g, '#');
}

/** Label as stored in memory: cleaned, normalized and capped (≤ 200 chars). */
export function memoryLabel(input: unknown, max = MAX_LABEL): string {
  return cleanText(normalizeVolatile(cleanText(input, max * 2)), max);
}

/** Placeholders are often example data: dropped when they contain ≥ 4 digits or an `@` (doc 06 §3). */
export function safePlaceholder(input: unknown): string | undefined {
  const s = cleanText(input, 80);
  if (!s || /@/.test(s) || (s.match(/\d/g) ?? []).length >= 4) return undefined;
  return memoryLabel(s, 80);
}

const GENERATED_ID = [
  /^mat-[a-z-]*\d+$/i,
  /^cdk-/i,
  /^ng-/i,
  /^:r[0-9a-z]+:$/i,
  /^[0-9a-f-]{12,}$/i,
  /\d{3,}/,
  /^(?:react|radix|headlessui|mui|ember|ext|yui|jsx|el|id)[-_:]?\d+/i,
];

/** Stable-looking ids only (doc 03 §5, doc 07 §3 pass 3): framework-generated or data-bearing ids are dropped. */
export function isStableId(id: string): boolean {
  return /^[A-Za-z][\w-]{0,63}$/.test(id) && !GENERATED_ID.some((r) => r.test(id));
}

/** Attribute keys (test id, formcontrolname, name): cleaned, digits normalized, ≤ 100 chars. */
export function memoryKey(input: unknown): string | undefined {
  const s = cleanText(input, 100);
  if (!s) return undefined;
  return normalizeVolatile(s);
}
