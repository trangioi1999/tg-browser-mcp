import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
 project TEXT NOT NULL, id TEXT NOT NULL, workflow TEXT NOT NULL, started_at TEXT NOT NULL,
 record TEXT NOT NULL, PRIMARY KEY(project,id)
) STRICT;
CREATE INDEX IF NOT EXISTS runs_history ON runs(project,started_at DESC);
CREATE TABLE IF NOT EXISTS artifacts (
 project TEXT NOT NULL, path TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(project,path)
) STRICT;
CREATE TABLE IF NOT EXISTS storage_state (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;
/** Internal driver boundary. Connections are short lived; no browser action holds a transaction. */
export class SqliteAdapter {
  readonly file: string;
  private readonly db: DatabaseSync;
  constructor(dataDir: string, readonly = false) {
    this.file = path.join(dataDir, 'storage.sqlite');
    if (!readonly) {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(
        this.file,
        fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
        0o600,
      );
      fs.fchmodSync(fd, 0o600);
      fs.closeSync(fd);
    } else if (fs.lstatSync(this.file).isSymbolicLink()) throw new Error('Symlink database rejected');
    this.db = new DatabaseSync(this.file, { readOnly: readonly });
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      if (!readonly) {
        // WAL mode changes may return SQLITE_BUSY without invoking the busy handler.
        const deadline = Date.now() + 5000;
        for (;;) {
          try {
            this.db.exec('PRAGMA journal_mode=WAL;');
            break;
          } catch (e) {
            if ((e as { errcode?: number }).errcode !== 5 || Date.now() >= deadline) throw e;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          }
        }
        this.transaction(() => {
          this.exec(
            'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL) STRICT',
          );
          const checksum = createHash('sha256').update(SCHEMA).digest('hex');
          const previous = this.get('SELECT checksum FROM schema_migrations WHERE version=1');
          if (previous && previous.checksum !== checksum)
            throw new Error('Storage migration checksum mismatch');
          if (!previous) {
            this.exec(SCHEMA);
            this.run('INSERT INTO schema_migrations VALUES (1,?,?)', new Date().toISOString(), checksum);
          }
        });
      }
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  exec(sql: string): void {
    this.db.exec(sql);
  }
  run(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).run(...args);
  }
  get(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).get(...args);
  }
  all(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).all(...args);
  }
  transaction<T>(fn: () => T): T {
    this.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.exec('COMMIT');
      return result;
    } catch (e) {
      this.exec('ROLLBACK');
      throw e;
    }
  }
  close(): void {
    this.db.close();
  }
}
