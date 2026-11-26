import { describe, expect, it } from 'vitest';
import { compareGuards, isSensitiveDescription } from '../../src/snapshot/guard.js';
import type { RefGuard } from '../../src/snapshot/injected.js';
const guard: RefGuard = { role: 'button', tag: 'button', name: 'Approve', keys: {}, rowKey: 'REQ001' };
describe('ref identity policy', () => {
  it('rejects recycled rows for every intent, with old/new context', () => {
    for (const intent of ['read', 'input', 'action'] as const) {
      expect(() => compareGuards(guard, { ...guard, rowKey: 'REQ009' }, intent)).toThrowError(
        expect.objectContaining({
          code: 'TARGET_CHANGED',
          context: { old: guard, new: { ...guard, rowKey: 'REQ009' } },
          suggestion: expect.stringContaining('browser_snapshot'),
        }),
      );
    }
  });
  it('rejects structural changes and changed keys/containers', () => {
    expect(() => compareGuards(guard, { ...guard, tag: 'a' }, 'action')).toThrowError(
      expect.objectContaining({ code: 'STALE_ELEMENT_REFERENCE' }),
    );
    for (const patch of [{ keys: { id: 'different' } }, { container: 'dialog:Other' }])
      expect(() => compareGuards(guard, { ...guard, ...patch }, 'read')).toThrowError(
        expect.objectContaining({ code: 'TARGET_CHANGED' }),
      );
  });
  it('allows counter reads and keyed input renames, but never changed action labels', () => {
    expect(() => compareGuards(guard, { ...guard, name: 'Count 2' }, 'read')).not.toThrow();
    expect(() => compareGuards(guard, { ...guard, name: 'Reject' }, 'action')).toThrow();
    const input = { ...guard, tag: 'input', role: 'textbox', keys: { name: 'amount' } };
    expect(() => compareGuards(input, { ...input, name: 'Amount (required)' }, 'input')).not.toThrow();
    expect(() =>
      compareGuards({ ...input, keys: {} }, { ...input, keys: {}, name: 'Other' }, 'input'),
    ).toThrow();
  });
  it('masks passwords and sensitive labels independently of page masking', () => {
    const desc = { role: 'textbox', tag: 'input', name: '', editable: true, connected: true };
    expect(isSensitiveDescription({ ...desc, inputType: 'password' }, [])).toBe(true);
    expect(isSensitiveDescription({ ...desc, label: 'API token' }, ['token'])).toBe(true);
    expect(isSensitiveDescription(desc, ['token'])).toBe(false);
  });
});
