import { storagePath } from './file-boundary.js';
import fs from 'node:fs';
import path from 'node:path';
import { assertSafeName } from '../shared/util.js';
import { writeFileAtomic } from '../workflow/atomic-write.js';
import type { Artifact, ArtifactRepository } from './repositories.js';

export class FileArtifactRepository implements ArtifactRepository {
  readonly directory: string;
  constructor(dataDir: string, project: string) {
    this.directory = storagePath(dataDir, 'artifacts', assertSafeName('project', project));
  }
  allocate(runId: string, name: string): string {
    const dir = storagePath(this.directory, 'runs', assertSafeName('run', runId));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, assertSafeName('artifact', name));
  }
  register(artifact: Artifact): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeFileAtomic(
      storagePath(this.directory, 'metadata.json'),
      JSON.stringify([...this.list().filter((a) => a.path !== artifact.path), artifact]),
    );
  }
  list(): Artifact[] {
    try {
      return JSON.parse(fs.readFileSync(storagePath(this.directory, 'metadata.json'), 'utf8')) as Artifact[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }
  expire(now: string): string[] {
    const all = this.list();
    const expired = all.filter((a) => a.expiresAt && a.expiresAt <= now);
    writeFileAtomic(
      storagePath(this.directory, 'metadata.json'),
      JSON.stringify(all.filter((a) => !expired.includes(a))),
    );
    return expired.map((a) => a.path);
  }
}
