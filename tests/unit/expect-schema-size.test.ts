import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { selectTools } from '../../src/server/tool-registry.js';
describe('expect schema budget', () => {
  it.each(['minimal', 'developer', 'testing', 'full'] as const)(
    '%s adds at most 1500 characters',
    (profile) => {
      const selected = selectTools(ALL_TOOLS, { profile, enabled: [], disabled: [] });
      const measure = (withExpect: boolean) =>
        JSON.stringify(
          selected.map((t) => {
            const input = { ...t.input };
            if (!withExpect) delete input.expect;
            return {
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: z.toJSONSchema(z.object(input)),
            };
          }),
        ).length;
      expect(measure(true) - measure(false)).toBeLessThanOrEqual(1500);
    },
  );
  it('rejects invalid expectation objects before dispatch', () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'browser_click')!;
    expect(
      z.object(tool.input).safeParse({ role: 'button', expect: [{ type: 'response', status: 'bad' }] })
        .success,
    ).toBe(false);
    expect(
      z
        .object(tool.input)
        .safeParse({ role: 'button', expect: [{ type: 'response', urlPattern: '*/api/*', status: 200 }] })
        .success,
    ).toBe(true);
  });
});
