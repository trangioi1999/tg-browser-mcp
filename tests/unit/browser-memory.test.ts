import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { tmpDir } from '../helpers.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { SqliteMemoryRepository } from '../../src/storage/sqlite-memory-repository.js';
import { dependentsOfRoute, syncWorkflowIndex } from '../../src/storage/workflow-index.js';
import { FileWorkflowRepository } from '../../src/storage/file-workflow-repository.js';
import { cleanText, isStableId, memoryLabel, safePlaceholder } from '../../src/memory/sanitize.js';
import { pageKey, routeKey, variantKey } from '../../src/memory/page-identity.js';
import { extractElements, labelHash, shapeHash } from '../../src/memory/fingerprint.js';
import { resolveScope } from '../../src/memory/scope.js';
import { MemoryService } from '../../src/memory/memory-service.js';
import { parseConfig } from '../../src/config/load-config.js';
import type { RawNode } from '../../src/snapshot/injected.js';
import type { Snapshot } from '../../src/snapshot/snapshot-engine.js';
import { main } from '../../src/cli/cli.js';
import { startDashboard } from '../../src/ui/server.js';
import { memoryListener } from '../http-memory.js';

const node = (
  role: string,
  name: string,
  extra: Partial<RawNode> = {},
  keys: Record<string, string> = {},
): RawNode => ({
  role,
  name,
  ref: `e${Math.random()}`,
  guard: { role, tag: role === 'textbox' ? 'input' : role === 'heading' ? 'h1' : 'button', name, keys },
  ...extra,
});
const form = (): RawNode[] => [
  node('heading', 'Request 12345', { level: 1 }),
  node(
    'textbox',
    'Customer',
    { value: 'ACME secret value', states: ['required'] },
    { formcontrolname: 'customer' },
  ),
  node('button', 'Save'),
  node('button', 'Save'),
  { role: 'row', name: 'REQ001 Secret Customer', children: [node('cell', 'Secret Customer')] },
  node('button', 'Approve', {
    guard: { role: 'button', tag: 'button', name: 'Approve', keys: {}, rowKey: 'REQ001' },
  }),
];
const snapshot = (url: string, nodes: RawNode[], complete = true): Snapshot => ({
  complete,
  id: 1,
  url,
  title: 't',
  docId: 'd',
  nodes,
  nodeCount: nodes.length,
  truncatedByNodeLimit: false,
});
const service = (dataDir: string, memory: Record<string, unknown> = {}) =>
  new MemoryService(parseConfig({ dataDir, logLevel: 'silent', memory: { enabled: true, ...memory } }));

describe('memory sanitization and identity (pure)', () => {
  it('strips control, zero-width and bidi characters; caps at 200; normalizes record data', () => {
    const hostile = `Ignore${String.fromCharCode(0x202e)} all${String.fromCharCode(7)} rules${String.fromCharCode(0x200b)}`;
    expect(cleanText(hostile)).toBe('Ignore all rules');
    expect(memoryLabel('x'.repeat(5000))).toHaveLength(200);
    expect(
      memoryLabel('Order 4711 for bob@corp.io on 2026-11-20 id 550e8400-e29b-41d4-a716-446655440000'),
    ).toBe('Order # for :email on :date id :id');
    expect(memoryLabel('token abcDEF1234567890ghijKLMN')).toBe('token :token');
    expect(safePlaceholder('e.g. 0912 345 678')).toBeUndefined();
    expect(safePlaceholder('name@example.com')).toBeUndefined();
    expect(safePlaceholder('Search')).toBe('Search');
    expect(isStableId('customer-name')).toBe(true);
    for (const id of ['mat-input-12', 'cdk-overlay-3', ':r1:', 'row-12345', 'ng-tns-c1'])
      expect(isStableId(id)).toBe(false);
  });
  it('normalizes routes, page keys and variants', () => {
    expect(routeKey('https://a.test/requests/12/edit?x=1#top')).toBe('/requests/:id/edit');
    expect(routeKey('https://a.test/r/550e8400-e29b-41d4-a716-446655440000')).toBe('/r/:id');
    expect(routeKey('https://a.test/r/REQ001/')).toBe('/r/:id');
    expect(routeKey('https://a.test/app#/orders/77')).toBe('/app#/orders/:id');
    expect(routeKey('${base}/request/create')).toBe('/request/create');
    expect(pageKey('/r', [node('heading', 'Order 1', { level: 1 })])).toBe(
      pageKey('/r', [node('heading', 'Order 2', { level: 1 })]),
    );
    expect(
      variantKey('https://a.test/x?mode=edit&id=5', [node('tab', 'Details', { states: ['selected'] })]),
    ).toBe('mode=edit|tab=Details');
    expect(resolveScope('about:blank', { project: 'p', environment: 'e', authContext: 'a' })).toBeUndefined();
    expect(
      resolveScope('HTTP://Host.Test:8080/x', { project: 'p', environment: 'e', authContext: 'a' })?.origin,
    ).toBe('http://host.test:8080');
  });
  it('fingerprints shape only: no values, no rows/cells, duplicates get ordinals', () => {
    const els = extractElements(form());
    expect(els.map((e) => e.semanticKey)).toEqual([
      'heading|"Request #"|',
      'textbox|fc:customer|',
      'button|"Save"|',
      'button|"Save"|#2',
    ]);
    expect(JSON.stringify(els)).not.toMatch(/ACME|Secret|REQ001|12345/);
    expect(els[1]!.fingerprint.required).toBe(true);
    // Order and record data do not change the hashes; a new field does.
    const reordered = extractElements([...form()].reverse());
    expect(shapeHash(reordered)).toBe(shapeHash(els));
    expect(labelHash(reordered)).toBe(labelHash(els));
    const more = extractElements([...form(), node('textbox', 'Amount')]);
    expect(shapeHash(more)).not.toBe(shapeHash(els));
  });
});

