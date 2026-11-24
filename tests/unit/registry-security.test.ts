import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { selectTools } from '../../src/server/tool-registry.js';
import { parseConfig } from '../../src/config/load-config.js';
import { PermissionManager } from '../../src/security/permission-manager.js';
import { ProxyManager } from '../../src/network/proxy-manager.js';
import { SessionStore } from '../../src/session/session-store.js';
import { TgError, toTgError, classifyNetworkError } from '../../src/shared/errors.js';
import { tmpDir, trySymlink } from '../helpers.js';

describe('tool registry', () => {
  it('has unique, well-formed tools with valid schemas', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of ALL_TOOLS) {
      expect(t.name).toMatch(/^[a-z]+(_[a-z]+)+$/);
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.timeoutMs).toBeGreaterThan(0);
      expect(() => z.object(t.input).safeParse({})).not.toThrow();
    }
  });
  it('covers every tool named in the specification', () => {
    const spec =
      'browser_launch browser_close browser_status browser_list browser_connect browser_disconnect browser_resize browser_navigate browser_back browser_forward browser_reload browser_wait browser_click browser_double_click browser_fill browser_type browser_press_key browser_hover browser_select_option browser_check browser_uncheck browser_drag browser_scroll browser_upload_file browser_snapshot browser_screenshot browser_get_text browser_get_element browser_get_attributes browser_get_title browser_get_url browser_accessibility_tree browser_tabs browser_tab_create browser_tab_switch browser_tab_close browser_frames browser_frame_switch browser_console browser_errors browser_network_requests browser_network_details browser_performance browser_trace_start browser_trace_stop session_create session_list session_switch session_save session_restore session_delete session_status network_diagnose network_proxy_status network_connection_test network_certificate_status workflow_create workflow_record_start workflow_record_stop workflow_execute workflow_validate workflow_list workflow_status workflow_cancel test_assert test_generate test_execute test_report'.split(
        ' ',
      );
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    expect(spec.filter((s) => !names.has(s))).toEqual([]);
  });
  it('selects tools by profile, enabled and disabled lists', () => {
    const minimal = selectTools(ALL_TOOLS, { profile: 'minimal', enabled: [], disabled: [] }).map(
      (t) => t.name,
    );
    for (const n of [
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_fill',
      'browser_wait',
      'browser_screenshot',
    ])
      expect(minimal).toContain(n);
    expect(minimal).not.toContain('browser_console');
    const dev = selectTools(ALL_TOOLS, { profile: 'developer', enabled: [], disabled: [] }).map(
      (t) => t.name,
    );
    expect(dev).toContain('browser_console');
    expect(dev).not.toContain('session_create');
    const testing = selectTools(ALL_TOOLS, {
      profile: 'testing',
      enabled: ['browser_upload_file'],
      disabled: ['browser_drag'],
    }).map((t) => t.name);
    expect(testing).toContain('workflow_execute');
    expect(testing).toContain('browser_upload_file');
    expect(testing).not.toContain('browser_drag');
    const full = selectTools(ALL_TOOLS, { profile: 'full', enabled: [], disabled: [] });
    expect(full.length).toBe(ALL_TOOLS.length);
    expect(minimal.length).toBeLessThan(dev.length);
  });
  it('marks high-risk tools', () => {
    const high = ALL_TOOLS.filter((t) => t.risk === 'high')
      .map((t) => t.name)
      .sort();
    expect(high).toEqual(['browser_connect', 'browser_upload_file']);
  });
});

