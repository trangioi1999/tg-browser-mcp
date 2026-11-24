import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

export interface DetectedBrowser {
  id: string;
  /** True for Chromium's headless shell, which cannot run headed. */
  headlessOnly?: boolean;
  name: string;
  engine: 'chromium' | 'firefox' | 'webkit';
  channel: string | null;
  executablePath: string;
  source: 'system' | 'playwright';
}

type Candidate = Omit<DetectedBrowser, 'executablePath' | 'source'> & { paths: string[] };

function systemCandidates(): Candidate[] {
  const platform = process.platform;
  const pf = process.env.PROGRAMFILES ?? 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');

  if (platform === 'darwin') {
    return [
      {
        id: 'chrome',
        name: 'Google Chrome',
        engine: 'chromium',
        channel: 'chrome',
        paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      },
      {
        id: 'chrome-beta',
        name: 'Google Chrome Beta',
        engine: 'chromium',
        channel: 'chrome-beta',
        paths: ['/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'],
      },
      {
        id: 'msedge',
        name: 'Microsoft Edge',
        engine: 'chromium',
        channel: 'msedge',
        paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      },
    ];
  }
  if (platform === 'win32') {
    return [
      {
        id: 'chrome',
        name: 'Google Chrome',
        engine: 'chromium',
        channel: 'chrome',
        paths: [pf, pf86, local].map((b) => path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      },
      {
        id: 'msedge',
        name: 'Microsoft Edge',
        engine: 'chromium',
        channel: 'msedge',
        paths: [pf, pf86, local].map((b) => path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
      },
    ];
  }
  return [
    {
      id: 'chrome',
      name: 'Google Chrome',
      engine: 'chromium',
      channel: 'chrome',
      paths: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
    },
    {
      id: 'chrome-beta',
      name: 'Google Chrome Beta',
      engine: 'chromium',
      channel: 'chrome-beta',
      paths: ['/opt/google/chrome-beta/chrome'],
    },
    {
      id: 'msedge',
      name: 'Microsoft Edge',
      engine: 'chromium',
      channel: 'msedge',
      paths: ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge'],
    },
  ];
}

function safeExecPath(fn: () => string): string | undefined {
  try {
    const p = fn();
    return p && fs.existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

/** Detects installed system browsers (Chrome/Edge) and Playwright-managed browsers. */
export function detectBrowsers(): DetectedBrowser[] {
  const found: DetectedBrowser[] = [];
  for (const c of systemCandidates()) {
    const p = c.paths.find((x) => fs.existsSync(x));
    if (p)
      found.push({
        id: c.id,
        name: c.name,
        engine: c.engine,
        channel: c.channel,
        executablePath: p,
        source: 'system',
      });
  }
  const managed: Array<[string, DetectedBrowser['engine'], () => string]> = [
    ['Playwright Chromium', 'chromium', () => chromium.executablePath()],
    ['Playwright Firefox', 'firefox', () => firefox.executablePath()],
    ['Playwright WebKit', 'webkit', () => webkit.executablePath()],
  ];
  for (const [name, engine, fn] of managed) {
    const p = safeExecPath(fn);
    if (p) found.push({ id: engine, name, engine, channel: null, executablePath: p, source: 'playwright' });
  }
  const shell = findHeadlessShell();
  if (shell)
    found.push({
      id: 'chromium-headless-shell',
      name: 'Playwright Chromium headless shell',
      engine: 'chromium',
      channel: null,
      executablePath: shell,
      source: 'playwright',
      headlessOnly: true,
    });
  return found;
}

/** Playwright's browser cache, honouring PLAYWRIGHT_BROWSERS_PATH. */
function playwrightCacheDir(): string {
  const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (env && env !== '0') return env;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32')
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
      'ms-playwright',
    );
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'ms-playwright');
}

/** The headless shell (installed with `playwright install --only-shell`) is used for headless Chromium. */
function findHeadlessShell(): string | undefined {
  let dirs: string[] = [];
  const base = playwrightCacheDir();
  try {
    dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-'));
  } catch {
    return undefined;
  }
  const exe = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  for (const d of dirs.sort().reverse()) {
    let sub: string[] = [];
    try {
      sub = fs.readdirSync(path.join(base, d));
    } catch {
      continue;
    }
    for (const s of sub) {
      const p = path.join(base, d, s, exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

/** Picks the best available browser for the requested engine/channel, or undefined. */
export function resolveBrowser(
  engine: string,
  channel: string | null,
  detected = detectBrowsers(),
  headless = true,
): DetectedBrowser | undefined {
  if (channel) return detected.find((b) => b.channel === channel);
  return detected.find(
    (b) => b.engine === engine && b.source === 'playwright' && (headless || !b.headlessOnly),
  );
}
