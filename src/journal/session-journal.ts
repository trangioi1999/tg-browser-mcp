import fs from 'node:fs';
import path from 'node:path';
import type { TgConfig } from '../config/schema.js';
import type { DataRedactor } from '../security/data-redactor.js';
import type { TypedEmitter, HarnessEventName, HarnessEventMap } from '../shared/events.js';
import { assertSafeName } from '../shared/util.js';

export interface JournalEvent {
  ts: string;
  type: string;
  sessionId: string;
  [key: string]: unknown;
}

/** Persist only an explicit allowlist of metadata. Never accept action arguments or request bodies. */
export class SessionJournal {
  private readonly sessions = new Map<string, { project: string; name: string }>();
  constructor(
    private readonly cfg: TgConfig,
    private readonly redactor: DataRedactor,
    events: TypedEmitter,
  ) {
    events.onAny((type, payload) => this.observe(type, payload));
  }

  private observe(type: HarnessEventName, payload: HarnessEventMap[HarnessEventName]): void {
    if (!this.cfg.journal.enabled) return;
    try {
      if (type === 'session.created') {
        const p = payload as HarnessEventMap['session.created'];
        this.sessions.set(p.sessionId, { project: p.project, name: p.name });
      }
      if ('sessions' in payload) {
        for (const s of payload.sessions ?? [])
          this.write(s.project, s.name, type, { ...payload, sessionId: s.sessionId });
      } else if ('sessionId' in payload) {
        const s = this.sessions.get(payload.sessionId);
        if (s) this.write(s.project, s.name, type, payload);
      }
    } catch {
      /* Best effort, including observer and filesystem failures. */
    }
  }

  private write(project: string, name: string, type: string, payload: object): void {
    const allowed = [
      'session.created',
      'session.closed',
      'navigation.completed',
      'action.completed',
      'action.failed',
      'console.error',
      'network.failed',
      'dialog.opened',
      'screenshot.created',
      'video.saved',
      'trace.created',
      'workflow.started',
      'workflow.completed',
      'workflow.failed',
    ];
    if (!allowed.includes(type)) return;
    const record: Record<string, unknown> = { ts: new Date().toISOString(), type };
    for (const [key, value] of Object.entries(payload)) {
      if (
        ![
          'sessionId',
          'pageId',
          'name',
          'project',
          'url',
          'status',
          'durationMs',
          'action',
          'code',
          'message',
          'text',
          'count',
          'method',
          'failureCode',
          'path',
          'bytes',
          'runId',
          'workflow',
          'stepId',
        ].includes(key)
      )
        continue;
      record[key] =
        typeof value === 'string' && key === 'path'
          ? value // harness-generated artifact path; number redaction would corrupt timestamps
          : typeof value === 'string'
            ? (key === 'url'
                ? this.redactor.url(value)
                : this.redactor
                    .body(value, 4000)
                    .replace(/https?:\/\/[^\s"<>]+/g, (u) => this.redactor.url(u))
              ).slice(0, 4000)
            : value;
    }
    if (type === 'dialog.opened' && 'type' in payload) record.dialogType = payload.type;
    // Explicitly known secrets must not survive even when a site logs their raw values.
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== 'string') continue;
      let text = value;
      for (const [name, secret] of Object.entries(process.env)) {
        if (
          secret &&
          (name.startsWith('TG_SECRET_') ||
            name === 'TG_BROWSER_SESSION_KEY' ||
            name === this.cfg.http.tokenEnv ||
            name === this.cfg.network.proxy.usernameEnv ||
            name === this.cfg.network.proxy.passwordEnv)
        )
          text = text.split(secret).join('[REDACTED]');
      }
      record[key] = text;
    }
    const dir = path.join(
      this.cfg.dataDir,
      'journal',
      assertSafeName('project', project),
      assertSafeName('session', name),
    );
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'events.jsonl');
    const line = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(line) > this.cfg.journal.maxBytes) return;
    if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > this.cfg.journal.maxBytes)
      fs.renameSync(file, path.join(dir, 'events.1.jsonl'));
    fs.appendFileSync(file, line, { mode: 0o600 });
  }
}