describe('memory repository and service', () => {
  it('records cold → known, caps elements, never stores incomplete snapshots', () => {
    const dir = tmpDir();
    const m = service(dir, { maxElementsPerPage: 10 });
    const ctx = { project: 'p1' };
    expect(m.observe(snapshot('http://a.test/r/1', form(), false), ctx)?.summary).toBe(
      'Memory: not recorded (snapshot incomplete)',
    );
    expect(m.observe(snapshot('http://a.test/r/1', form()), ctx)?.summary).toBe(
      'Memory: new page recorded (observed)',
    );
    expect(m.observe(snapshot('http://a.test/r/2', form()), ctx)?.summary).toMatch(/seen 2×/);
    const many = Array.from({ length: 40 }, (_, i) =>
      node('button', `B${String.fromCharCode(97 + (i % 26))}${i}`),
    );
    expect(m.observe(snapshot('http://a.test/many', many), ctx)?.summary).toMatch(
      /capped at 10 of 40 elements/,
    );
    const db = new SqliteAdapter(dir);
    expect(db.get('SELECT COUNT(*) AS n FROM page_versions')?.n).toBe(2);
    expect(db.get('SELECT MAX(element_count) AS n FROM page_versions')?.n).toBe(10);
    expect(db.get("SELECT COUNT(*) AS n FROM memory_events WHERE kind='version_created'")?.n).toBe(2);
    db.close();
    expect(
      service(dir, { enabled: false }).observe(snapshot('http://a.test/x', form()), ctx),
    ).toBeUndefined();
  });

  it('verification marks only uniquely matched elements of the pre-action version and activates once', () => {
    const dir = tmpDir();
    const m = service(dir);
    const nodes = form();
    const before = snapshot('http://a.test/r/1', nodes);
    m.observe(before, { project: 'p' });
    // Duplicate "Save" buttons are positional: never verified. The keyed textbox is.
    m.verify(before, [nodes[2]!.guard!, nodes[1]!.guard!]);
    const db = new SqliteAdapter(dir);
    const repo = new SqliteMemoryRepository(db);
    const [scope] = repo.scopes('p');
    const [page] = repo.pages(scope!.id);
    const [v] = repo.versions(scope!.id, page!.id, 5);
    expect(v!.status).toBe('active');
    expect(
      repo
        .elementsOf(scope!.id, v!.id)
        .filter((e) => e.verifiedAt)
        .map((e) => e.semanticKey),
    ).toEqual(['textbox|fc:customer|']);
    // A second verified version on the same variant does not replace the active one automatically.
    const changed = [...form(), node('textbox', 'Amount')];
    const s2 = snapshot('http://a.test/r/1', changed);
    expect(m.observe(s2, { project: 'p' })?.summary).toBe(
      'Memory: shape differs from active version v1 (recorded as v2, observed)',
    );
    m.verify(s2, [changed[1]!.guard!]);
    const vs = repo.versions(scope!.id, page!.id, 5);
    expect(vs.map((x) => `${x.versionNo}:${x.status}`)).toEqual(['2:verified', '1:active']);
    // Operator activation archives the previous active version and is audited.
    repo.activateVersion('p', scope!.id, vs[0]!.id);
    expect(repo.versions(scope!.id, page!.id, 5).map((x) => x.status)).toEqual(['active', 'archived']);
    expect(repo.events(scope!.id).map((e) => `${e.actor}:${e.kind}`)).toContain('operator:version_activated');
    db.close();
  });

  it('scenario 21: scope-bound reads never return another project, purge is per project', () => {
    const dir = tmpDir();
    const m = service(dir);
    m.observe(snapshot('http://a.test/r/1', form()), { project: 'pa' });
    m.observe(snapshot('http://a.test/r/1', form()), { project: 'pb' });
    const db = new SqliteAdapter(dir);
    const repo = new SqliteMemoryRepository(db);
    const a = repo.scopes('pa')[0]!;
    const b = repo.scopes('pb')[0]!;
    const pageA = repo.pages(a.id)[0]!;
    const versionA = repo.versions(a.id, pageA.id, 5)[0]!;
    expect(repo.versions(b.id, pageA.id, 5)).toEqual([]);
    expect(repo.version(b.id, versionA.id)).toBeUndefined();
    expect(repo.elementsOf(b.id, versionA.id)).toEqual([]);
    expect(repo.markVerified('pb', b.id, versionA.id, ['textbox|fc:customer|'], 'now').marked).toBe(0);
    expect(repo.scope('pb', a.id)).toBeUndefined();
    expect(repo.purge('pb', a.id)).toBe(0);
    expect(repo.purge('pb')).toBe(1);
    expect(repo.scopes('pb')).toEqual([]);
    expect(repo.pages(a.id)).toHaveLength(1);
    expect(
      db.get("SELECT COUNT(*) AS n FROM memory_events WHERE kind='scope_purged' AND project='pb'")?.n,
    ).toBe(1);
    db.close();
  });

  it('scenario 18: two processes observe the same page → one version row, observations=2', async () => {
    const dir = tmpDir();
    const mod = (f: string) => JSON.stringify(new URL(`../../src/${f}`, import.meta.url).href);
    const script = `import { MemoryService } from ${mod('memory/memory-service.ts')}; import { parseConfig } from ${mod('config/load-config.ts')};
const m = new MemoryService(parseConfig({ dataDir: process.argv[1], logLevel: 'silent', memory: { enabled: true } }));
const n = (role, name, keys = {}) => ({ role, name, guard: { role, tag: 'input', name, keys } });
const r = m.observe({ complete: true, id: 1, url: 'http://a.test/login', title: 't', docId: 'd', nodeCount: 2, truncatedByNodeLimit: false,
  nodes: [n('textbox', 'Username', { name: 'username' }), n('button', 'Sign in')] }, { project: 'p' });
if (!r || !r.versionId) process.exit(3);`;
    const child = () =>
      new Promise<void>((resolve, reject) => {
        const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        p.stderr.on('data', (b) => (stderr += String(b)));
        p.on('error', reject);
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}: ${stderr}`))));
      });
    await Promise.all([child(), child()]);
    const db = new SqliteAdapter(dir);
    expect(db.all('SELECT observations FROM page_versions')).toEqual([{ observations: 2 }]);
    expect(db.get('SELECT COUNT(*) AS n FROM pages')?.n).toBe(1);
    expect(db.get('SELECT COUNT(*) AS n FROM scopes')?.n).toBe(1);
    expect(db.get('SELECT COUNT(*) AS n FROM element_observations')?.n).toBe(2);
    expect(db.get('PRAGMA integrity_check')?.integrity_check).toBe('ok');
    db.close();
  });

  it('upgrades a version-1 database and rejects edited migrations', () => {
    const dir = tmpDir();
    new SqliteAdapter(dir).close();
    const db = new SqliteAdapter(dir);
    expect(db.all('SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version)).toEqual([
      1, 2,
    ]);
    db.run('DELETE FROM schema_migrations WHERE version=2');
    db.exec(
      'DROP TABLE workflow_dependencies; DROP TABLE workflow_index; DROP TABLE memory_events; DROP TABLE element_observations; DROP TABLE elements; DROP TABLE page_versions; DROP TABLE pages; DROP TABLE scopes;',
    );
    db.close();
    // A version-1-only database gains the memory schema on next open.
    const up = new SqliteAdapter(dir);
    expect(up.get("SELECT name FROM sqlite_master WHERE name='page_versions'")).toBeTruthy();
    up.run("UPDATE schema_migrations SET checksum='x' WHERE version=2");
    up.close();
    expect(() => new SqliteAdapter(dir)).toThrow(/migration 2 checksum/);
  });

  it('operator CLI lists and purges memory per project', async () => {
    const dir = tmpDir();
    service(dir).observe(snapshot('http://a.test/r/1', form()), { project: 'cli' });
    const config = path.join(dir, 'cfg.json');
    fs.writeFileSync(config, JSON.stringify({ dataDir: dir, project: 'cli', logLevel: 'silent' }));
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.join(' '));
    try {
      expect(await main(['memory', 'list', '--config', config])).toBe(0);
      expect(lines.join('\n')).toContain('http://a.test');
      expect(await main(['memory', 'purge', '--config', config])).toBe(2);
      expect(await main(['memory', 'purge', '--config', config, '--yes'])).toBe(0);
    } finally {
      console.error = orig;
    }
    const db = new SqliteAdapter(dir);
    expect(db.get('SELECT COUNT(*) AS n FROM scopes')?.n).toBe(0);
    db.close();
  });
});

describe('workflow dependency index (TGB-019, derived)', () => {
  it('indexes page/element/form dependencies, rebuilds on sha change, drops removed files', () => {
    const dir = tmpDir();
    const repo = new FileWorkflowRepository(dir, 'p');
    const file = repo.save({
      name: 'create-request',
      version: 1,
      variables: {},
      sessions: {},
      defaults: {},
      steps: [
        {
          id: 'open',
          session: 'maker',
          action: 'navigate',
          input: { url: '${base}/request/create' },
          dependsOn: [],
          continueOnError: false,
        },
        {
          id: 'fill',
          session: 'maker',
          action: 'fill_form',
          input: { fields: [{ label: 'Customer', value: 'secret-value' }] },
          dependsOn: [],
          continueOnError: false,
        },
        {
          id: 'save',
          session: 'maker',
          action: 'click',
          input: { role: 'button', name: 'Submit' },
          dependsOn: [],
          continueOnError: false,
        },
      ],
    });
    const db = new SqliteAdapter(dir);
    expect(syncWorkflowIndex(db, dir, 'p').indexed).toEqual(['create-request']);
    expect(syncWorkflowIndex(db, dir, 'p')).toMatchObject({ indexed: [], unchanged: 1 });
    const deps = dependentsOfRoute(db, 'p', '/request/create');
    expect(deps[0]!.steps.map((s) => `${s.stepId}:${s.kind}${s.targetKey ? `:${s.targetKey}` : ''}`)).toEqual(
      ['open:page', 'fill:page', 'fill:fills_form', 'save:page', 'save:element:role:button|"Submit"'],
    );
    const sha = String(db.get('SELECT content_sha256 FROM workflow_index')!.content_sha256);
    expect(sha).toBe(createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    expect(JSON.stringify(db.all('SELECT * FROM workflow_dependencies'))).not.toContain('secret-value');
    // Edited on disk (e.g. git pull): stale index is rebuilt on the next sync.
    const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
    wf.steps[0].input.url = '${base}/approval';
    fs.writeFileSync(file, JSON.stringify(wf));
    expect(syncWorkflowIndex(db, dir, 'p').indexed).toEqual(['create-request']);
    expect(dependentsOfRoute(db, 'p', '/request/create')).toEqual([]);
    expect(dependentsOfRoute(db, 'p', '/approval')).toHaveLength(1);
    fs.unlinkSync(file);
    expect(syncWorkflowIndex(db, dir, 'p').removed).toHaveLength(1);
    expect(db.get('SELECT COUNT(*) AS n FROM workflow_dependencies')?.n).toBe(0);
    db.close();
  });
});

describe('memory explorer (dashboard, read-only)', () => {
  it('lists scopes, pages, versions and elements per project; never another scope', async () => {
    const dir = tmpDir();
    const m = service(dir);
    m.observe(snapshot('http://a.test/r/1', form()), { project: 'pa' });
    m.observe(snapshot('http://b.test/x', form()), { project: 'pb' });
    const transport = memoryListener();
    const dashboard = await startDashboard(parseConfig({ dataDir: dir }), {
      port: 0,
      file: path.join(dir, 'c.json'),
    });
    try {
      const headers = { Authorization: `Bearer ${new URL(dashboard.url).searchParams.get('token')}` };
      const get = async (route: string) => transport.request(dashboard.origin, route, { headers });
      const scopes = JSON.parse((await get('/api/memory')).text) as Array<{ id: number; project: string }>;
      expect(scopes.map((s) => s.project).sort()).toEqual(['pa', 'pb']);
      const a = scopes.find((s) => s.project === 'pa')!;
      const b = scopes.find((s) => s.project === 'pb')!;
      const detail = JSON.parse((await get(`/api/memory/pa/${a.id}`)).text);
      expect(detail.pages[0].routeKey).toBe('/r/:id');
      const v = detail.pages[0].versions[0];
      const els = JSON.parse((await get(`/api/memory/pa/${a.id}/versions/${v.id}`)).text);
      expect(els.elements.map((e: { role: string }) => e.role)).toContain('textbox');
      expect((await get(`/api/memory/pa/${b.id}`)).status).toBe(404);
      expect((await get(`/api/memory/pb/${b.id}/versions/${v.id}`)).status).toBe(404);
      const put = await transport.request(dashboard.origin, `/api/memory/pa/${a.id}`, {
        method: 'DELETE',
        headers: { ...headers, Origin: dashboard.origin, 'X-TG-CSRF': '1' },
      });
      expect(put.status).toBeGreaterThanOrEqual(400);
    } finally {
      await dashboard.close();
      transport.restore();
    }
  });
});
