import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserHarness } from '../src/harness/browser-harness.js';
import type { TgConfigInput } from '../src/config/schema.js';

export function tmpDir(prefix = 'tgb-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testHarness(overrides: TgConfigInput = {}): BrowserHarness {
  const dataDir = tmpDir();
  return new BrowserHarness({
    dataDir,
    logLevel: 'silent',
    ...overrides,
    browser: { headless: true, ...(overrides.browser ?? {}) },
    security: {
      maxSessions: 30,
      fileAccess: { allowedRoots: [dataDir, process.cwd()] },
      ...(overrides.security ?? {}),
    },
  });
}
