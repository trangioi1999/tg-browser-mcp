import { z } from 'zod';
import { defineTool, json, text } from '../server/tool-registry.js';
import { browserShortcut } from '../config/load-config.js';

export const sessionTools = [
  defineTool({
    name: 'session_create',
    title: 'Create session',
    description:
      'Create an isolated browser session (own cookies/storage), e.g. one per user role (maker, checker). Optionally restore saved login state.',
    category: 'session',
    profile: 'testing',
    risk: 'interact',
    readOnly: false,
    timeoutMs: 90_000,
    input: {
      name: z.string(),
      project: z.string().optional(),
      restore: z.boolean().optional().describe('Restore saved state from session_save'),
      persistent: z.boolean().optional(),
      recordVideo: z.boolean().optional().describe('Override video recording for this session'),
      browser: z.enum(['chrome', 'edge', 'msedge', 'chromium', 'firefox', 'webkit']).optional(),
      url: z.string().optional().describe('Navigate after creating'),
    },
    handler: async (a, { harness }) => {
      const s = await harness.sessions.create({
        name: a.name,
        ...(a.recordVideo !== undefined ? { recordVideo: a.recordVideo } : {}),
        ...(a.project ? { project: a.project } : {}),
        ...(a.restore ? { restore: true } : {}),
        ...(a.persistent !== undefined ? { persistent: a.persistent } : {}),
        ...(a.browser ? { browser: browserShortcut(a.browser) } : {}),
      });
      let extra = '';
      if (a.url) {
        const r = await harness.actions.navigate(a.url, { session: s.name, project: s.project, snapshot: 'none' });
        extra = `\n${r.message}`;
      }
      return text(
        `✓ Session "${s.name}" (project ${s.project}) created and active${a.restore ? ' with restored state — application login may still have expired server-side' : ''}${extra}`,
      );
    },
  }),
  defineTool({
    name: 'session_list',
    title: 'List sessions',
    description: 'Active sessions and saved session states for the project.',
    category: 'session',
    profile: 'testing',
    risk: 'read',
    readOnly: true,
    timeoutMs: 10_000,
    input: { project: z.string().optional() },
    handler: async (a, { harness, config }) => {
      const project = a.project ?? config.project;
      const active = await Promise.all(harness.sessions.list(project).map((s) => s.info()));
      const saved = harness.store.list(project);
      const lines = [`Project: ${project}`, '', 'Active:'];
      for (const s of active)
        lines.push(
          `${harness.sessions.active?.name === s.name ? '*' : ' '} ${s.name}  pages=${s.pages.length}${s.persistent ? ' persistent' : ''}${s.connected ? ' cdp' : ''}`,
        );
      if (!active.length) lines.push('  (none)');
      lines.push('', 'Saved:');
      for (const m of saved)
        lines.push(
          `  ${m.name}  saved=${m.savedAt} cookies=${m.cookies} origins=${m.origins}${m.encrypted ? ' encrypted' : ''}`,
        );
      if (!saved.length) lines.push('  (none)');
      return text(lines.join('\n'));
    },
  }),
  defineTool({
    name: 'session_switch',
    title: 'Switch session',
    description: 'Make a session active; tools without `session` then act on it.',
    category: 'session',
    profile: 'testing',
    risk: 'read',
    readOnly: false,
    timeoutMs: 10_000,
    input: { name: z.string(), project: z.string().optional() },
    handler: async (a, { harness }) => {
      const s = harness.sessions.switch(a.name, a.project);
      const p = s.activePageId ? s.pages.get(s.activePageId) : undefined;
      return text(
        `✓ Active session: ${s.name}${p ? ` (tab ${p.id} ${harness.redactor.url(p.page.url())})` : ''}`,
      );
    },
  }),
  defineTool({
    name: 'session_save',
    title: 'Save session',
    description:
      'Save cookies, localStorage and IndexedDB of a session (encrypted at rest). sessionStorage is not persisted by browsers.',
    category: 'session',
    profile: 'testing',
    risk: 'interact',
    readOnly: false,
    timeoutMs: 30_000,
    input: { name: z.string().optional() },
    handler: async (a, { harness }) => {
      const r = await harness.sessions.save(a.name);
      return text(`✓ Saved "${r.name}" (${r.cookies} cookies, ${r.origins} origins) at ${r.savedAt}`);
    },
  }),
  defineTool({
    name: 'session_restore',
    title: 'Restore session',
    description:
      'Recreate a session from its saved state. Application sessions may have expired server-side; verify with a snapshot.',
    category: 'session',
    profile: 'testing',
    risk: 'interact',
    readOnly: false,
    timeoutMs: 90_000,
    input: { name: z.string(), project: z.string().optional(), url: z.string().optional() },
    handler: async (a, { harness }) => {
      const s = await harness.sessions.restore(a.name, a.project);
      let extra = '';
      if (a.url)
        extra = `\n${(await harness.actions.navigate(a.url, { session: s.name, project: s.project, snapshot: 'none' })).message}`;
      return text(`✓ Restored session "${s.name}"${extra}`);
    },
  }),
  defineTool({
    name: 'session_delete',
    title: 'Delete session',
    description: 'Close an active session and/or delete its saved state.',
    category: 'session',
    profile: 'testing',
    risk: 'interact',
    readOnly: false,
    timeoutMs: 30_000,
    input: { name: z.string(), project: z.string().optional(), deleteSaved: z.boolean().default(false) },
    handler: async (a, { harness, config }) => {
      const msgs: string[] = [];
      if (harness.sessions.find(a.name, a.project)) {
        await harness.sessions.close(a.name, a.project);
        msgs.push('closed');
      }
      if (a.deleteSaved && harness.store.delete(a.project ?? config.project, a.name))
        msgs.push('saved state deleted');
      return text(msgs.length ? `✓ ${a.name}: ${msgs.join(', ')}` : `Nothing to delete for "${a.name}"`);
    },
  }),
  defineTool({
    name: 'session_status',
    title: 'Session status',
    description: 'Details of one session: tabs, pending dialog, captured event counts.',
    category: 'session',
    profile: 'testing',
    risk: 'read',
    readOnly: true,
    timeoutMs: 10_000,
    input: { name: z.string().optional() },
    handler: async (a, { harness }) => {
      const s = harness.sessions.get(a.name);
      const info = await s.info();
      const dialogs = [...s.pages.values()]
        .filter((p) => p.pendingDialog)
        .map((p) => ({ pageId: p.id, type: p.pendingDialog!.type, message: p.pendingDialog!.message }));
      return json({
        ...info,
        pages: info.pages.map((p) => ({ ...p, url: harness.redactor.url(p.url) })),
        pendingDialogs: dialogs,
        captured: {
          requests: s.monitor.network({ limit: 1 }).total,
          console: s.monitor.console({ limit: 1 }).total,
          lastSeq: s.monitor.lastSeq,
        },
      });
    },
  }),
];

