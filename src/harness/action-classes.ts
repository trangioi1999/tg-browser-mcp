export type ActionClass = 'read' | 'idempotent-input' | 'non-idempotent' | 'high-impact';

const READ = new Set(['snapshot', 'screenshot', 'get_text', 'assert', 'extract', 'wait']);
const INPUT = new Set(['navigate', 'fill', 'fill_form', 'select', 'check', 'uncheck', 'hover']);
const HIGH_IMPACT = /\b(submit|approve|reject|delete|remove|destroy|pay|payment|purchase|transfer)\b/i;

/** Conservative retry classification; typing appends and unknown actions may mutate state. */
export function classifyAction(action: string, input: Record<string, unknown> = {}): ActionClass {
  if (READ.has(action)) return 'read';
  const target = input.target && typeof input.target === 'object' ? input.target : input;
  if (
    Object.entries(target).some(
      ([key, value]) =>
        ['name', 'label', 'text', 'title'].includes(key) &&
        typeof value === 'string' &&
        HIGH_IMPACT.test(value),
    )
  )
    return 'high-impact';
  if (input.submit) return 'non-idempotent';
  if (INPUT.has(action)) return 'idempotent-input';
  return 'non-idempotent';
}
