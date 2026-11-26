import { RunStore } from '../../src/storage/store.js';
import fs from 'node:fs';
import path from 'node:path';
import { memoryListener } from '../http-memory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load-config.js';
import { safeFile, startDashboard } from '../../src/ui/server.js';
import { tmpDir, trySymlink } from '../helpers.js';

describe('dashboard file boundary', () => {
  it('refuses traversal, absolute paths, protected roots, and symlink escapes', () => {
    const dir = tmpDir(),
      outside = tmpDir();
    fs.mkdirSync(path.join(dir, 'artifacts'));
    fs.mkdirSync(path.join(dir, 'journal'));
    fs.writeFileSync(path.join(outside, 'secret.json'), 'secret');
    trySymlink(path.join(outside, 'secret.json'), path.join(dir, 'artifacts/link.json'));
    for (const p of [
      '../secret',
      '/etc/passwd',
      'artifacts/../keys/key',
      'keys/session.key',
      'sessions/x.state',
      'artifacts/link.json',
      'artifacts/./file',
      'artifacts\\file',
    ])
      expect(() => safeFile(dir, p)).toThrow();
    fs.writeFileSync(path.join(dir, 'artifacts', 'ok.json'), '{}');
    expect(safeFile(dir, 'artifacts/ok.json')).toBe(fs.realpathSync(path.join(dir, 'artifacts/ok.json')));
  });
  it('refuses a symlinked root', () => {
    const dir = tmpDir(),
      outside = tmpDir();
    fs.writeFileSync(path.join(outside, 'a.json'), '{}');
    if (!trySymlink(outside, path.join(dir, 'artifacts'), 'dir')) return;
    expect(() => safeFile(dir, 'artifacts/a.json')).toThrow();
  });
});

