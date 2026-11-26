import fs from 'node:fs';
import path from 'node:path';

import { WRITE_EXTENSIONS } from '../security/permission-manager.js';

import { hasTarget, resolveTarget, type Target } from './target.js';

import { INDICATOR_HIDE_CSS } from '../browser/indicator.js';

import { ActionPipeline, type ActionContext } from './action-pipeline.js';
export class ArtifactService {
  constructor(private readonly pipeline: ActionPipeline) {}
  async screenshot(
    opts: {
      target?: Target;
      fullPage?: boolean;
      format?: 'png' | 'jpeg';
      quality?: number;
      path?: string;
      save?: boolean;
    } = {},
    ctx: ActionContext = {},
  ): Promise<{
    base64?: string;
    mimeType: string;
    path?: string;
    bytes: number;
    pageId: string;
    sessionId: string;
  }> {
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    const ps = await this.pipeline.ensurePage(s, ctx.pageId);
    return this.pipeline.locked(ps, 'screenshot', async () => {
      const type = opts.format ?? 'jpeg';
      const shotOpts = {
        type,
        ...(type === 'jpeg' ? { quality: opts.quality ?? 75 } : {}),
        scale: 'css' as const,
        timeout: this.pipeline.timeout(),
        // Keep the "controlled by TG Browser MCP" badge out of screenshots.
        style: INDICATOR_HIDE_CSS,
      };
      let buf: Buffer;
      if (opts.target && hasTarget(opts.target)) {
        const r = await resolveTarget(ps, opts.target, this.pipeline.timeout());
        buf = await (r.kind === 'handle' ? r.handle : r.locator).screenshot(shotOpts);
      } else buf = await ps.page.screenshot({ ...shotOpts, fullPage: !!opts.fullPage });
      const mode = this.pipeline.cfg.output.screenshots;
      let file: string | undefined;
      if (opts.path || opts.save || mode !== 'inline') {
        file = opts.path
          ? this.pipeline.permissions.checkFilePath(opts.path, 'write', {
              extensions: WRITE_EXTENSIONS[type],
            })
          : path.join(this.pipeline.artifactsDir, s.project, s.name, `screenshot-${Date.now()}.${type}`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
        this.pipeline.events.emit('screenshot.created', {
          sessionId: s.id,
          pageId: ps.id,
          path: file,
          bytes: buf.length,
        });
      }
      const inline = mode !== 'file' && !(opts.path && mode === 'inline' && opts.save === false);
      return {
        ...(inline ? { base64: buf.toString('base64') } : {}),
        mimeType: `image/${type}`,
        ...(file ? { path: file } : {}),
        bytes: buf.length,
        pageId: ps.id,
        sessionId: s.id,
      };
    });
  }

  async traceStart(ctx: ActionContext = {}): Promise<{ session: string }> {
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    await s.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    return { session: s.name };
  }

  async traceStop(
    filePath: string | undefined,
    ctx: ActionContext = {},
  ): Promise<{ path: string; bytes: number }> {
    const s = await this.pipeline.sessionFor(ctx.session, ctx.project);
    const out = filePath
      ? this.pipeline.permissions.checkFilePath(filePath, 'write', { extensions: WRITE_EXTENSIONS.trace })
      : path.join(this.pipeline.artifactsDir, s.project, s.name, `trace-${Date.now()}.zip`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await s.context.tracing.stop({ path: out });
    this.pipeline.events.emit('trace.created', { sessionId: s.id, path: out, bytes: fs.statSync(out).size });
    return { path: out, bytes: fs.statSync(out).size };
  }
}
