import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
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

/**
 * Whether Playwright's ffmpeg build (needed for video recording) is installed for this Playwright
 * version. Video tests skip with a clear reason instead of failing when it is missing (TGB-011).
 */
export function hasPlaywrightFfmpeg(): boolean {
  try {
    const require = createRequire(import.meta.url);
    const pkgDir = path.dirname(require.resolve('playwright-core/package.json'));
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'browsers.json'), 'utf8')) as {
      browsers: Array<{ name: string; revision: string }>;
    };
    const rev = manifest.browsers.find((b) => b.name === 'ffmpeg')?.revision;
    if (!rev) return false;
    const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const root =
      env === '0'
        ? path.join(pkgDir, '.local-browsers')
        : env
          ? env
          : process.platform === 'darwin'
            ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
            : process.platform === 'win32'
              ? path.join(
                  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
                  'ms-playwright',
                )
              : path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'ms-playwright');
    const dir = path.join(root, `ffmpeg-${rev}`);
    return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith('ffmpeg'));
  } catch {
    return false;
  }
}
