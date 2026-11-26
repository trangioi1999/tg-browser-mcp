import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileWorkflowRepository } from '../../src/storage/file-workflow-repository.js';
import { FileRunRepository } from '../../src/storage/file-run-repository.js';
import { WorkflowSchema } from '../../src/workflow/workflow-schema.js';
const dirs: string[] = [];
function temp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-'));
  dirs.push(d);
  return d;
}
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
describe('file repositories', () => {
  it('atomically saves definitions and rejects slug collisions and stale writes', () => {
    const repo = new FileWorkflowRepository(temp(), 'test');
    const wf = WorkflowSchema.parse({ name: 'Hello world', steps: [{ id: 'one', action: 'snapshot' }] });
    const file = repo.save(wf);
    expect(repo.load(wf.name)).toEqual(wf);
    expect(() => repo.save({ ...wf, name: 'Hello-world' })).toThrow('collision');
    expect(() => repo.save(wf, { expectedSha: 'stale' })).toThrow('changed');
    expect(fs.readdirSync(path.dirname(file))).toHaveLength(1);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
  it('skips corrupt checkpoints and isolates projects', () => {
    const dir = temp();
    const repo = new FileRunRepository(dir, 'test');
    repo.save({
      runId: 'one',
      project: 'test',
      workflow: 'wf',
      status: 'passed',
      startedAt: new Date().toISOString(),
      variables: {},
      steps: [],
    });
    fs.writeFileSync(path.join(repo.directory, 'broken.json'), '{');
    expect(repo.list()).toHaveLength(1);
    expect(new FileRunRepository(dir, 'other').list()).toEqual([]);
  });
});
