import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ConfigSchema, ToolProfileSchema, type TgConfig } from '../config/schema.js';
import { loadConfig, parseConfig, readConfigFile, type CliOverrides } from '../config/load-config.js';
import { assertSafeName, isPathInside } from '../shared/util.js';
import { DataRedactor } from '../security/data-redactor.js';
import { SessionStore } from '../session/session-store.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { WorkflowEngine } from '../workflow/workflow-engine.js';
import { ProxyManager } from '../network/proxy-manager.js';
import { CertificateManager } from '../network/certificate-manager.js';
import { detectBrowsers } from '../browser/browser-detector.js';
import { ALL_TOOLS } from '../tools/index.js';
import { selectTools } from '../server/tool-registry.js';
import { VERSION } from '../version.js';
import type { JournalEvent } from '../journal/session-journal.js';

const CSP =
  "default-src 'self'; img-src 'self' data:; media-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'";
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.jsonl': 'text/plain; charset=utf-8',
};
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function equal(a: string, b: string): boolean {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function names(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => {
      try {
        assertSafeName('name', n);
        return !fs.lstatSync(path.join(dir, n)).isSymbolicLink();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** Resolve against the lexical root as well as the real root; even a symlinked root is refused. */
export function safeFile(dataDir: string, relative: string, roots = ['artifacts', 'journal']): string {
  const parts = relative.split('/');
  if (
    relative.includes('\\') ||
    path.isAbsolute(relative) ||
    parts.some((p) => !p || p === '..' || p === '.') ||
    !roots.includes(parts[0] ?? '')
  )
    throw new HttpError(403, 'Đường dẫn bị từ chối');
  const base = fs.realpathSync(dataDir);
  const root = path.join(base, parts[0]!);
  const file = fs.realpathSync(path.join(base, ...parts));
  if (fs.realpathSync(root) !== root || !isPathInside(root, file))
    throw new HttpError(403, 'Đường dẫn bị từ chối');
  return file;
}

/** Config stays editable: preserve env variable names, omit unknown fields, scrub URL credentials. */
function publicConfig(raw: unknown): unknown {
  const r = new DataRedactor();
  const visit = (v: unknown, key = ''): unknown => {
    if (typeof v === 'string') {
      if (/server|endpoint|url/i.test(key)) {
        try {
          const normalized = new URL(v).toString();
          const redacted = r.url(v);
          return normalized === redacted ? v : redacted;
        } catch {
          return r.text(v);
        }
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => visit(x, key));
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(
            ([k]) =>
              !/^(password|username|token|secret|authorization|cookie)$/i.test(k) &&
              !k.startsWith('TG_SECRET_') &&
              k !== 'TG_BROWSER_SESSION_KEY',
          )
          .map(([k, x]) => [k, visit(x, k)]),
      );
    return v;
  };
  return visit(raw);
}

let tokenCache: Record<string, number> | undefined;
function toolTokens(): Record<string, number> {
  tokenCache ??= Object.fromEntries(
    ToolProfileSchema.options.map((profile) => {
      const json = selectTools(ALL_TOOLS, { profile, enabled: [], disabled: [] }).map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: z.toJSONSchema(z.object(t.input)),
      }));
      return [profile, Math.ceil(JSON.stringify(json).length / 4)];
    }),
  );
  return tokenCache;
}

export async function startDashboard(
  config: TgConfig,
  options: { port?: number; host?: string; file?: string; cwd?: string; overrides?: CliOverrides } = {},
) {
  if (options.host && options.host !== '127.0.0.1') throw new Error('Dashboard binds to 127.0.0.1 only');
  const token = randomBytes(32).toString('hex');
  const file = path.resolve(
    options.file ?? path.join(options.cwd ?? process.cwd(), 'tg-browser.config.json'),
  );
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const dataDir = fs.realpathSync(config.dataDir);
  const redactor = new DataRedactor(config.security.sensitiveFields);
  let effective = config;
  let origin = '';
  // Server-generated file references must stay intact: number redaction would corrupt timestamped names.
  const FILE_KEYS = new Set(['path', 'url', 'command', 'file', 'screenshot']);
  const clean = (v: unknown, key = ''): unknown => {
    if (typeof v === 'string') {
      let s =
        FILE_KEYS.has(key) && !/^https?:/i.test(v)
          ? v
          : redactor.text(v).replace(/https?:\/\/[^\s"<>]+/g, (u) => redactor.url(u));
      for (const [k, value] of Object.entries(process.env))
        if (
          value &&
          (k.startsWith('TG_SECRET_') ||
            k === 'TG_BROWSER_SESSION_KEY' ||
            k === config.http.tokenEnv ||
            k === config.network.proxy.usernameEnv ||
            k === config.network.proxy.passwordEnv)
        )
          s = s.split(value).join('[REDACTED]');
      return s;
    }
    if (Array.isArray(v)) return v.map((x) => clean(x, key));
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(
            ([k]) =>
              ![
                'variables',
                'extracted',
                'requestHeaders',
                'responseHeaders',
                'requestBody',
                'responseBody',
              ].includes(k),
          )
          .map(([k, val]) => [k, clean(val, k)]),
      );
    return v;
  };
  const projects = () =>
    [
      ...new Set(
        ['journal', 'runs', 'artifacts', 'sessions', 'workflows'].flatMap((r) =>
          names(path.join(dataDir, r)).filter((n) => {
            try {
              return fs.statSync(safeFile(dataDir, `${r}/${n}`, [r])).isDirectory();
            } catch {
              return false;
            }
          }),
        ),
      ),
    ].sort();
  const events = (project: string, name: string): JournalEvent[] =>
    ['events.1.jsonl', 'events.jsonl'].flatMap((f) => {
      try {
        return fs
          .readFileSync(safeFile(dataDir, `journal/${project}/${name}/${f}`), 'utf8')
          .split('\n')
          .flatMap((line) => {
            try {
              const e = JSON.parse(line) as JournalEvent;
              return typeof e.ts === 'string' && typeof e.type === 'string' ? [e] : [];
            } catch {
              return [];
            }
          });
      } catch {
        return [];
      }
    });
  const artifact = (p: string) => {
    try {
      const relative = path.relative(dataDir, fs.realpathSync(p)).split(path.sep).join('/');
      const resolved = safeFile(dataDir, relative);
      if (!fs.statSync(resolved).isFile()) return undefined;
      return {
        path: relative,
        url: '/files/' + relative.split('/').map(encodeURIComponent).join('/'),
        bytes: fs.statSync(resolved).size,
        ...(path.extname(resolved) === '.zip'
          ? {
              command:
                process.platform === 'win32'
                  ? `npx playwright show-trace "${resolved}"`
                  : `npx playwright show-trace '${resolved.replaceAll("'", "'\"'\"'")}'`,
            }
          : {}),
      };
    } catch {
      return undefined;
    }
  };
  const walk = (relative: string): string[] => {
    try {
      const dir = safeFile(dataDir, relative);
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((d) =>
          d.isSymbolicLink()
            ? []
            : d.isDirectory()
              ? walk(`${relative}/${d.name}`)
              : [path.join(dir, d.name)],
        );
    } catch {
      return [];
    }
  };
  const summary = (project: string, name: string) => {
    const es = events(project, name);
    const paths = new Set(walk(`artifacts/${project}/${name}`));
    for (const e of es) if (typeof e.path === 'string') paths.add(e.path);
    const files = [
      ...new Map(
        [...paths].flatMap((p) => {
          const a = artifact(p);
          return a ? [[a.url, a] as const] : [];
        }),
      ).values(),
    ];
    const screenshots = files.filter((f) => /\.(png|jpe?g)$/i.test(f.path));
    const videos = files.filter((f) => /\.webm$/i.test(f.path));
    const traces = files.filter((f) => /\.zip$/i.test(f.path));
    let saved;
    try {
      safeFile(dataDir, `sessions/${project}`, ['sessions']);
      for (const entry of fs.readdirSync(path.join(dataDir, 'sessions', project)))
        if (entry.endsWith('.meta.json')) safeFile(dataDir, `sessions/${project}/${entry}`, ['sessions']);
      saved = new SessionStore(dataDir, config.sessions.encrypt).list(project).find((m) => m.name === name);
    } catch {
      /* no saved state */
    }
    return {
      project,
      name,
      firstActivity: es[0]?.ts ?? saved?.savedAt,
      lastActivity: es.at(-1)?.ts ?? saved?.savedAt,
      counts: {
        actions: es.filter((e) => e.type === 'action.completed' || e.type === 'action.failed').length,
        errors: es.filter((e) =>
          ['action.failed', 'console.error', 'network.failed', 'workflow.failed'].includes(e.type),
        ).length,
        screenshots: screenshots.length,
        videos: videos.length,
        traces: traces.length,
      },
      saved: saved ? { cookies: saved.cookies, origins: saved.origins, savedAt: saved.savedAt } : null,
      screenshots,
      videos,
      traces,
    };
  };
  const sessions = (project: string) => {
    const found = new Set(
      ['journal', 'artifacts'].flatMap((r) => {
        try {
          return names(safeFile(dataDir, `${r}/${project}`)).filter(
            (name) =>
              r === 'journal' ||
              walk(`artifacts/${project}/${name}`).some((p) => /\.(png|jpe?g|webm|zip)$/i.test(p)),
          );
        } catch {
          return [];
        }
      }),
    );
    try {
      for (const n of names(safeFile(dataDir, `sessions/${project}`, ['sessions'])))
        if (n.endsWith('.meta.json')) found.add(n.slice(0, -10));
    } catch {
      /* no saved sessions */
    }
    return [...found]
      .map((n) => summary(project, assertSafeName('session', n)))
      .sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
  };
  const runs = (project: string, runId?: string) => {
    // The UI only uses the engine's read methods; no browser is started.
    const h = new BrowserHarness({ ...config, project, journal: { ...config.journal, enabled: false } });
    const engine = new WorkflowEngine(h);
    if (runId) {
      safeFile(dataDir, `runs/${project}/${runId}.json`, ['runs']);
      const run = engine.getRun(runId);
      return {
        ...run,
        failure: run.failure
          ? {
              ...run.failure,
              screenshotFile: run.failure.screenshot ? artifact(run.failure.screenshot) : undefined,
            }
          : undefined,
        reports: [
          ...new Set([
            ...(run.reports ?? []),
            ...walk(`artifacts/${project}`).filter((p) => p.includes(runId)),
          ]),
        ]
          .filter((p) => /\.(md|xml)$/.test(p))
          .flatMap((p) => {
            const a = artifact(p);
            return a ? [a] : [];
          }),
      };
    }
    try {
      safeFile(dataDir, `runs/${project}`, ['runs']);
    } catch {
      return [];
    }
    // Check every checkpoint before the engine reads the directory; it must not follow links.
    for (const name of fs.readdirSync(path.join(dataDir, 'runs', project))) {
      if (name.endsWith('.json')) safeFile(dataDir, `runs/${project}/${name}`, ['runs']);
    }
    return engine.listRuns(100).map((r) => ({ ...r, project }));
  };
  /** Saved workflow definitions. Step inputs are summarised to their target only: never values. */
  const workflows = (project: string, name?: string) => {
    try {
      safeFile(dataDir, `workflows/${project}`, ['workflows']);
    } catch {
      if (name) throw new HttpError(404, 'Không tìm thấy workflow');
      return [];
    }
    for (const f of fs.readdirSync(path.join(dataDir, 'workflows', project)))
      if (f.endsWith('.json')) safeFile(dataDir, `workflows/${project}/${f}`, ['workflows']);
    const h = new BrowserHarness({ ...config, project, journal: { ...config.journal, enabled: false } });
    const engine = new WorkflowEngine(h);
    const allRuns = (() => {
      try {
        return runs(project) as Array<{ workflow: string; status: string; startedAt: string }>;
      } catch {
        return [];
      }
    })();
    const history = (wf: string) => allRuns.filter((r) => r.workflow === wf);
    if (!name)
      return engine.listDefinitions().map((d) => {
        const rs = history(d.name);
        return {
          project,
          id: path.basename(d.file, '.json'),
          name: d.name,
          steps: d.steps,
          sessions: d.sessions,
          runs: rs.length,
          lastRun: rs[0] ? { status: rs[0].status, startedAt: rs[0].startedAt } : null,
        };
      });
    const def = engine.listDefinitions().find((d) => path.basename(d.file, '.json') === name);
    if (!def) throw new HttpError(404, 'Không tìm thấy workflow');
    const wf = engine.loadDefinition(def.name);
    const target = (input: Record<string, unknown> | undefined, action: unknown): string => {
      if (!input) return '';
      // For typing actions `text` is what gets typed, not a locator: never show it.
      const typed = ['type', 'fill', 'press'].includes(String(action));
      const pick = [
        'role',
        'name',
        'label',
        'testId',
        'placeholder',
        'targetText',
        ...(typed ? [] : ['text']),
        'selector',
        'url',
        'key',
      ]
        .filter((k) => typeof input[k] === 'string')
        .map((k) => `${k}=${String(input[k])}`);
      if (Array.isArray(input.fields))
        pick.push(
          `fields=${(input.fields as Array<Record<string, unknown>>)
            .map((f) => String(f.label ?? f.name ?? f.testId ?? f.placeholder ?? '?'))
            .join(', ')}`,
        );
      return pick.join(' ');
    };
    return {
      project,
      id: name,
      name: wf.name,
      sessions: def.sessions,
      steps: wf.steps.map((st) => {
        const step = st as unknown as Record<string, unknown>;
        return {
          id: step.id,
          session: step.session ?? 'default',
          action: step.action,
          target: target(step.input as Record<string, unknown> | undefined, step.action),
          dependsOn: step.dependsOn ?? [],
        };
      }),
      runs: history(wf.name).slice(0, 20),
    };
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(clean(value)));
    };
    try {
      const port = (server.address() as import('node:net').AddressInfo).port;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? ''))
        throw new HttpError(403, 'Host không hợp lệ');
      const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0]!);
      if (
        !rawPath.startsWith('/') ||
        rawPath.includes('//') ||
        rawPath.includes('\\') ||
        rawPath.split('/').some((p) => p === '..' || p === '.')
      )
        throw new HttpError(403, 'Đường dẫn bị từ chối');
      const u = new URL(req.url ?? '/', origin);
      if (req.method === 'GET' && rawPath === '/' && u.searchParams.has('token')) {
        if (!equal(u.searchParams.get('token') ?? '', token)) throw new HttpError(401, 'Token không hợp lệ');
        res.writeHead(303, {
          'Set-Cookie': `tg_dashboard=${token}; HttpOnly; SameSite=Strict; Path=/`,
          Location: '/',
        });
        res.end();
        return;
      }
      const cookie =
        req.headers.cookie
          ?.split(';')
          .map((c) => c.trim())
          .find((c) => c.startsWith('tg_dashboard='))
          ?.slice(13) ?? '';
      if (
        (rawPath.startsWith('/api/') || rawPath.startsWith('/files/')) &&
        !equal(cookie, token) &&
        !equal(req.headers.authorization ?? '', `Bearer ${token}`)
      )
        throw new HttpError(401, 'Cần đăng nhập');
      if (
        ['PUT', 'POST', 'DELETE'].includes(req.method ?? '') &&
        (req.headers.origin !== origin || req.headers['x-tg-csrf'] !== '1')
      )
        throw new HttpError(403, 'Origin hoặc CSRF không hợp lệ');
      if (rawPath === '/api/config' && req.method === 'PUT') {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
          throw new HttpError(415, 'Cần application/json');
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk);
          if (size > 1_048_576) throw new HttpError(413, 'JSON quá lớn');
          chunks.push(Buffer.from(chunk));
        }
        const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = ConfigSchema.safeParse(raw);
        if (!result.success)
          return json(400, {
            issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
          });
        parseConfig(result.data);
        // Store schema-approved fields only; credentials in URLs are not valid dashboard settings.
        const safe = publicConfig(result.data);
        if (JSON.stringify(safe) !== JSON.stringify(result.data))
          throw new HttpError(400, 'Dùng tên biến môi trường cho thông tin xác thực');
        const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
        try {
          fs.writeFileSync(tmp, JSON.stringify(ConfigSchema.parse(raw), null, 2) + '\n', {
            mode: 0o600,
            flag: 'wx',
          });
          if (fs.existsSync(file)) {
            const backup = `${tmp}.bak`;
            fs.writeFileSync(backup, fs.readFileSync(file), { mode: 0o600, flag: 'wx' });
            fs.renameSync(backup, `${file}.bak`);
          }
          fs.renameSync(tmp, file);
        } finally {
          fs.rmSync(tmp, { force: true });
        }
        effective = loadConfig({ ...options.overrides, configPath: file }).config;
        return json(200, { file, effective: publicConfig(effective) });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Phương thức không hỗ trợ');
      if (rawPath === '/api/config/schema') return json(200, z.toJSONSchema(ConfigSchema));
      if (rawPath === '/api/config')
        return json(200, {
          file,
          raw: publicConfig(fs.existsSync(file) ? readConfigFile(file) : {}),
          effective: publicConfig(effective),
        });
      if (rawPath === '/api/tools') {
        const profile = ToolProfileSchema.parse(u.searchParams.get('profile') ?? effective.tools.profile);
        return json(
          200,
          selectTools(ALL_TOOLS, { profile, enabled: [], disabled: [] }).map(
            ({ name, title, category, risk, description, profile: lowest }) => ({
              name,
              title,
              category,
              risk,
              profile: lowest,
              description: description.split(/(?<=\.)\s/)[0]!.slice(0, 200),
            }),
          ),
        );
      }
      if (rawPath === '/api/status')
        return json(200, {
          version: VERSION,
          file,
          project: effective.project,
          browsers: await detectBrowsers(),
          tools: Object.fromEntries(
            ToolProfileSchema.options.map((profile) => [
              profile,
              selectTools(ALL_TOOLS, { profile, enabled: [], disabled: [] }).length,
            ]),
          ),
          // Same estimate as scripts/schema-size.ts: advertised tool JSON, chars / 4.
          toolTokens: toolTokens(),
          proxy: new ProxyManager(effective.network).status(),
          certificates: new CertificateManager(effective.network.tls).status(),
        });
      if (rawPath === '/api/projects') return json(200, projects());
      if (rawPath === '/api/workflows') {
        const ps = u.searchParams.has('project')
          ? [assertSafeName('project', u.searchParams.get('project')!)]
          : projects();
        return json(
          200,
          ps.flatMap<unknown>((p) => workflows(p) as unknown[]),
        );
      }
      if (rawPath === '/api/sessions' || rawPath === '/api/runs') {
        const ps = u.searchParams.has('project')
          ? [assertSafeName('project', u.searchParams.get('project')!)]
          : projects();
        return json(
          200,
          ps.flatMap<unknown>((p) => (rawPath === '/api/sessions' ? sessions(p) : runs(p))),
        );
      }
      const parts = rawPath.split('/').filter(Boolean);
      if (parts[0] === 'api' && parts[1] === 'workflows' && parts.length === 4)
        return json(
          200,
          workflows(assertSafeName('project', parts[2]!), assertSafeName('workflow', parts[3]!)),
        );
      if (parts[0] === 'api' && ['sessions', 'runs'].includes(parts[1] ?? '') && parts.length >= 4) {
        const project = assertSafeName('project', parts[2]!);
        const name = assertSafeName('name', parts[3]!);
        if (parts[1] === 'runs' && parts.length === 4) return json(200, runs(project, name));
        if (parts[1] === 'sessions' && parts.length === 4) return json(200, summary(project, name));
        if (parts[1] === 'sessions' && parts[4] === 'events' && parts.length === 5) {
          const limit = Number(u.searchParams.get('limit') ?? 1000);
          if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            throw new HttpError(400, 'limit phải từ 1 đến 1000');
          return json(
            200,
            events(project, name)
              .filter(
                (e) =>
                  (!u.searchParams.get('type') || e.type === u.searchParams.get('type')) &&
                  (!u.searchParams.get('since') || e.ts >= u.searchParams.get('since')!),
              )
              .slice(-limit),
          );
        }
      }
      let target: string;
      if (rawPath.startsWith('/files/')) target = safeFile(dataDir, rawPath.slice(7));
      else {
        const asset = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' }[rawPath];
        if (!asset) throw new HttpError(404, 'Không tìm thấy');
        target = fileURLToPath(new URL(`./public/${asset}`, import.meta.url));
      }
      const stat = fs.statSync(target);
      if (!stat.isFile()) throw new HttpError(404, 'Không tìm thấy');
      const ext = path.extname(target).toLowerCase();
      if (
        rawPath.startsWith('/files/') &&
        !['.png', '.jpg', '.jpeg', '.webm', '.zip', '.md', '.xml', '.json', '.jsonl'].includes(ext)
      )
        throw new HttpError(403, 'Loại tập tin bị từ chối');
      if (!MIME[ext]) throw new HttpError(403, 'Loại tập tin bị từ chối');
      res.setHeader('Content-Type', MIME[ext]!);
      if (ext === '.zip' || ext === '.xml') res.setHeader('Content-Disposition', 'attachment');
      let start = 0,
        end = stat.size - 1;
      if (ext === '.webm') res.setHeader('Accept-Ranges', 'bytes');
      if (req.headers.range && ext === '.webm') {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) throw new HttpError(416, 'Range không hợp lệ');
        if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
        else {
          start = Number(match[1]);
          if (match[2]) end = Math.min(end, Number(match[2]));
        }
        if (start > end || start >= stat.size) {
          res.setHeader('Content-Range', `bytes */${stat.size}`);
          throw new HttpError(416, 'Range không hợp lệ');
        }
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      }
      res.setHeader('Content-Length', Math.max(0, end - start + 1));
      if (req.method === 'HEAD' || !stat.size) {
        res.end();
        return;
      }
      const stream = fs.createReadStream(target, { start, end });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status =
        e instanceof HttpError ? e.status : (e as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400;
      json(status, { error: e instanceof HttpError ? e.message : 'Yêu cầu không hợp lệ' });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8940, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  return {
    url: `${origin}/?token=${token}`,
    origin,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
