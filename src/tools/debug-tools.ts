import { z } from 'zod';
import { defineTool, json, text, PageAddress } from '../server/tool-registry.js';
import { formatConsole, formatNetwork } from '../network/network-monitor.js';
import { TgError } from '../shared/errors.js';

export const debugTools = [
  defineTool({
    name: 'browser_console',
    title: 'Console messages',
    description:
      'Console messages (deduplicated, ×N = repeats). Use sinceSeq from a previous call to get only new messages.',
    category: 'debugging',
    profile: 'developer',
    risk: 'read',
    readOnly: true,
    timeoutMs: 10_000,
    input: {
      types: z
        .array(z.enum(['log', 'debug', 'info', 'error', 'warning', 'pageerror', 'trace', 'dir']))
        .optional(),
      sinceSeq: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      ...PageAddress,
    },
    handler: async (a, { harness }) => {
      const s = harness.sessions.get(a.session);
      const r = s.monitor.console({
        ...(a.types ? { types: a.types } : {}),
        ...(a.pageId ? { pageId: a.pageId } : {}),
        ...(a.sinceSeq ? { sinceSeq: a.sinceSeq } : {}),
        limit: a.limit ?? 50,
      });
      return text(
        `${r.entries.length}/${r.total} messages (seq=${s.monitor.lastSeq})\n${formatConsole(r.entries) || '(none)'}`,
      );
    },
  }),
  defineTool({
    name: 'browser_errors',
    title: 'Errors summary',
    description:
      'JavaScript errors, console errors, failed requests and HTTP ≥400 responses — the fastest way to debug a broken page.',
    category: 'debugging',
    profile: 'developer',
    risk: 'read',
    readOnly: true,
    timeoutMs: 10_000,
    input: { sinceSeq: z.number().int().min(0).optional(), ...PageAddress },
    handler: async (a, { harness }) => {
      const s = harness.sessions.get(a.session);
      const e = s.monitor.errors(a.pageId, a.sinceSeq);
      const parts = [`seq=${s.monitor.lastSeq}`];
      parts.push(`Console/JS errors (${e.console.length}):`, formatConsole(e.console) || '(none)');
      parts.push(`Network errors (${e.network.length}):`, formatNetwork(e.network) || '(none)');
      const cors = e.console.filter((c) => /CORS|Access-Control-Allow-Origin/i.test(c.text)).length;
      const remote = e.network.filter((n) => /remoteEntry|federation|mf-manifest/i.test(n.url)).length;
      if (cors)
        parts.push(`Hint: ${cors} CORS error(s) — check Access-Control-Allow-Origin on the API/remote.`);
      if (remote)
        parts.push(
          `Hint: ${remote} micro-frontend remote(s) failed to load — check the remote URL/manifest and that the remote dev server is running.`,
        );
      return text(parts.join('\n'));
    },
  }),
  defineTool({
    name: 'browser_network_requests',
    title: 'Network requests',
    description:
      'Captured requests, newest last. Filter by url substring, method, status (number, "failed" or "error"), resourceType, sinceSeq or sinceMs. Bodies are never included here.',
    category: 'debugging',
    profile: 'developer',
    risk: 'read',
    readOnly: true,
    timeoutMs: 10_000,
    input: {
      url: z.string().optional(),
      method: z.string().optional(),
      status: z.union([z.number().int(), z.enum(['failed', 'error'])]).optional(),
      resourceType: z
        .string()
        .optional()
        .describe('document, xhr, fetch, script, stylesheet, image, websocket...'),
      apiOnly: z.boolean().optional().describe('Only xhr/fetch'),
      sinceSeq: z.number().int().min(0).optional(),
      sinceMs: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      ...PageAddress,
    },
    handler: async (a, { harness }) => {
      const s = harness.sessions.get(a.session);
      let r = s.monitor.network({
        ...(a.url ? { url: a.url } : {}),
        ...(a.method ? { method: a.method } : {}),
        ...(a.status !== undefined ? { status: a.status } : {}),
        ...(a.resourceType ? { resourceType: a.resourceType } : {}),
        ...(a.pageId ? { pageId: a.pageId } : {}),
        ...(a.sinceSeq ? { sinceSeq: a.sinceSeq } : {}),
        ...(a.sinceMs ? { sinceMs: a.sinceMs } : {}),
        limit: a.apiOnly ? 10_000 : (a.limit ?? 50),
      });
      if (a.apiOnly) {
        const entries = r.entries.filter((e) => e.resourceType === 'xhr' || e.resourceType === 'fetch');
        r = { total: entries.length, entries: entries.slice(-(a.limit ?? 50)) };
      }
      return text(
        `${r.entries.length}/${r.total} requests (seq=${s.monitor.lastSeq})\n${formatNetwork(r.entries) || '(none)'}`,
      );
    },
  }),
  defineTool({
    name: 'browser_network_details',
    title: 'Request details',
    description:
      'Headers (redacted) and, if network.capture.captureBodies is enabled, redacted bodies for one request id (e.g. r12).',
    category: 'debugging',
    profile: 'developer',
    risk: 'read',
    readOnly: true,
    timeoutMs: 10_000,
    input: { id: z.string(), session: PageAddress.session },
    handler: async (a, { harness, config }) => {
      const s = harness.sessions.get(a.session);
      const e = s.monitor.detail(a.id);
      if (!e)
        throw new TgError(
          'INVALID_ARGUMENT',
          `Request ${a.id} not found (it may have been evicted from the buffer)`,
        );
      return json({
        ...e,
        ...(config.network.capture.captureBodies
          ? {}
          : { note: 'Bodies are disabled (network.capture.captureBodies=false).' }),
      });
    },
  }),
  defineTool({
    name: 'browser_performance',
    title: 'Performance metrics',
    description: 'Navigation timing, FCP/LCP, resources by type, slowest resources, DOM size and JS heap.',
    category: 'debugging',
    profile: 'developer',
    risk: 'read',
    readOnly: true,
    timeoutMs: 20_000,
    input: PageAddress,
    handler: async (a, { harness }) =>
      json(
        await harness.actions.performance({
          ...(a.session ? { session: a.session } : {}),
          ...(a.pageId ? { pageId: a.pageId } : {}),
        }),
      ),
  }),
  defineTool({
    name: 'browser_trace_start',
    title: 'Start trace',
    description: 'Start a Playwright trace (screenshots + DOM snapshots) for the session.',
    category: 'debugging',
    profile: 'testing',
    risk: 'interact',
    readOnly: false,
    timeoutMs: 20_000,
    input: { session: PageAddress.session },
    handler: async (a, { harness }) => {
      const r = await harness.actions.traceStart(a.session ? { session: a.session } : {});
      return text(`✓ Tracing started for session ${r.session}`);
    },
  }),
  defineTool({
    name: 'browser_trace_stop',
    title: 'Stop trace',
    description: 'Stop tracing and save the trace zip (open with `npx playwright show-trace <file>`).',
    category: 'debugging',
    profile: 'testing',
    risk: 'interact',
    readOnly: false,
    timeoutMs: 60_000,
    input: { path: z.string().optional(), session: PageAddress.session },
    handler: async (a, { harness }) => {
      const r = await harness.actions.traceStop(a.path, a.session ? { session: a.session } : {});
      return text(
        `✓ Trace saved: ${r.path} (${Math.round(r.bytes / 1024)}KB). View: npx playwright show-trace "${r.path}"`,
      );
    },
  }),
];
