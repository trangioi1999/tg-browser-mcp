import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { TgError } from '../shared/errors.js';
import { assertSafeName } from '../shared/util.js';

export interface StoredSessionMeta {
  name: string;
  project: string;
  savedAt: string;
  url?: string;
  cookies: number;
  origins: number;
  encrypted: boolean;
}

const MAGIC = Buffer.from('TGS1');

/**
 * Stores Playwright storage state (cookies, localStorage, IndexedDB) per project/session.
 * Files are encrypted with AES-256-GCM. The key comes from TG_BROWSER_SESSION_KEY (64 hex chars)
 * or a locally generated key file (<dataDir>/keys/session.key, mode 0600).
 * Raw storage state is never returned to the AI model — only counts/metadata.
 */
export class SessionStore {
  private key: Buffer | undefined;

  constructor(
    private readonly dataDir: string,
    private readonly encrypt: boolean,
  ) {}

  private dir(project: string): string {
    return path.join(this.dataDir, 'sessions', assertSafeName('project', project));
  }

  private file(project: string, name: string): string {
    return path.join(this.dir(project), `${assertSafeName('session', name)}.state`);
  }

  private metaFile(project: string, name: string): string {
    return path.join(this.dir(project), `${assertSafeName('session', name)}.meta.json`);
  }

  private getKey(): Buffer {
    if (this.key) return this.key;
    const env = process.env.TG_BROWSER_SESSION_KEY;
    if (env) {
      if (!/^[0-9a-fA-F]{64}$/.test(env))
        throw new TgError('CONFIG_INVALID', 'TG_BROWSER_SESSION_KEY must be 64 hex characters (32 bytes)');
      this.key = Buffer.from(env, 'hex');
      return this.key;
    }
    const keyDir = path.join(this.dataDir, 'keys');
    const keyFile = path.join(keyDir, 'session.key');
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(keyFile)) {
      fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    }
    this.key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
    return this.key;
  }

  save(
    project: string,
    name: string,
    state: unknown,
    meta: Omit<StoredSessionMeta, 'savedAt' | 'encrypted' | 'name' | 'project'>,
  ): StoredSessionMeta {
    fs.mkdirSync(this.dir(project), { recursive: true, mode: 0o700 });
    const plain = Buffer.from(JSON.stringify(state), 'utf8');
    let data: Buffer;
    if (this.encrypt) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', this.getKey(), iv);
      const enc = Buffer.concat([c.update(plain), c.final()]);
      data = Buffer.concat([MAGIC, iv, c.getAuthTag(), enc]);
    } else data = plain;
    const tmp = `${this.file(project, name)}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, this.file(project, name));
    const full: StoredSessionMeta = {
      name,
      project,
      savedAt: new Date().toISOString(),
      encrypted: this.encrypt,
      ...meta,
    };
    fs.writeFileSync(this.metaFile(project, name), JSON.stringify(full, null, 2), { mode: 0o600 });
    return full;
  }

  load(project: string, name: string, expirationHours: number): { state: unknown; meta: StoredSessionMeta } {
    const f = this.file(project, name);
    if (!fs.existsSync(f))
      throw new TgError('SESSION_NOT_FOUND', `No saved state for session "${name}" in project "${project}"`);
    const meta = this.meta(project, name);
    if (meta && Date.now() - Date.parse(meta.savedAt) > expirationHours * 3_600_000) {
      throw new TgError('SESSION_EXPIRED', `Saved session "${name}" is older than ${expirationHours}h`, {
        suggestion: 'Log in again and call session_save.',
      });
    }
    const raw = fs.readFileSync(f);
    let plain: Buffer;
    if (raw.subarray(0, 4).equals(MAGIC)) {
      try {
        const iv = raw.subarray(4, 16);
        const tag = raw.subarray(16, 32);
        const d = createDecipheriv('aes-256-gcm', this.getKey(), iv);
        d.setAuthTag(tag);
        plain = Buffer.concat([d.update(raw.subarray(32)), d.final()]);
      } catch {
        throw new TgError(
          'SESSION_EXPIRED',
          `Saved session "${name}" cannot be decrypted (key changed or file tampered)`,
        );
      }
    } else plain = raw;
    return {
      state: JSON.parse(plain.toString('utf8')),
      meta: meta ?? { name, project, savedAt: '', cookies: 0, origins: 0, encrypted: false },
    };
  }

  meta(project: string, name: string): StoredSessionMeta | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.metaFile(project, name), 'utf8')) as StoredSessionMeta;
    } catch {
      return undefined;
    }
  }

  list(project: string): StoredSessionMeta[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir(project));
    } catch {
      return [];
    }
    return files
      .filter((f) => f.endsWith('.meta.json'))
      .map((f) => this.meta(project, f.replace(/\.meta\.json$/, '')))
      .filter((m): m is StoredSessionMeta => !!m);
  }

  delete(project: string, name: string): boolean {
    let removed = false;
    for (const f of [this.file(project, name), this.metaFile(project, name)]) {
      if (fs.existsSync(f)) {
        fs.rmSync(f);
        removed = true;
      }
    }
    return removed;
  }
}
