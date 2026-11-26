import fs from 'node:fs';
import path from 'node:path';
import type { RunRepository } from './repositories.js';
import type { RunRecord } from '../workflow/workflow-engine.js';
import { FileRunRepository } from './file-run-repository.js';
import { SqliteAdapter } from './sqlite-adapter.js';
import { SqliteRunRepository } from './sqlite-run-repository.js';
import { SqliteArtifactRepository } from './sqlite-artifact-repository.js';
import { sanitize } from './sanitize.js';

/** Pre-finalize dual writes retain the documented rollback to legacy files.
 * SQLite is always used for new stores; legacy files take precedence until finalized. */
export class RunStore implements RunRepository {
  constructor(
    private readonly dataDir: string,
    private readonly project: string,
  ) {}
  private use<T>(fn: (sql: SqliteRunRepository, files: FileRunRepository | undefined) => T): T {
    const db = new SqliteAdapter(this.dataDir);
    try {
      const legacy =
        fs.existsSync(path.join(this.dataDir, 'runs')) &&
        !db.get("SELECT value FROM storage_state WHERE key='finalized'");
      return fn(
        new SqliteRunRepository(db, this.project),
        legacy ? new FileRunRepository(this.dataDir, this.project) : undefined,
      );
    } finally {
      db.close();
    }
  }
  save(run: RunRecord): void {
    this.use((sql, files) => {
      sql.save(run);
      files?.save(sanitize(run));
    });
  }
  get(runId: string): RunRecord {
    return this.use((sql, files) => {
      if (files) {
        try {
          return sanitize(files.get(runId));
        } catch (e) {
          if ((e as { code?: string }).code !== 'WORKFLOW_NOT_FOUND') throw e;
        }
      }
      return sql.get(runId);
    });
  }
  list(limit = 20) {
    return this.use((sql, files) => {
      const merged = new Map(sql.list(limit).map((r) => [r.runId, r]));
      for (const run of files?.list(limit) ?? []) merged.set(run.runId, run);
      return [...merged.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
    });
  }
}
export function registerArtifact(
  dataDir: string,
  project: string,
  file: string,
  runId: string,
  kind: 'screenshot' | 'report',
): void {
  const db = new SqliteAdapter(dataDir);
  try {
    new SqliteArtifactRepository(db, dataDir, project).register({ path: file, runId, kind, bytes: 0 });
  } finally {
    db.close();
  }
}
export function runProjects(dataDir: string): string[] {
  if (!fs.existsSync(path.join(dataDir, 'storage.sqlite'))) return [];
  const db = new SqliteAdapter(dataDir, true);
  try {
    return db.all('SELECT DISTINCT project FROM runs').map((r) => String(r.project));
  } finally {
    db.close();
  }
}
