import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Expands a leading `~` to the home directory and normalizes the path for the current OS. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

export function shortId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

/** Safe identifier for session/project/workflow names used in file paths (prevents traversal). */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertSafeName(kind: string, name: string): string {
  if (!SAFE_NAME.test(name) || name.includes('..')) {
    throw new Error(`Invalid ${kind} name "${name}". Use letters, digits, ".", "_" or "-" (max 64).`);
  }
  return name;
}

/** Returns true when `child` resolves inside `root` (after resolving symlink-free paths). */
export function isPathInside(root: string, child: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
