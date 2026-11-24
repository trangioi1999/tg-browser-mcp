import { z } from 'zod';
import { defineTool, json, text, PageAddress } from '../server/tool-registry.js';
import { browserShortcut } from '../config/load-config.js';
import { detectBrowsers } from '../browser/browser-detector.js';

const BrowserName = z.enum(['chrome', 'edge', 'msedge', 'chromium', 'firefox', 'webkit', 'chrome-beta']);

export const browserTools = [
  defineTool({
    name: 'browser_launch',
    title: 'Launch browser session',
    description:
      'Launch a browser and create a session (isolated context). Usually unnecessary: other tools start the default session automatically.',
    category: 'browser',
    profile: 'full',
    risk: 'interact',
    readOnly: false,
    timeoutMs: 90_000,
    input: {
      session: z.string().default('default').describe('Session name'),
      browser: BrowserName.optional(),
      headless: z.boolean().optional(),
      persistent: z.boolean().optional().describe('Use a dedicated on-disk automation profile'),
    },
    handler: async (a, { harness }) => {
      const spec = {
        ...(a.browser ? browserShortcut(a.browser) : {}),
        ...(a.headless !== undefined ? { headless: a.headless } : {}),
      };
      const s = await harness.sessions.create({
        name: a.session,
        ...(a.persistent !== undefined ? { persistent: a.persistent } : {}),
        ...(Object.keys(spec).length ? { browser: spec } : {}),
      });
      const b = harness.browsers.list().find((x) => x.id === s.browserId);
      return text(
        `✓ Session "${s.name}" started (${b?.channel ?? b?.engine} ${b?.version ?? ''}${b?.headless ? ', headless' : ''}${s.persistent ? ', persistent profile' : ''}). Active page: ${s.activePageId}`,
      );
    },
  }),
  defineTool({
    name: 'browser_close',
    title: 'Close session',
    description:
      'Close a browser session (its context and tabs). Closes the active session when none is given.',
    category: 'browser',
    profile: 'developer',
    risk: 'interact',
    readOnly: false,
    timeoutMs: 30_000,
    input: { session: PageAddress.session },
    handler: async (a, { harness }) => {
      const s = harness.sessions.get(a.session);
      await harness.sessions.close(s.name, s.project);
      if (harness.sessions.size === 0) await harness.browsers.closeAll();
      return text(`✓ Closed session "${s.name}"`);
    },
  }),
  defineTool({
    name: 'browser_status',
    title: 'Browser status',
    description: 'Running browsers, sessions and tool metrics.',
    category: 'browser',
    profile: 'developer',
    risk: 'read',
    readOnly: true,
    timeoutMs: 10_000,
    input: {},
    handler: async (_a, { harness }) => {
      const sessions = await Promise.all(harness.sessions.list().map((s) => s.info()));
      return json({
        browsers: harness.browsers.list(),
        activeSession: harness.sessions.active?.name ?? null,
        sessions: sessions.map((s) => ({
          name: s.name,
          project: s.project,
          browserId: s.browserId,
          pages: s.pages.length,
          persistent: s.persistent,
        })),
        metrics: harness.audit.metrics(),
      });
    },
  }),
  defineTool({
    name: 'browser_list',
    title: 'List installed browsers',
    description: 'Browsers detected on this machine (system Chrome/Edge and Playwright-managed).',
    category: 'browser',
    profile: 'full',
    risk: 'read',
    readOnly: true,
    timeoutMs: 10_000,
    input: {},
    handler: async () =>
      text(
        detectBrowsers()
          .map((b) => `${b.id}\t${b.name}\t${b.source}`)
          .join('\n') || 'No browsers detected. Run `npx playwright install chromium` or install Chrome.',
      ),
  }),
  defineTool({
    name: 'browser_connect',
    title: 'Connect to Chromium via CDP',
    description:
      'Attach to an already running Chromium (started with --remote-debugging-port). Localhost only by default. Requires approval.',
    category: 'browser',
    profile: 'full',
    risk: 'high',
    readOnly: false,
    timeoutMs: 60_000,
    input: {
      endpoint: z.string().describe('e.g. http://127.0.0.1:9222'),
      session: z.string().default('cdp'),
    },
    handler: async (a, { harness }) => {
      await harness.permissions.requireApproval(
        'highRisk',
        'Connect to an existing browser',
        `Attach automation to the browser at ${a.endpoint}. The agent will be able to control its tabs.`,
      );
      const s = await harness.sessions.connect(a.endpoint, a.session);
      return text(`✓ Connected as session "${s.name}" with ${s.pages.size} page(s)`);
    },
  }),
  defineTool({
    name: 'browser_disconnect',
    title: 'Disconnect CDP session',
    description: 'Disconnect from a browser attached with browser_connect (the browser keeps running).',
    category: 'browser',
    profile: 'full',
    risk: 'interact',
    readOnly: false,
    timeoutMs: 20_000,
    input: { session: z.string().default('cdp') },
    handler: async (a, { harness }) => {
      await harness.sessions.close(a.session);
      return text(`✓ Disconnected "${a.session}"`);
    },
  }),
  defineTool({
    name: 'browser_resize',
    title: 'Resize viewport',
    description: 'Set the viewport size of a tab (responsive testing).',
    category: 'browser',
    profile: 'developer',
    risk: 'interact',
    readOnly: false,
    timeoutMs: 10_000,
    input: {
      width: z.number().int().min(200).max(7680),
      height: z.number().int().min(200).max(4320),
      ...PageAddress,
    },
    handler: async (a, { harness }) => {
      const r = await harness.actions.resize(a.width, a.height, {
        ...(a.session ? { session: a.session } : {}),
        ...(a.pageId ? { pageId: a.pageId } : {}),
      });
      return text(`✓ Viewport ${r.width}x${r.height}`);
    },
  }),
];
