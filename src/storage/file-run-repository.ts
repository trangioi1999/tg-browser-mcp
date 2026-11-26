import { storagePath } from './file-boundary.js';
import fs from 'node:fs';
import path from 'node:path';
const pathProject = (directory: string) => path.basename(directory);
import { writeFileAtomic } from '../workflow/atomic-write.js';
import type { RunRecord } from '../workflow/workflow-engine.js';
import { assertSafeName } from '../shared/util.js';
import { TgError } from '../shared/errors.js';
import { getLogger } from '../shared/logger.js';
import { StoredRunSchema } from './run-schema.js';
import type { RunRepository } from './repositories.js';
export class FileRunRepository implements RunRepository {
  readonly directory: string;
  constructor(dataDir: string, project: string) {
    this.directory = storagePath(dataDir, 'runs', assertSafeName('project', project));
  }
  save(run: RunRecord): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeFileAtomic(
      storagePath(this.directory, assertSafeName('run', run.runId) + '.json'),
      JSON.stringify(run),
    );
  }
  get(runId: string): RunRecord {
    const f = storagePath(this.directory, `${assertSafeName('run', runId)}.json`);
    if (!fs.existsSync(f)) throw new TgError('WORKFLOW_NOT_FOUND', `Run ${runId} not found`);
    const run = JSON.parse(fs.readFileSync(f, 'utf8')) as RunRecord;
    if (run.runId !== runId || run.project !== pathProject(this.directory))
      throw new Error('Run identity mismatch');
    return run;
  }

  list(limit = 20): Array<Pick<RunRecord, 'runId' | 'workflow' | 'status' | 'startedAt' | 'durationMs'>> {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.directory).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    return files
      .flatMap((f) => {
        try {
          const run = StoredRunSchema.parse(
            JSON.parse(fs.readFileSync(storagePath(this.directory, f), 'utf8')),
          );
          if (run.project !== pathProject(this.directory) || f !== `${run.runId}.json`)
            throw new Error('Run id does not match filename');
          return [run];
        } catch {
          getLogger().warn({ file: f }, 'skipping unreadable workflow run');
          return [];
        }
      })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map(({ runId, workflow, status, startedAt, durationMs }) => ({
        runId,
        workflow,
        status,
        startedAt,
        ...(durationMs !== undefined ? { durationMs } : {}),
      }));
  }
}
