import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserShortcut, loadConfig, parseConfig } from '../../src/config/load-config.js';
import { tmpDir } from '../helpers.js';

describe('config', () => {
  it('applies secure defaults', () => {
    const c = parseConfig({});
    expect(c.security.allowPrivateNetwork).toBe(false);
    expect(c.security.allowLocalhost).toBe(true);
    expect(c.network.tls.verify).toBe(true);
    expect(c.network.capture.captureBodies).toBe(false);
    expect(c.tools.profile).toBe('developer');
    expect(c.security.approval.destructivePatterns.length).toBeGreaterThan(0);
    expect(c.security.fileAccess.allowedRoots.length).toBe(2);
  });

  it('rejects disabling TLS verification', () => {
    expect(() => parseConfig({ network: { tls: { verify: false } } } as never)).toThrow(
      /CONFIG_INVALID|Invalid configuration/,
    );
  });

  it('rejects unknown profile with actionable message', () => {
    expect(() => parseConfig({ tools: { profile: 'everything' } } as never)).toThrow(/tools\.profile/);
  });

  it('honours precedence defaults < file < env < cli', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'tg-browser.config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ project: 'from-file', tools: { profile: 'minimal' }, browser: { headless: false } }),
    );
    let r = loadConfig({ configPath: file }, {});
    expect(r.config.project).toBe('from-file');
    expect(r.config.tools.profile).toBe('minimal');
    r = loadConfig({ configPath: file }, { TG_BROWSER_PROFILE: 'testing', TG_BROWSER_HEADLESS: 'true' });
    expect(r.config.tools.profile).toBe('testing');
    expect(r.config.browser.headless).toBe(true);
    r = loadConfig(
      { configPath: file, profile: 'full', headless: false },
      { TG_BROWSER_PROFILE: 'testing', TG_BROWSER_HEADLESS: 'true' },
    );
    expect(r.config.tools.profile).toBe('full');
    expect(r.config.browser.headless).toBe(false);
    expect(r.file).toBe(file);
  });

  it('reports invalid JSON files', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{ nope');
    expect(() => loadConfig({ configPath: file }, {})).toThrow(/Invalid JSON/);
  });

  it('maps browser shortcuts', () => {
    expect(browserShortcut('edge')).toEqual({ engine: 'chromium', channel: 'msedge' });
    expect(browserShortcut('chromium')).toEqual({ engine: 'chromium', channel: null });
    expect(browserShortcut('firefox').engine).toBe('firefox');
    expect(() => browserShortcut('netscape')).toThrow();
  });

  it('expands ~ in paths', () => {
    const c = parseConfig({ dataDir: '~/x-tg' });
    expect(c.dataDir.startsWith('~')).toBe(false);
  });
});
