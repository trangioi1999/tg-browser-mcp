import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { TgConfig } from '../../config/schema.js';
import { createMcpServer } from '../mcp-server.js';
import { getLogger } from '../../shared/logger.js';

/**
 * STDIO transport: stdout carries ONLY MCP JSON-RPC frames. All logs go to stderr.
 * The browser is closed when the client disconnects (stdin closes) or on SIGINT/SIGTERM.
 */
export async function startStdio(config: TgConfig): Promise<void> {
  const handle = createMcpServer(config);
  const transport = new StdioServerTransport();
  let closing = false;
  const shutdown = async (reason: string) => {
    if (closing) return;
    closing = true;
    getLogger().info({ reason }, 'shutting down');
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    await handle.close().catch(() => undefined);
    process.exit(0);
  };
  process.stdin.on('end', () => void shutdown('stdin closed'));
  process.stdin.on('close', () => void shutdown('stdin closed'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
  transport.onclose = () => void shutdown('transport closed');
  await handle.server.connect(transport);
  getLogger().info(
    { tools: handle.tools.length, profile: config.tools.profile, project: config.project },
    'tg-browser-mcp ready (stdio)',
  );
}
