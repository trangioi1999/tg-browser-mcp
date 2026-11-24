import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load-config.js';
import { TypedEmitter } from '../../src/shared/events.js';
import { DataRedactor } from '../../src/security/data-redactor.js';
import { SessionJournal } from '../../src/journal/session-journal.js';
import { tmpDir } from '../helpers.js';

describe('session journal', () => {
  it('redacts metadata, excludes action input, and uses private file modes', () => {
    const dataDir = tmpDir();
    const events = new TypedEmitter();
    new SessionJournal(parseConfig({ dataDir }), new DataRedactor(), events);
    events.emit('session.created', { sessionId: 's1', name: 'demo', project: 'test' });
    events.emit('navigation.completed', {
      sessionId: 's1',
      pageId: 'p1',
      url: 'https://user:pass@example.com/?token=secret&code=private',
      durationMs: 1,
    });
    events.emit('console.error', {
      sessionId: 's1',
      text: 'Bearer abc123 https://example.com/?token=hidden',
      count: 1,
    });
    events.emit('action.started', {
      sessionId: 's1',
      action: 'fill',
      target: 'never-store',
      correlationId: 'c',
    });
    const file = path.join(dataDir, 'journal/test/demo/events.jsonl');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toMatch(/secret|private|abc123|hidden|never-store|user:pass/);
    expect(text).toContain('REDACTED');
    expect(text.trim().split('\n')).toHaveLength(3);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });
  it('redacts structured console secrets and known environment secret values', () => {
    const dataDir = tmpDir(),
      events = new TypedEmitter();
    const previous = process.env.TG_SECRET_JOURNAL_TEST;
    process.env.TG_SECRET_JOURNAL_TEST = 'plain-secret-value';
    try {
      new SessionJournal(parseConfig({ dataDir }), new DataRedactor(), events);
      events.emit('session.created', { sessionId: 's', name: 'demo', project: 'test' });
      events.emit('console.error', { sessionId: 's', text: '{"password":"json-secret"}', count: 1 });
      events.emit('console.error', { sessionId: 's', text: 'site echoed plain-secret-value', count: 1 });
      expect(fs.readFileSync(path.join(dataDir, 'journal/test/demo/events.jsonl'), 'utf8')).not.toMatch(
        /json-secret|plain-secret-value/,
      );
    } finally {
      if (previous === undefined) delete process.env.TG_SECRET_JOURNAL_TEST;
      else process.env.TG_SECRET_JOURNAL_TEST = previous;
    }
  });
  it('rotates at the configured size and keeps only two files', () => {
    const dataDir = tmpDir();
    const events = new TypedEmitter();
    new SessionJournal(parseConfig({ dataDir, journal: { maxBytes: 1024 } }), new DataRedactor(), events);
    events.emit('session.created', { sessionId: 's', name: 'demo', project: 'test' });
    for (let i = 0; i < 50; i++)
      events.emit('console.error', { sessionId: 's', text: 'x'.repeat(150), count: 1 });
    const dir = path.join(dataDir, 'journal/test/demo');
    expect(fs.readdirSync(dir).sort()).toEqual(['events.1.jsonl', 'events.jsonl']);
    for (const f of fs.readdirSync(dir))
      expect(fs.statSync(path.join(dir, f)).size).toBeLessThanOrEqual(1024);
  });
  it('handles disabled logging and filesystem failures without throwing', () => {
    const dataDir = tmpDir();
    const events = new TypedEmitter();
    new SessionJournal(parseConfig({ dataDir, journal: { enabled: false } }), new DataRedactor(), events);
    events.emit('session.created', { sessionId: 's', name: 'demo', project: 'test' });
    expect(fs.existsSync(path.join(dataDir, 'journal'))).toBe(false);
    fs.writeFileSync(path.join(dataDir, 'journal'), 'blocked');
    new SessionJournal(parseConfig({ dataDir }), new DataRedactor(), events);
    expect(() =>
      events.emit('session.created', { sessionId: 's', name: 'demo', project: 'test' }),
    ).not.toThrow();
  });
  it('associates workflow events only with participating sessions', () => {
    const dataDir = tmpDir(),
      events = new TypedEmitter();
    new SessionJournal(parseConfig({ dataDir }), new DataRedactor(), events);
    events.emit('workflow.failed', {
      runId: 'run',
      workflow: 'demo',
      code: 'FAILED',
      message: 'failure',
      sessions: [{ sessionId: 's', name: 'maker', project: 'test' }],
    });
    expect(fs.readFileSync(path.join(dataDir, 'journal/test/maker/events.jsonl'), 'utf8')).toContain(
      'workflow.failed',
    );
  });
});

describe('video configuration', () => {
  it('defaults off and validates modes and dimensions', () => {
    expect(parseConfig({}).recording.video).toBe('off');
    for (const video of ['on', 'retain-on-failure'] as const)
      expect(parseConfig({ recording: { video, size: { width: 640, height: 480 } } }).recording.video).toBe(
        video,
      );
    expect(() => parseConfig({ recording: { size: { width: 0, height: 480 } } })).toThrow();
  });
});
