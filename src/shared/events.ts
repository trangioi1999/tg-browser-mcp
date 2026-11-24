import { EventEmitter } from 'node:events';

/** Typed lifecycle events, intended for external observers such as TG Studio. */
export interface HarnessEventMap {
  'browser.started': { browserId: string; engine: string; channel?: string; mode: 'launch' | 'connect' };
  'browser.closed': { browserId: string; reason: 'requested' | 'disconnected' | 'shutdown' };
  'session.created': { sessionId: string; name: string; project: string };
  'session.restored': { sessionId: string; name: string; project: string; cookies: number; origins: number };
  'session.closed': { sessionId: string; name: string };
  'navigation.started': { sessionId: string; pageId: string; url: string };
  'navigation.completed': {
    sessionId: string;
    pageId: string;
    url: string;
    status?: number;
    durationMs: number;
  };
  'action.started': {
    sessionId: string;
    pageId?: string;
    action: string;
    target?: string;
    correlationId: string;
  };
  'action.completed': {
    sessionId: string;
    pageId?: string;
    action: string;
    durationMs: number;
    correlationId: string;
  };
  'action.failed': {
    sessionId: string;
    pageId?: string;
    action: string;
    code: string;
    message: string;
    correlationId: string;
  };
  'workflow.started': { runId: string; workflow: string };
  'workflow.step': { runId: string; stepId: string; status: 'passed' | 'failed' | 'skipped' };
  'workflow.completed': { runId: string; workflow: string; durationMs: number };
  'workflow.failed': { runId: string; workflow: string; stepId?: string; code: string; message: string };
  'screenshot.created': { sessionId: string; pageId: string; path: string; bytes: number };
}

export type HarnessEventName = keyof HarnessEventMap;

export class TypedEmitter {
  private readonly ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(100);
  }

  on<K extends HarnessEventName>(event: K, listener: (payload: HarnessEventMap[K]) => void): () => void {
    this.ee.on(event, listener);
    return () => this.ee.off(event, listener);
  }

  /** Subscribe to every event; useful for forwarding to an external UI. */
  onAny(listener: (event: HarnessEventName, payload: HarnessEventMap[HarnessEventName]) => void): () => void {
    const wrapped = (e: { event: HarnessEventName; payload: HarnessEventMap[HarnessEventName] }) =>
      listener(e.event, e.payload);
    this.ee.on('*', wrapped);
    return () => this.ee.off('*', wrapped);
  }

  emit<K extends HarnessEventName>(event: K, payload: HarnessEventMap[K]): void {
    try {
      this.ee.emit(event, payload);
      this.ee.emit('*', { event, payload });
    } catch {
      // Observer failures must never break automation.
    }
  }
}
