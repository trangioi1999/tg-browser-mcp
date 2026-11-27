import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteAdapter } from './sqlite-adapter.js';
import { SqliteRunRepository } from './sqlite-run-repository.js';
import { StoredRunSchema } from './run-schema.js';
import { assertValidWorkflow } from '../workflow/workflow-validator.js';
import type { RunRecord } from '../workflow/workflow-engine.js';
import { sanitize } from './sanitize.js';
import { assertSafeName } from '../shared/util.js';

export interface MigrationOptions {
  dryRun?: boolean;
  backup?: boolean;
  finalize?: boolean;
}
export function migrate(dataDir: string, options: MigrationOptions = {}) {
  if (options.dryRun && (options.backup || options.finalize))
    throw new Error('--dry-run cannot be combined with --backup or --finalize');
  const result = {
    runs: 0,
    workflows: 0,
    imported: 0,
    unchanged: 0,
    conflicts: [] as string[],
    unreadable: [] as string[],
    backup: undefined as string | undefined,
    finalized: false,
  };
  const runs = new Map<string, RunRecord[]>();
  const files = (root: string) => {
    const dir = path.join(dataDir, root);
    if (!fs.existsSync(dir)) return [];
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Symlink storage rejected');
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((project) => {
      if (!project.isDirectory() || project.isSymbolicLink()) {
        result.unreadable.push(root + '/' + project.name);
        return [];
      }
      assertSafeName('project', project.name);
      return fs
        .readdirSync(path.join(dir, project.name), { withFileTypes: true })
        .filter((f) => f.name.endsWith('.json'))
        .map((f) => ({ project: project.name, file: path.join(dir, project.name, f.name) }));
    });
  };
  for (const { project, file } of files('runs')) {
    try {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Symlink run rejected');
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      const run = StoredRunSchema.parse(raw) as RunRecord;
      if (run.project !== project || path.basename(file) !== run.runId + '.json')
        throw new Error('Run identity mismatch');
      runs.set(project, [...(runs.get(project) ?? []), sanitize(run)]);
      result.runs++;
    } catch {
      result.unreadable.push(path.relative(dataDir, file));
    }
  }
  for (const { file } of files('workflows')) {
    try {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Symlink workflow rejected');
      assertValidWorkflow(JSON.parse(fs.readFileSync(file, 'utf8')));
      result.workflows++;
    } catch {
      result.unreadable.push(path.relative(dataDir, file));
    }
  }
  const dbFile = path.join(dataDir, 'storage.sqlite');
  if (options.backup) {
    const backup = path.join(
      dataDir,
      'backups',
      new Date().toISOString().replace(/:/g, '-') + '-' + randomUUID(),
    );
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (const root of ['runs', 'workflows']) {
      const from = path.join(dataDir, root);
      if (fs.existsSync(from))
        fs.cpSync(from, path.join(backup, root), {
          recursive: true,
          filter: (source) => !fs.lstatSync(source).isSymbolicLink(),
        });
    }
    if (fs.existsSync(dbFile)) {
      const db = new SqliteAdapter(dataDir, true);
      try {
        db.run('VACUUM INTO ?', path.join(backup, 'storage.sqlite'));
        fs.chmodSync(path.join(backup, 'storage.sqlite'), 0o600);
      } finally {
        db.close();
      }
    }
    result.backup = backup;
  }
  const db = options.dryRun
    ? fs.existsSync(dbFile)
      ? new SqliteAdapter(dataDir, true)
      : undefined
    : new SqliteAdapter(dataDir);
  try {
    for (const [project, records] of runs) {
      const apply = () => {
        for (const run of records) {
          const previous = db?.get('SELECT record FROM runs WHERE project=? AND id=?', project, run.runId);
          if (previous) {
            if (canonical(JSON.parse(String(previous.record))) !== canonical(run))
              result.conflicts.push(project + '/' + run.runId);
            else result.unchanged++;
          } else {
            if (!options.dryRun) new SqliteRunRepository(db!, project).save(run);
            result.imported++;
          }
        }
      };
      if (options.dryRun) apply();
      else db!.transaction(apply);
    }
    if (options.finalize && !result.conflicts.length && !result.unreadable.length) {
      db!.run(
        "INSERT INTO storage_state VALUES ('finalized','true') ON CONFLICT(key) DO UPDATE SET value='true'",
      );
      result.finalized = true;
    }
  } finally {
    db?.close();
  }
  return result;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object')
    return (
      '{' +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => JSON.stringify(k) + ':' + canonical(x))
        .join(',') +
      '}'
    );
  return JSON.stringify(v);
}
