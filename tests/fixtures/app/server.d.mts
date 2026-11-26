import type { Server } from 'node:http';
export function createFixtureServer(): {
  server: Server;
  requests: Map<string, { id: string; customer: string; status: string }>;
  /** Server-side count of POST /api/slow-submit requests (TGB-007/009). */
  slow: { submits: number };
  listen(port?: number): Promise<string>;
  close(): Promise<void>;
};
