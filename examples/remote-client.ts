/**
 * Calling a deployed TG Browser MCP from another project.
 *   TG_BROWSER_URL=https://tg-browser-mcp.<sub>.workers.dev/mcp TG_BROWSER_TOKEN=… npx tsx examples/remote-client.ts https://example.com
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.TG_BROWSER_URL;
const token = process.env.TG_BROWSER_TOKEN;
if (!url || !token) throw new Error('Set TG_BROWSER_URL and TG_BROWSER_TOKEN');

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const text = (r: ToolResult) => r.content.flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('\n');

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'my-project', version: '1.0.0' });
await client.connect(transport);
try {
  const target = process.argv[2] ?? 'https://example.com';
  const nav = (await client.callTool({ name: 'browser_navigate', arguments: { url: target } })) as ToolResult;
  console.log(text(nav));
  const errors = (await client.callTool({ name: 'browser_errors', arguments: {} })) as ToolResult;
  console.log(text(errors));
} finally {
  // Free the server-side browser immediately instead of waiting for the idle timeout.
  await transport.terminateSession().catch(() => undefined);
  await client.close();
}
