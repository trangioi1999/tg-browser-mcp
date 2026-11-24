import type { Server } from 'node:http';
export function createFixtureServer(): {
  server: Server;
  requests: Map<string, { id: string; customer: string; status: string }>;
  listen(port?: number): Promise<string>;
  close(): Promise<void>;
};