describe('permission manager', () => {
  const root = tmpDir();
  const cfg = parseConfig({
    security: { fileAccess: { allowedRoots: [root] }, approval: { highRisk: 'deny', destructive: 'ask' } },
  });
  const pm = new PermissionManager(cfg);
  it('blocks path traversal and paths outside roots', () => {
    fs.writeFileSync(path.join(root, 'ok.txt'), 'x');
    expect(pm.checkFilePath(path.join(root, 'ok.txt'), 'read')).toContain('ok.txt');
    expect(() => pm.checkFilePath(path.join(root, '..', 'etc', 'passwd'), 'read')).toThrow(TgError);
    expect(() => pm.checkFilePath('/etc/passwd', 'read')).toThrow(/outside allowed roots|not found/);
    expect(() => pm.checkFilePath(path.join(root, '../../tmp/x.png'), 'write')).toThrow(
      /outside allowed roots/,
    );
  });
  it('blocks symlink escapes', () => {
    // A real directory outside the root: /etc does not exist on Windows, which made the path check fail
    // with "File not found" before the boundary check could run.
    const outside = tmpDir('tgb-outside-');
    fs.writeFileSync(path.join(outside, 'hosts'), 'x');
    const link = path.join(root, 'link');
    if (!trySymlink(outside, link, 'dir')) return;
    expect(() => pm.checkFilePath(path.join(link, 'hosts'), 'read')).toThrow(/outside allowed roots/);
  });
  it('enforces approval modes', async () => {
    await expect(pm.requireApproval('highRisk', 'x', 'y')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(pm.requireApproval('destructive', 'x', 'y')).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    pm.setApprovalHandler(async () => 'approved');
    await expect(pm.requireApproval('destructive', 'x', 'y')).resolves.toBeUndefined();
    pm.setApprovalHandler(async () => 'declined');
    await expect(pm.requireApproval('destructive', 'x', 'y')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });
  it('detects destructive names and denies insecure launch args', () => {
    expect(pm.isDestructiveName('Delete account')).toBe(true);
    expect(pm.isDestructiveName('Approve REQ-1')).toBe(false);
    expect(() => pm.checkLaunchArgs(['--disable-web-security'])).toThrow(/not permitted/);
    expect(() => pm.checkLaunchArgs(['--ignore-certificate-errors'])).toThrow();
    expect(() => pm.checkLaunchArgs(['--lang=vi'])).not.toThrow();
  });
});

describe('proxy manager', () => {
  const net = (o: Record<string, unknown>) => parseConfig({ network: o }).network;
  it('uses env proxy in system mode with NO_PROXY bypass', () => {
    const pm = new ProxyManager(net({ mode: 'system' }), {
      HTTPS_PROXY: 'http://u:p%40ss@proxy.corp:3128',
      NO_PROXY: '.corp.local,localhost',
    });
    const p = pm.playwrightProxy()!;
    expect(p.server).toBe('http://proxy.corp:3128');
    expect(p.username).toBe('u');
    expect(p.password).toBe('p@ss');
    expect(p.bypass).toContain('*.corp.local');
    const st = pm.status();
    expect(JSON.stringify(st)).not.toContain('p@ss');
    expect(st.authenticated).toBe(true);
  });
  it('uses manual config with credentials from named env vars', () => {
    const pm = new ProxyManager(
      net({
        mode: 'manual',
        proxy: { enabled: true, server: 'http://proxy:8080', usernameEnv: 'PU', passwordEnv: 'PP' },
      }),
      { PU: 'alice', PP: 'pw' },
    );
    expect(pm.playwrightProxy()).toMatchObject({
      server: 'http://proxy:8080',
      username: 'alice',
      password: 'pw',
    });
    const missing = new ProxyManager(
      net({
        mode: 'manual',
        proxy: { enabled: true, server: 'http://proxy:8080', usernameEnv: 'PU', passwordEnv: 'PP' },
      }),
      {},
    );
    expect(missing.status().credentialsMissing).toEqual(['PU', 'PP']);
  });
  it('direct mode disables proxies', () => {
    const pm = new ProxyManager(net({ mode: 'direct' }), { HTTPS_PROXY: 'http://p:1' });
    expect(pm.playwrightProxy()).toBeUndefined();
    expect(pm.chromiumArgs()).toEqual(['--no-proxy-server']);
  });
});

describe('session store', () => {
  it('encrypts at rest, detects tampering and expiration', () => {
    const dir = tmpDir();
    const st = new SessionStore(dir, true);
    st.save(
      'proj',
      'maker',
      { cookies: [{ name: 'sid', value: 'SECRET_COOKIE' }], origins: [] },
      { cookies: 1, origins: 0 },
    );
    const file = path.join(dir, 'sessions', 'proj', 'maker.state');
    expect(fs.readFileSync(file).toString('latin1')).not.toContain('SECRET_COOKIE');
    expect(
      (st.load('proj', 'maker', 24).state as { cookies: Array<{ value: string }> }).cookies[0]!.value,
    ).toBe('SECRET_COOKIE');
    expect(st.list('proj').map((m) => m.name)).toEqual(['maker']);
    const buf = fs.readFileSync(file);
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff;
    fs.writeFileSync(file, buf);
    expect(() => st.load('proj', 'maker', 24)).toThrow(/cannot be decrypted/);
    const meta = path.join(dir, 'sessions', 'proj', 'maker.meta.json');
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    m.savedAt = new Date(Date.now() - 48 * 3600_000).toISOString();
    fs.writeFileSync(meta, JSON.stringify(m));
    expect(() => st.load('proj', 'maker', 24)).toThrow(/older than/);
  });
  it('rejects traversal in names', () => {
    const st = new SessionStore(tmpDir(), true);
    expect(() => st.save('../x', 'a', {}, { cookies: 0, origins: 0 })).toThrow(/Invalid project/);
    expect(() => st.save('p', '../../a', {}, { cookies: 0, origins: 0 })).toThrow(/Invalid session/);
  });
});

describe('errors', () => {
  it('normalizes Playwright-like errors without stack traces', () => {
    const e = toTgError(
      Object.assign(new Error('locator.click: Timeout 3000ms exceeded.\nCall log:\n  - waiting for ...'), {
        name: 'TimeoutError',
      }),
    );
    expect(e.code).toBe('ACTION_TIMEOUT');
    expect(e.message).not.toContain('Call log');
    expect(e.retryable).toBe(true);
    expect(toTgError(new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at http://x')).code).toBe(
      'NETWORK_DNS_FAILED',
    );
    expect(toTgError(new Error('net::ERR_CERT_AUTHORITY_INVALID')).code).toBe('NETWORK_TLS_FAILED');
    expect(toTgError(new Error('Target page, context or browser has been closed')).code).toBe(
      'BROWSER_DISCONNECTED',
    );
    expect(classifyNetworkError('net::ERR_PROXY_CONNECTION_FAILED')).toBe('NETWORK_PROXY_FAILED');
    expect(new TgError('DOMAIN_NOT_ALLOWED', 'x').toJSON().suggestion).toBeDefined();
  });
});

describe('browser process environment', () => {
  it('passes only allowlisted variables to the browser (no tokens, secrets, proxy creds)', async () => {
    const { browserEnv } = await import('../../src/browser/browser-launcher.js');
    const env = browserEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      XDG_RUNTIME_DIR: '/run/u',
      TG_BROWSER_TOKEN: 'tok',
      TG_SECRET_PW: 'pw',
      TG_PROXY_PASSWORD: 'p',
      AWS_SECRET_ACCESS_KEY: 'k',
      NPM_TOKEN: 'n',
    });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'LC_ALL', 'PATH', 'XDG_RUNTIME_DIR']);
  });
});
