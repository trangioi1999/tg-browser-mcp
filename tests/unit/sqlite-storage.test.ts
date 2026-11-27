import { indexArtifactEvents } from '../../src/storage/artifact-events.js';
import { TypedEmitter } from '../../src/shared/events.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { SqliteRunRepository } from '../../src/storage/sqlite-run-repository.js';
import { SqliteArtifactRepository } from '../../src/storage/sqlite-artifact-repository.js';
import { FileRunRepository } from '../../src/storage/file-run-repository.js';
import { RunStore } from '../../src/storage/store.js';
import { migrate } from '../../src/storage/migrate.js';
import { supportedNodeVersion } from '../../src/cli/doctor.js';
import { main } from '../../src/cli/cli.js';
import type { RunRecord } from '../../src/workflow/workflow-engine.js';
const dirs: string[] = [];
function temp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-'));
  dirs.push(d);
  return d;
}
function run(id = 'one'): RunRecord {
  return {
    runId: id,
    project: 'test',
    workflow: 'wf',
    status: 'passed',
    startedAt: new Date().toISOString(),
    steps: [],
    variables: {},
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});
describe('SQLite storage', () => {
  it('indexes session screenshots, traces and videos and detaches on close', () => {
    const dir = temp();
    const events = new TypedEmitter();
    const stop = indexArtifactEvents(dir, events);
    events.emit('session.created', { sessionId: 's', name: 'maker', project: 'test' });
    for (const event of ['screenshot.created', 'trace.created', 'video.saved'] as const) {
      const file = path.join(dir, event);
      fs.writeFileSync(file, 'test');
      events.emit(event, { sessionId: 's', pageId: 'p', path: file, bytes: 4 });
    }
    const db = new SqliteAdapter(dir);
    try {
      expect(
        new SqliteArtifactRepository(db, dir, 'test')
          .list()
          .map((a) => a.kind)
          .sort(),
      ).toEqual(['screenshot', 'trace', 'video']);
    } finally {
      db.close();
      stop();
    }
    const file = path.join(dir, 'after');
    fs.writeFileSync(file, 'test');
    events.emit('screenshot.created', { sessionId: 's', pageId: 'p', path: file, bytes: 4 });
    const check = new SqliteAdapter(dir);
    try {
      expect(new SqliteArtifactRepository(check, dir, 'test').list()).toHaveLength(3);
    } finally {
      check.close();
    }
  });

  it('checks the minimum unflagged SQLite runtime', () => {
    for (const version of ['20.19.0', '22.12.9']) expect(supportedNodeVersion(version)).toBe(false);
    for (const version of ['22.13.0', '22.23.0', '24.0.0']) expect(supportedNodeVersion(version)).toBe(true);
  });

  it('migrates once, uses WAL, restricts permissions and rolls back transactions', () => {
    const dir = temp();
    let db = new SqliteAdapter(dir);
    expect(db.get('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    if (process.platform !== 'win32') expect(fs.statSync(db.file).mode & 0o777).toBe(0o600);
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO storage_state VALUES ('test','value')");
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(db.get("SELECT * FROM storage_state WHERE key='test'")).toBeUndefined();
    db.close();
    db = new SqliteAdapter(dir);
    // Version 1 (runs/artifacts) + version 2 (Browser Memory, TGB-018), each applied once.
    expect(db.all('SELECT * FROM schema_migrations')).toHaveLength(2);
    db.close();
  });
  it('round trips steps, isolates projects and redacts secrets before persistence', () => {
    const dir = temp();
    const db = new SqliteAdapter(dir);
    try {
      vi.stubEnv('TG_SECRET_TEST', 'ultra-private-value');
      const repo = new SqliteRunRepository(db, 'test');
      const record = run();
      record.variables = { password: 'unknown-password', result: 'ultra-private-value' };
      record.steps = [
        {
          id: 'one',
          action: 'extract',
          session: 'default',
          status: 'passed',
          attempts: 1,
          durationMs: 1,
          message: 'ok',
          extracted: { variable: 'answer', value: '42' },
        },
      ];
      repo.save({ ...record, storageState: { cookies: [{ value: 'must-not-store' }] } } as RunRecord);
      expect(repo.get('one').steps[0]?.extracted?.value).toBe('42');
      expect(String(db.get('SELECT record FROM runs')?.record)).not.toContain('must-not-store');
      expect(repo.get('one').variables).toEqual({ password: '[REDACTED]', result: '[secret]' });
      expect(new SqliteRunRepository(db, 'other').list()).toEqual([]);
      expect(() => new SqliteRunRepository(db, 'other').save(record)).toThrow('project');
      expect(String(db.get('SELECT record FROM runs')?.record)).not.toContain('ultra-private-value');
    } finally {
      db.close();
    }
  });
  it('indexes artifact metadata with hashes and expires metadata only', () => {
    const dir = temp();
    const db = new SqliteAdapter(dir);
    try {
      const repo = new SqliteArtifactRepository(db, dir, 'test');
      const file = repo.allocate('one', 'failure.png');
      fs.writeFileSync(file, 'image');
      repo.register({ path: file, kind: 'screenshot', bytes: 0, expiresAt: '2020-01-01' });
      expect(repo.list()[0]?.sha256).toHaveLength(64);
      expect(repo.list()[0]?.bytes).toBe(5);
      expect(repo.expire('2021-01-01')).toHaveLength(1);
      expect(repo.list()).toEqual([]);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      db.close();
    }
  });
  it('supports dry run, backups, idempotency, conflict reporting and finalize', () => {
    const dir = temp();
    const files = new FileRunRepository(dir, 'test');
    files.save(run());
    expect(migrate(dir, { dryRun: true }).imported).toBe(1);
    expect(fs.existsSync(path.join(dir, 'storage.sqlite'))).toBe(false);
    const first = migrate(dir, { backup: true });
    expect(first.imported).toBe(1);
    expect(fs.existsSync(path.join(first.backup!, 'runs', 'test', 'one.json'))).toBe(true);
    expect(migrate(dir).unchanged).toBe(1);
    expect(migrate(dir, { backup: true }).backup).toBeTruthy();
    const changed = files.get('one');
    changed.workflow = 'changed';
    files.save(changed);
    expect(migrate(dir, { finalize: true }).conflicts).toEqual(['test/one']);
    expect(new RunStore(dir, 'test').get('one').workflow).toBe('changed');
    changed.workflow = 'wf';
    files.save(changed);
    expect(migrate(dir, { finalize: true }).finalized).toBe(true);
    files.save({ ...changed, workflow: 'ignored' });
    expect(new RunStore(dir, 'test').get('one').workflow).toBe('wf');
  });
  it('retains rollback files including new writes until finalize', () => {
    const dir = temp();
    const files = new FileRunRepository(dir, 'test');
    files.save(run());
    migrate(dir);
    new RunStore(dir, 'test').save(run('two'));
    fs.rmSync(path.join(dir, 'storage.sqlite'));
    expect(files.list()).toHaveLength(2);
    expect(new RunStore(dir, 'test').get('two').runId).toBe('two');
  });
  it('CLI validates flags and reports unreadable files without finalizing', async () => {
    const dir = temp();
    const config = path.join(dir, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ dataDir: dir, project: 'test' }));
    const files = new FileRunRepository(dir, 'test');
    files.save(run());
    fs.writeFileSync(path.join(files.directory, 'bad.json'), '{');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['migrate', '--config', config, '--dry-run'])).toBe(1);
    expect(fs.existsSync(path.join(dir, 'storage.sqlite'))).toBe(false);
    expect(await main(['migrate', '--config', config, '--backup', '--finalize'])).toBe(1);
    const db = new SqliteAdapter(dir);
    expect(db.get("SELECT * FROM storage_state WHERE key='finalized'")).toBeUndefined();
    db.close();
    await expect(main(['migrate', '--config', config, '--dry-run', '--finalize'])).rejects.toThrow('cannot');
  });
  it('two independent processes write 100 runs without lost writes', async () => {
    const dir = temp();
    const module = new URL('../../src/storage/store.ts', import.meta.url).href;
    const script = `import { RunStore } from ${JSON.stringify(module)}; const s = new RunStore(process.argv[1], 'test'); for(let i=0;i<50;i++) s.save({runId:process.argv[2]+'-'+i,project:'test',workflow:'wf',status:'passed',startedAt:new Date().toISOString(),steps:[],variables:{}});`;
    const child = (prefix: string) =>
      new Promise<void>((resolve, reject) => {
        const p = spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', script, dir, prefix],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let stderr = '';
        p.stderr.on('data', (b) => {
          stderr += String(b);
        });
        p.on('error', reject);
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
      });
    await Promise.all([child('a'), child('b')]);
    expect(new RunStore(dir, 'test').list(200)).toHaveLength(100);
    const db = new SqliteAdapter(dir);
    expect(db.get('PRAGMA integrity_check')?.integrity_check).toBe('ok');
    db.close();
  });
});
