import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserHarness } from '../src/harness/browser-harness.js';
import type { TgConfigInput } from '../src/config/schema.js';

export function tmpDir(prefix = 'tgb-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Creates a symlink for boundary tests. Directories use junctions on Windows (no privilege needed); file links
 * return false where Windows refuses them without Developer Mode, so callers skip only that assertion.
 */
export function trySymlink(target: string, link: string, type: 'file' | 'dir' = 'file'): boolean {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' && type === 'dir' ? 'junction' : type);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw e;
  }
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
