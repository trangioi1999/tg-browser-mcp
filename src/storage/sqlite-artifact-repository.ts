import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FileArtifactRepository } from './file-artifact-repository.js';
import { SqliteAdapter } from './sqlite-adapter.js';
import type { Artifact } from './repositories.js';
import { sanitize } from './sanitize.js';

export class SqliteArtifactRepository extends FileArtifactRepository {
  constructor(
    private readonly db: SqliteAdapter,
    private readonly dataDir: string,
    private readonly project: string,
  ) {
    super(dataDir, project);
  }
  override register(artifact: Artifact): void {
    const absolute = fs.realpathSync(artifact.path);
    const relative = path.relative(fs.realpathSync(this.dataDir), absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Artifact outside dataDir');
    fs.chmodSync(absolute, 0o600);
    const record = sanitize({
      ...artifact,
      path: relative,
      bytes: fs.statSync(absolute).size,
      sha256: createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
    });
    this.db.run(
      'INSERT INTO artifacts VALUES (?,?,?) ON CONFLICT(project,path) DO UPDATE SET record=excluded.record',
      this.project,
      relative,
      JSON.stringify(record),
    );
  }
  override list(): Artifact[] {
    return this.db
      .all('SELECT record FROM artifacts WHERE project=?', this.project)
      .map((r) => JSON.parse(String(r.record)) as Artifact);
  }
  override expire(now: string): string[] {
    return this.db.transaction(() => {
      const expired = this.list().filter((a) => a.expiresAt && a.expiresAt <= now);
      for (const a of expired)
        this.db.run('DELETE FROM artifacts WHERE project=? AND path=?', this.project, a.path);
      return expired.map((a) => a.path);
    });
  }
}
