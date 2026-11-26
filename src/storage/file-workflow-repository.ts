import { storagePath } from './file-boundary.js';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from '../workflow/atomic-write.js';
import type { Workflow } from '../workflow/workflow-schema.js';
import { assertValidWorkflow } from '../workflow/workflow-validator.js';
import { assertSafeName } from '../shared/util.js';
import { TgError } from '../shared/errors.js';
import type { WorkflowRepository } from './repositories.js';
export class FileWorkflowRepository implements WorkflowRepository {
  readonly directory: string;
  constructor(dataDir: string, project: string) {
    this.directory = storagePath(dataDir, 'workflows', assertSafeName('project', project));
  }
  save(wf: Workflow, options: { expectedSha?: string; overwrite?: boolean } = {}): string {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = storagePath(this.directory, `${assertSafeName('workflow', slug(wf.name))}.json`);
    if (fs.existsSync(file)) {
      const previous = fs.readFileSync(file, 'utf8');
      if (!options.overwrite && (JSON.parse(previous) as Workflow).name !== wf.name)
        throw new Error('Workflow slug collision');
      if (options.expectedSha && createHash('sha256').update(previous).digest('hex') !== options.expectedSha)
        throw new Error('Workflow changed since it was read');
    } else if (options.expectedSha) throw new Error('Workflow no longer exists');
    writeFileAtomic(file, `${JSON.stringify(wf, null, 2)}\n`);
    return file;
  }

  load(name: string): Workflow {
    const file = storagePath(this.directory, `${assertSafeName('workflow', slug(name))}.json`);
    if (!fs.existsSync(file))
      throw new TgError('WORKFLOW_NOT_FOUND', `Workflow "${name}" not found`, {
        suggestion: 'Call workflow_list.',
      });
    const wf = assertValidWorkflow(JSON.parse(fs.readFileSync(file, 'utf8')));
    return wf;
  }

  list(): Array<{ name: string; steps: number; sessions: string[]; file: string }> {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.directory).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    return files.flatMap((f) => {
      try {
        const wf = JSON.parse(fs.readFileSync(storagePath(this.directory, f), 'utf8')) as Workflow;
        return [
          {
            name: wf.name,
            steps: wf.steps.length,
            sessions: [...new Set(wf.steps.map((s) => s.session ?? 'default'))],
            file: storagePath(this.directory, f),
          },
        ];
      } catch {
        return [];
      }
    });
  }
}
function slug(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // strip accents: "Đăng nhập" -> "dang-nhap", not "ng-nh-p"
      .replace(/[đĐ]/g, 'd')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'workflow'
  );
}
