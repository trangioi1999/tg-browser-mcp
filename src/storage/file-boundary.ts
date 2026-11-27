import fs from 'node:fs';
import path from 'node:path';
/** Reject links in storage-owned paths. The configured dataDir itself may be a user-selected alias. */
export function storagePath(dataDir: string, ...parts: string[]): string {
  let current = path.resolve(dataDir);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlink storage rejected');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return current;
}
