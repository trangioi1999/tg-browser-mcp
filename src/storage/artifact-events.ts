import type { TypedEmitter } from '../shared/events.js';
import { getLogger } from '../shared/logger.js';
import { SqliteAdapter } from './sqlite-adapter.js';
import { SqliteArtifactRepository } from './sqlite-artifact-repository.js';

/** Subscribe at the harness boundary so action/session code remains independent of storage. */
export function indexArtifactEvents(dataDir: string, events: TypedEmitter): () => void {
  const sessions = new Map<string, { project: string; name: string }>();
  const off = [events.on('session.created', (e) => sessions.set(e.sessionId, e))];
  for (const [event, kind] of [
    ['screenshot.created', 'screenshot'],
    ['trace.created', 'trace'],
    ['video.saved', 'video'],
  ] as const) {
    off.push(
      events.on(event, (e) => {
        const session = sessions.get(e.sessionId);
        if (!session) return;
        try {
          const db = new SqliteAdapter(dataDir);
          try {
            new SqliteArtifactRepository(db, dataDir, session.project).register({
              path: e.path,
              kind,
              bytes: e.bytes,
              session: session.name,
            });
          } finally {
            db.close();
          }
        } catch (e) {
          // Explicit exports outside dataDir remain valid, but aren't managed artifacts.
          getLogger().warn({ err: (e as Error).message }, 'failed to index session artifact');
        }
      }),
    );
  }
  return () => {
    off.forEach((f) => f());
    sessions.clear();
  };
}
