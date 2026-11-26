import type { RunRecord } from '../workflow/workflow-engine.js';
import type { RunRepository, RunSummary } from './repositories.js';
import { SqliteAdapter } from './sqlite-adapter.js';
import { StoredRunSchema } from './run-schema.js';
import { sanitize } from './sanitize.js';
import { TgError } from '../shared/errors.js';
import { assertSafeName } from '../shared/util.js';

export class SqliteRunRepository implements RunRepository {
  constructor(
    private readonly db: SqliteAdapter,
    private readonly project: string,
  ) {
    assertSafeName('project', project);
  }
  save(run: RunRecord): void {
    const parsed = StoredRunSchema.parse(run);
    if (run.project !== this.project) throw new Error('Run project mismatch');
    assertSafeName('run', run.runId);
    const safe = sanitize(parsed);
    this.db.run(
      'INSERT INTO runs VALUES (?,?,?,?,?) ON CONFLICT(project,id) DO UPDATE SET workflow=excluded.workflow, started_at=excluded.started_at, record=excluded.record',
      this.project,
      run.runId,
      safe.workflow,
      run.startedAt,
      JSON.stringify(safe),
    );
  }
  get(runId: string): RunRecord {
    const row = this.db.get(
      'SELECT record FROM runs WHERE project=? AND id=?',
      this.project,
      assertSafeName('run', runId),
    );
    if (!row) throw new TgError('WORKFLOW_NOT_FOUND', 'Run not found');
    return JSON.parse(String(row.record)) as RunRecord;
  }
  list(limit = 20): RunSummary[] {
    return this.db
      .all(
        'SELECT record FROM runs WHERE project=? ORDER BY started_at DESC,id DESC LIMIT ?',
        this.project,
        Math.max(0, limit),
      )
      .map((row) => {
        const { runId, workflow, status, startedAt, durationMs } = JSON.parse(
          String(row.record),
        ) as RunRecord;
        return { runId, workflow, status, startedAt, ...(durationMs === undefined ? {} : { durationMs }) };
      });
  }
}
