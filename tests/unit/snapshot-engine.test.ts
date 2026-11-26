import { expect, it, vi } from 'vitest';
import type { Frame, Page } from 'playwright';
import { captureSnapshot } from '../../src/snapshot/snapshot-engine.js';
import { RefRegistry } from '../../src/snapshot/element-reference.js';

it.each(['exception', 'corrupt payload'])(
  'does not turn a collection %s into an empty snapshot',
  async (failure) => {
    const evaluate = vi.fn().mockResolvedValueOnce(undefined);
    if (failure === 'exception') evaluate.mockRejectedValueOnce(new Error('Poisoned serializer'));
    else evaluate.mockResolvedValueOnce(undefined);
    const frame = { evaluate } as unknown as Frame;
    const page = { mainFrame: () => frame } as unknown as Page;
    await expect(
      captureSnapshot(page, new RefRegistry(), {
        maxDepth: 40,
        maxTextLength: 200,
        includeText: true,
        sensitiveKeys: [],
        maxChars: 4000,
      }),
    ).rejects.toMatchObject({ code: 'ACTION_FAILED', message: 'Snapshot collection failed' });
    expect(evaluate).toHaveBeenCalledTimes(2);
  },
);

it('marks a snapshot incomplete when navigation prevents both collection attempts', async () => {
  const frame = {
    evaluate: vi.fn().mockRejectedValue(new Error('Execution context was destroyed')),
  } as unknown as Frame;
  const page = {
    mainFrame: () => frame,
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    url: () => '',
    title: async () => '',
  } as unknown as Page;
  const result = await captureSnapshot(page, new RefRegistry(), {
    maxDepth: 40,
    maxTextLength: 200,
    includeText: true,
    sensitiveKeys: [],
    maxChars: 4000,
  });
  expect(result.complete).toBe(false);
});
