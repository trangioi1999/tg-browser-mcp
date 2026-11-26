import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Same-directory rename leaves the previous checkpoint intact if writing fails. */
export function writeFileAtomic(file: string, data: string): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
