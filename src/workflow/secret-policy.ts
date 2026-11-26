/** Secret references are capabilities, allowed only at explicit text-entry destinations. */
export const SECRET_REFERENCE = /\$\{(?:secret\.[A-Za-z0-9_.]+|(?:env\.)?TG_SECRET_[A-Za-z0-9_]+)\}/;

/** Path relative to step.input; never grants access to a field's target metadata. */
export function isSecretValuePath(action: string, parts: string[]): boolean {
  return (
    (parts.length === 1 &&
      ((action === 'fill' && parts[0] === 'value') || (action === 'type' && parts[0] === 'text'))) ||
    (action === 'fill_form' &&
      parts.length === 3 &&
      parts[0] === 'fields' &&
      /^\d+$/.test(parts[1]!) &&
      parts[2] === 'value')
  );
}

export function secretUsageErrors(value: unknown, allowSecrets = true): string[] {
  const errors: string[] = [];
  function visit(v: unknown, parts: string[], action?: string): void {
    if (typeof v === 'string' && SECRET_REFERENCE.test(v)) {
      const allowed =
        parts[0] === 'steps' && parts[2] === 'input' && isSecretValuePath(action ?? '', parts.slice(3));
      if (!allowSecrets || !allowed)
        errors.push(
          `${parts.join('.')}: secrets are only allowed in fill.value/type.text/fill_form field values${!allowSecrets ? '; inline secrets are disabled' : ''}`,
        );
    } else if (Array.isArray(v)) v.forEach((x, i) => visit(x, [...parts, String(i)], action));
    else if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      for (const [k, x] of Object.entries(obj)) {
        if (SECRET_REFERENCE.test(k)) errors.push('Secret references are forbidden in property names');
        visit(x, [...parts, k], parts.length === 2 && parts[0] === 'steps' ? String(obj.action) : action);
      }
    }
  }
  visit(value, []);
  return errors;
}
