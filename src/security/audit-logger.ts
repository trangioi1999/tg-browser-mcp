import fs from 'node:fs';
import path from 'node:path';

export interface AuditEntry {
  ts: string;
  correlationId: string;
  tool: string;
  risk: string;
  sessionId?: string;
  project: string;
  agentId?: string;
  status: 'ok' | 'error' | 'denied';
  durationMs: number;
  errorCode?: string;
  /** Short, already-redacted summary of the target (e.g. "ref=e5", host of a URL). */
  target?: string;
}

/**
 * Append-only JSONL audit log stored locally under <dataDir>/audit/. Never contains raw values
 * typed into fields, cookies or tokens — only tool names, targets, outcome and timing.
 */
export class AuditLogger {
  private readonly file: string | undefined;
  private readonly recent: AuditEntry[] = [];

  constructor(dataDir: string | undefined) {
    if (dataDir) {
      const dir = path.join(dataDir, 'audit');
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.file = path.join(dir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
      } catch {
        this.file = undefined;
      }
    }
  }

  record(entry: AuditEntry): void {
    this.recent.push(entry);
    if (this.recent.length > 500) this.recent.shift();
    if (!this.file) return;
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // Audit failures must not crash automation; they are visible via `doctor`.
    }
  }

  /** Tool metrics derived from the in-memory window. */
  metrics(): Record<string, { calls: number; errors: number; avgMs: number }> {
    const m: Record<string, { calls: number; errors: number; totalMs: number }> = {};
    for (const e of this.recent) {
      const x = (m[e.tool] ??= { calls: 0, errors: 0, totalMs: 0 });
      x.calls++;
      if (e.status !== 'ok') x.errors++;
      x.totalMs += e.durationMs;
    }
    return Object.fromEntries(
      Object.entries(m).map(([k, v]) => [
        k,
        { calls: v.calls, errors: v.errors, avgMs: Math.round(v.totalMs / v.calls) },
      ]),
    );
  }
}
