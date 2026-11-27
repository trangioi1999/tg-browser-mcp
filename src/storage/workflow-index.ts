import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { SqliteAdapter } from './sqlite-adapter.js';
import { storagePath } from './file-boundary.js';
import { assertSafeName } from '../shared/util.js';
import { assertValidWorkflow } from '../workflow/workflow-validator.js';
import { workflowDependencies } from '../memory/workflow-dependencies.js';

export interface IndexSyncResult {
  indexed: string[];
  removed: string[];
  unchanged: number;
  unreadable: string[];
}
export interface DependentWorkflow {
  workflow: string;
  steps: Array<{ stepId: string; session: string; action: string; kind: string; targetKey?: string }>;
}

/**
 * Derived workflow dependency index (doc 05 / doc 10 §3). Workflow JSON files stay the source of truth;
 * rows are keyed by the file's content SHA-256 and rebuilt whenever it differs (one transaction per file).
 */
export function syncWorkflowIndex(db: SqliteAdapter, dataDir: string, project: string): IndexSyncResult {
  assertSafeName('project', project);
  const result: IndexSyncResult = { indexed: [], removed: [], unchanged: 0, unreadable: [] };
  let dir: string;
  let files: string[] = [];
  try {
    dir = storagePath(dataDir, 'workflows', project);
    if (fs.existsSync(dir) && !fs.lstatSync(dir).isSymbolicLink())
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  const known = new Map(
    db
      .all('SELECT id, file, content_sha256 FROM workflow_index WHERE project=?', project)
      .map((r) => [String(r.file), { id: Number(r.id), sha: String(r.content_sha256) }]),
  );
  const present = new Set<string>();
  for (const f of files) {
    let raw: string;
    try {
      const full = storagePath(dir!, f);
      if (fs.lstatSync(full).isSymbolicLink()) throw new Error('symlink');
      raw = fs.readFileSync(full, 'utf8');
    } catch {
      result.unreadable.push(f);
      continue;
    }
    present.add(f);
    const sha = createHash('sha256').update(raw).digest('hex');
    if (known.get(f)?.sha === sha) {
      result.unchanged++;
      continue;
    }
    let wf;
    try {
      wf = assertValidWorkflow(JSON.parse(raw));
    } catch {
      result.unreadable.push(f);
      continue;
    }
    db.transaction(() => {
      db.run('DELETE FROM workflow_index WHERE project=? AND (file=? OR name=?)', project, f, wf.name);
      const info = db.run(
        'INSERT INTO workflow_index (project,name,file,content_sha256,schema_version,indexed_at) VALUES (?,?,?,?,?,?)',
        project,
        wf.name,
        f,
        sha,
        wf.version,
        new Date().toISOString(),
      );
      const id = Number(info.lastInsertRowid);
      for (const d of workflowDependencies(wf))
        db.run(
          'INSERT OR IGNORE INTO workflow_dependencies (workflow_id,step_id,session,action,kind,route_key,target_key) VALUES (?,?,?,?,?,?,?)',
          id,
          d.stepId,
          d.session,
          d.action,
          d.kind,
          d.routeKey ?? null,
          d.targetKey ?? null,
        );
    });
    result.indexed.push(wf.name);
  }
  for (const [file, { id }] of known)
    if (!present.has(file)) {
      db.run('DELETE FROM workflow_index WHERE id=?', id);
      result.removed.push(path.basename(file, '.json'));
    }
  return result;
}

/** Workflows of a project with a dependency on a route (index must be synced first). */
export function dependentsOfRoute(db: SqliteAdapter, project: string, routeKey: string): DependentWorkflow[] {
  const rows = db.all(
    `SELECT w.name, d.step_id, d.session, d.action, d.kind, d.target_key FROM workflow_dependencies d
     JOIN workflow_index w ON w.id=d.workflow_id WHERE w.project=? AND d.route_key=? ORDER BY w.name, d.rowid`,
    project,
    routeKey,
  );
  const map = new Map<string, DependentWorkflow>();
  for (const r of rows) {
    const name = String(r.name);
    if (!map.has(name)) map.set(name, { workflow: name, steps: [] });
    map.get(name)!.steps.push({
      stepId: String(r.step_id),
      session: String(r.session),
      action: String(r.action),
      kind: String(r.kind),
      ...(r.target_key !== null ? { targetKey: String(r.target_key) } : {}),
    });
  }
  return [...map.values()];
}