export const networkTools = [
  defineTool({
    name: 'network_diagnose',
    title: 'Diagnose connectivity',
    description:
      'Step-by-step check of how a URL is reached from this machine: domain policy → DNS → TCP/proxy → TLS → HTTP, using the configured proxy and CA.',
    category: 'network',
    profile: 'developer',
    risk: 'read',
    readOnly: true,
    timeoutMs: 45_000,
    input: { url: z.string() },
    handler: async (a, { harness }) => {
      const r = await harness.diagnose(a.url);
      const lines = [
        `${r.ok ? '✓' : '✗'} ${harness.redactor.url(r.url)}${r.viaProxy ? ` via proxy ${r.viaProxy}` : ' (direct)'}`,
      ];
      for (const s of r.steps)
        lines.push(
          `  ${s.ok ? '✓' : '✗'} ${s.step.padEnd(6)} ${String(s.durationMs).padStart(5)}ms  ${s.detail}${s.code ? `  [${s.code}]` : ''}`,
        );
      lines.push(
        r.conclusion,
        'Note: tests Node.js connectivity with the browser proxy/CA settings; the browser may also use OS proxy (PAC) and its own certificate store.',
      );
      return text(lines.join('\n'));
    },
  }),
  defineTool({
    name: 'network_proxy_status',
    title: 'Proxy status',
    description: 'Effective browser proxy configuration (credentials never shown).',
    category: 'network',
    profile: 'full',
    risk: 'read',
    readOnly: true,
    timeoutMs: 5_000,
    input: {},
    handler: async (_a, { harness }) => json(harness.proxy.status()),
  }),
  defineTool({
    name: 'network_connection_test',
    title: 'Connection test',
    description: 'Quick reachability test of several URLs (policy, DNS, TCP/proxy, TLS, HTTP).',
    category: 'network',
    profile: 'full',
    risk: 'read',
    readOnly: true,
    timeoutMs: 90_000,
    input: { urls: z.array(z.string()).min(1).max(10) },
    handler: async (a, { harness }) => {
      const results = await Promise.all(
        a.urls.map((u) =>
          harness
            .diagnose(u)
            .catch((e: Error) => ({ url: u, ok: false, conclusion: e.message, steps: [], viaProxy: null })),
        ),
      );
      return text(
        results.map((r) => `${r.ok ? '✓' : '✗'} ${harness.redactor.url(r.url)} — ${r.conclusion}`).join('\n'),
      );
    },
  }),
  defineTool({
    name: 'network_certificate_status',
    title: 'Certificate status',
    description:
      'Configured corporate CA certificates and where each layer (Node, Chrome, Firefox) gets trust from.',
    category: 'network',
    profile: 'full',
    risk: 'read',
    readOnly: true,
    timeoutMs: 5_000,
    input: {},
    handler: async (_a, { harness }) => json(harness.certificates.status()),
  }),
];