describe('dashboard API', () => {
  let transport: ReturnType<typeof memoryListener>;
  const request = (...args: Parameters<ReturnType<typeof memoryListener>['request']>) =>
    transport.request(...args);
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined;
  let dir: string;
  let auth: Record<string, string>;
  let file: string;
  beforeEach(async () => {
    transport = memoryListener();
    dir = tmpDir();
    file = path.join(dir, 'config.json');
    dashboard = await startDashboard(parseConfig({ dataDir: dir }), { port: 0, file });
    auth = { Authorization: `Bearer ${new URL(dashboard.url).searchParams.get('token')}` };
  });
  afterEach(async () => {
    await dashboard?.close();
    dashboard = undefined;
    transport.restore();
  });
  const get = (route: string, headers?: Record<string, string>) =>
    request(dashboard!.origin, route, { headers: headers ?? auth });
  const put = (body: unknown, headers: Record<string, string> = {}) =>
    request(dashboard!.origin, '/api/config', {
      method: 'PUT',
      headers: {
        ...auth,
        Origin: dashboard!.origin,
        'X-TG-CSRF': '1',
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  it('requires a token and exchanges it for a private cookie and clean redirect', async () => {
    expect((await get('/api/status', {})).status).toBe(401);
    expect((await get('/api/status', { Authorization: 'Bearer wrong' })).status).toBe(401);
    const login = await get('/?token=' + new URL(dashboard!.url).searchParams.get('token'), {});
    expect(login.status).toBe(303);
    expect(login.headers.location).toBe('/');
    expect(login.headers['set-cookie']?.[0]).toContain('HttpOnly; SameSite=Strict; Path=/');
    const response = await get('/api/status', { Cookie: login.headers['set-cookie']![0]!.split(';')[0]! });
    expect(response.status).toBe(200);
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect((await get('/?token=wrong', {})).status).toBe(401);
  });
  it('enforces Host, Origin and CSRF independently', async () => {
    expect((await get('/api/config', { ...auth, Host: 'evil.test' })).status).toBe(403);
    expect((await put({}, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await put({}, { 'X-TG-CSRF': '0' })).status).toBe(403);
    expect((await put({}, { Origin: '' })).status).toBe(403);
  });
  it('discovers SQLite-only projects and reads their runs without legacy files', async () => {
    new RunStore(dir, 'sqlite-only').save({
      runId: 'sql-run',
      project: 'sqlite-only',
      workflow: 'wf',
      status: 'passed',
      startedAt: new Date().toISOString(),
      steps: [],
      variables: {},
    });
    expect(fs.existsSync(path.join(dir, 'runs'))).toBe(false);
    expect(JSON.parse((await get('/api/projects')).text)).toEqual(['sqlite-only']);
    expect(JSON.parse((await get('/api/runs?project=sqlite-only')).text)[0].runId).toBe('sql-run');
    expect(JSON.parse((await get('/api/runs/sqlite-only/sql-run')).text).workflow).toBe('wf');
  });
  it('validates config and writes atomically with a backup', async () => {
    expect((await put({ tools: { profile: 'invalid' } })).status).toBe(400);
    expect((await put({ network: { tls: { verify: false } } })).status).toBe(400);
    expect(fs.existsSync(file)).toBe(false);
    expect((await put({ project: 'first' })).status).toBe(200);
    const previous = fs.readFileSync(file, 'utf8');
    expect((await put({ project: 'second' })).status).toBe(200);
    expect(fs.readFileSync(file + '.bak', 'utf8')).toBe(previous);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).project).toBe('second');
    expect(fs.readdirSync(dir).some((n) => n.endsWith('.tmp'))).toBe(false);
    // POSIX permission bits do not exist on Windows (stat always reports 0o666 there).
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
  it('rejects non-JSON and oversized requests', async () => {
    expect((await put({}, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await put({ padding: 'x'.repeat(1_048_577) })).status).toBe(413);
  });
  it('protects files and rejects encoded traversal and unsafe identifiers', async () => {
    fs.mkdirSync(path.join(dir, 'artifacts'));
    const outside = tmpDir();
    fs.writeFileSync(path.join(outside, 'secret.json'), 'secret');
    trySymlink(path.join(outside, 'secret.json'), path.join(dir, 'artifacts/link.json'));
    for (const route of [
      '/files/keys/session.key',
      '/files/sessions/x.state',
      '/files/artifacts/%2e%2e/keys/session.key',
      '/files/%2Fetc/passwd',
      '/files/artifacts/link.json',
      '/api/sessions/bad%2Fproject/name',
      '/api/runs/default/%2e%2e',
    ])
      expect((await get(route)).status).toBeGreaterThanOrEqual(400);
    expect((await get('/files/artifacts/link.json', {})).status).toBe(401);
    expect((await get('/%66iles/artifacts/link.json', {})).status).toBe(401);
    expect((await get('/%61pi/sessions/default/demo', {})).status).toBe(401);
    expect((await get('//api/sessions/default/demo', {})).status).toBe(403);
  });
  it('supports video ranges and zip attachments', async () => {
    fs.mkdirSync(path.join(dir, 'artifacts'));
    fs.writeFileSync(path.join(dir, 'artifacts/v.webm'), '0123456789');
    fs.writeFileSync(path.join(dir, 'artifacts/t.zip'), 'zip');
    const r = await get('/files/artifacts/v.webm', { ...auth, Range: 'bytes=2-5' });
    expect(r.status).toBe(206);
    expect(r.text).toBe('2345');
    expect(r.headers['content-range']).toBe('bytes 2-5/10');
    expect((await get('/files/artifacts/v.webm', { ...auth, Range: 'bytes=-3' })).text).toBe('789');
    expect((await get('/files/artifacts/v.webm', { ...auth, Range: 'bytes=99-100' })).status).toBe(416);
    expect((await get('/files/artifacts/t.zip')).headers['content-disposition']).toBe('attachment');
  });
  it('redacts config credentials and never exposes secret environment values', async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        network: { proxy: { server: 'http://alice:password@localhost:8080' } },
        token: 'never-return',
      }),
    );
    const r = await get('/api/config');
    expect(r.text).not.toContain('alice:password');
    expect(r.text).not.toContain('never-return');
    expect(
      (await put({ network: { proxy: { server: 'http://alice:password@localhost:8080' } } })).status,
    ).toBe(400);
  });
  it('returns session history, artifacts, counts, filters and linked workflow reports', async () => {
    const journal = path.join(dir, 'journal', 'demo', 'maker');
    const artifacts = path.join(dir, 'artifacts', 'demo', 'maker');
    const runs = path.join(dir, 'runs', 'demo');
    fs.mkdirSync(journal, { recursive: true });
    fs.mkdirSync(artifacts, { recursive: true });
    fs.mkdirSync(runs, { recursive: true });
    for (const name of ['shot.png', 'video.webm', 'trace.zip'])
      fs.writeFileSync(path.join(artifacts, name), 'fixture');
    const events = [
      { ts: '2026-01-01T00:00:00Z', type: 'session.created', sessionId: 's' },
      { ts: '2026-01-01T00:00:01Z', type: 'action.completed', sessionId: 's', action: 'click' },
      {
        ts: '2026-01-01T00:00:02Z',
        type: 'console.error',
        sessionId: 's',
        text: '<script>alert(1)</script>',
        count: 1,
      },
    ];
    fs.writeFileSync(path.join(journal, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
    const reports = path.join(dir, 'artifacts', 'demo', 'reports');
    fs.mkdirSync(reports);
    const report = path.join(reports, 'report.md');
    fs.writeFileSync(report, '# Result');
    fs.writeFileSync(
      path.join(runs, 'run-1.json'),
      JSON.stringify({
        runId: 'run-1',
        project: 'demo',
        workflow: 'test',
        status: 'passed',
        startedAt: events[0]!.ts,
        steps: [{ session: 'maker', status: 'passed' }],
        reports: [report],
        variables: { password: 'not-public' },
      }),
    );
    expect(JSON.parse((await get('/api/projects')).text)).toEqual(['demo']);
    const sessions = JSON.parse((await get('/api/sessions?project=demo')).text);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].counts).toEqual({ actions: 1, errors: 1, screenshots: 1, videos: 1, traces: 1 });
    expect(sessions[0].screenshots[0].url).toBe('/files/artifacts/demo/maker/shot.png');
    expect(sessions[0].traces[0].command).toContain('npx playwright show-trace');
    expect(JSON.parse((await get('/api/sessions/demo/maker/events?limit=1')).text)).toHaveLength(1);
    expect(
      JSON.parse((await get('/api/sessions/demo/maker/events?type=action.completed')).text)[0].action,
    ).toBe('click');
    expect((await get('/api/sessions/demo/maker/events?limit=1001')).status).toBe(400);
    const run = await get('/api/runs/demo/run-1');
    expect(JSON.parse(run.text).reports[0].url).toBe('/files/artifacts/demo/reports/report.md');
    expect(run.text).not.toContain('not-public');
  });
  it('never serves active HTML or JavaScript from artifact directories', async () => {
    fs.mkdirSync(path.join(dir, 'artifacts'));
    fs.writeFileSync(path.join(dir, 'artifacts', 'evil.html'), '<script>alert(1)</script>');
    fs.writeFileSync(path.join(dir, 'artifacts', 'evil.js'), 'alert(1)');
    expect((await get('/files/artifacts/evil.html')).status).toBe(403);
    expect((await get('/files/artifacts/evil.js')).status).toBe(403);
  });
  it('serves schema, tools and the offline frontend', async () => {
    expect((await get('/api/config/schema')).status).toBe(200);
    expect(JSON.parse((await get('/api/tools?profile=minimal')).text).length).toBeGreaterThan(0);
    expect((await get('/')).text).toContain('lang="vi"');
    expect((await get('/app.js')).headers['content-type']).toContain('javascript');
  });
});

it('refuses non-loopback bind hosts', async () => {
  await expect(startDashboard(parseConfig({ dataDir: tmpDir() }), { host: '0.0.0.0' })).rejects.toThrow(
    '127.0.0.1',
  );
});

describe('dashboard workflows API', () => {
  it('lists saved workflows and shows step targets without any typed values', async () => {
    const transport = memoryListener();
    const dir = tmpDir();
    const wfDir = path.join(dir, 'workflows', 'default');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(
      path.join(wfDir, 'dang-nhap.json'),
      JSON.stringify({
        name: 'Đăng nhập',
        steps: [
          { id: 'open', session: 'maker', action: 'navigate', input: { url: 'http://127.0.0.1:4321/login' } },
          {
            id: 'creds',
            session: 'maker',
            action: 'fill_form',
            input: { fields: [{ label: 'Password', value: 'hunter2-not-public' }] },
          },
          {
            id: 'type',
            session: 'maker',
            action: 'type',
            input: { label: 'Note', text: 'x', value: 'typed-secret' },
          },
        ],
      }),
    );
    const dashboard = await startDashboard(parseConfig({ dataDir: dir }), {
      port: 0,
      file: path.join(dir, 'c.json'),
    });
    try {
      const headers = { Authorization: `Bearer ${new URL(dashboard.url).searchParams.get('token')}` };
      const list = await transport.request(dashboard.origin, '/api/workflows', { headers });
      expect(list.status).toBe(200);
      expect(JSON.parse(list.text)).toMatchObject([
        { id: 'dang-nhap', name: 'Đăng nhập', steps: 3, runs: 0 },
      ]);
      const detail = await transport.request(dashboard.origin, '/api/workflows/default/dang-nhap', {
        headers,
      });
      expect(detail.status).toBe(200);
      expect(detail.text).toContain('fields=Password');
      expect(detail.text).not.toContain('hunter2-not-public');
      expect(detail.text).not.toContain('typed-secret');
      expect(detail.text).not.toContain('text=x');
      expect(detail.text).toContain('label=Note');
      const missing = await transport.request(dashboard.origin, '/api/workflows/default/nope', { headers });
      expect(missing.status).toBe(404);
      const status = JSON.parse((await transport.request(dashboard.origin, '/api/status', { headers })).text);
      expect(status.toolTokens.minimal).toBeLessThan(status.toolTokens.full);
      const tools = JSON.parse(
        (await transport.request(dashboard.origin, '/api/tools?profile=minimal', { headers })).text,
      );
      expect(tools[0]).toHaveProperty('description');
    } finally {
      await dashboard.close();
      transport.restore();
    }
  });
});
