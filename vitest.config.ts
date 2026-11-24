import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Browser tests launch real browsers; keep files sequential to avoid resource contention.
    fileParallelism: false,
    env: { TG_LOG_LEVEL: 'silent' },
  },
});
