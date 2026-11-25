import fs from 'node:fs';
import path from 'node:path';
import type { TgConfig } from '../config/schema.js';
import { TgError } from '../shared/errors.js';
import { isPathInside } from '../shared/util.js';

export type RiskLevel = 'read' | 'interact' | 'high';

/**
 * Asks a human to approve an action. Implemented by the MCP layer via elicitation when the
 * client supports it. Returns false when the user declines or approval is unavailable.
 */
export type ApprovalHandler = (request: {
  title: string;
  detail: string;
}) => Promise<'approved' | 'declined' | 'unavailable'>;

/** Launch flags that would weaken browser security. */
const DENIED_LAUNCH_ARGS = [
  '--disable-web-security',
  '--ignore-certificate-errors',
  '--ignore-certificate-errors-spki-list',
  '--allow-running-insecure-content',
  '--remote-debugging-address',
  '--disable-site-isolation-trials',
  '--no-sandbox',
  '--user-data-dir',
  '--load-extension',
  '--proxy-server',
];

/**
 * Default extension allowlist for agent-chosen output paths. Callers pass a narrower list per tool
 * (screenshots: images, traces: .zip). Generated specs must end in .spec.ts/.test.ts.
 */
export const DEFAULT_WRITE_EXTENSIONS: readonly string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.zip',
  '.md',
  '.xml',
  '.json',
  '.spec.ts',
  '.test.ts',
];

/** Output extensions per artifact kind. */
export const WRITE_EXTENSIONS = {
  png: ['.png'],
  jpeg: ['.jpg', '.jpeg'],
  trace: ['.zip'],
} as const;

/** realpath of the deepest existing ancestor, with the non-existent remainder appended. */
function realpathLoose(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

export class PermissionManager {
  private approval: ApprovalHandler | undefined;
  private readonly destructive: RegExp[];

  constructor(private readonly cfg: TgConfig) {
    this.destructive = cfg.security.approval.destructivePatterns.map((p) => new RegExp(p, 'i'));
  }

  setApprovalHandler(h: ApprovalHandler | undefined): void {
    this.approval = h;
  }

  isDestructiveName(name: string | undefined): boolean {
    return !!name && this.destructive.some((re) => re.test(name));
  }

  /** Enforces the approval policy for high-risk tools or destructive actions. */
  async requireApproval(kind: 'highRisk' | 'destructive', title: string, detail: string): Promise<void> {
    const mode = this.cfg.security.approval[kind];
    if (mode === 'allow') return;
    if (mode === 'deny') {
      throw new TgError('PERMISSION_DENIED', `${title} is denied by policy (security.approval.${kind}=deny)`);
    }
    const res = this.approval ? await this.approval({ title, detail }) : 'unavailable';
    if (res === 'approved') return;
    if (res === 'declined') throw new TgError('PERMISSION_DENIED', `User declined: ${title}`);
    throw new TgError(
      'APPROVAL_REQUIRED',
      `${title} requires human approval, but this MCP client does not support approval prompts.`,
      {
        suggestion: `Ask the user to perform this step manually, or to set security.approval.${kind}="allow" in the TG Browser config if they accept the risk.`,
      },
    );
  }

  /**
   * Validates a file path. Reads (uploads) must be inside `fileAccess.allowedRoots`; writes of agent-chosen
   * paths must be inside `fileAccess.writeRoots` (default `<dataDir>/artifacts`), use an allowed file
   * extension, and must not replace an existing file unless `fileAccess.allowOverwrite` is set (symlinks
   * and non-regular files are never replaced). Symlinks in parent directories are resolved.
   */
  checkFilePath(
    p: string,
    purpose: 'read' | 'write',
    opts: { extensions?: readonly string[] } = {},
  ): string {
    const abs = path.resolve(p);
    let real: string;
    if (purpose === 'read') {
      try {
        real = fs.realpathSync(abs);
      } catch {
        throw new TgError('FILE_ACCESS_DENIED', `File not found: ${path.basename(abs)}`);
      }
    } else real = path.join(realpathLoose(path.dirname(abs)), path.basename(abs));
    const fa = this.cfg.security.fileAccess;
    const configured = purpose === 'read' ? fa.allowedRoots : fa.writeRoots;
    const roots = configured.map(realpathLoose);
    if (!roots.some((r) => isPathInside(r, real))) {
      throw new TgError(
        'FILE_ACCESS_DENIED',
        `Path is outside allowed roots${purpose === 'write' ? ' for writing' : ''}: ${abs}`,
        {
          context: purpose === 'read' ? { allowedRoots: configured } : { writeRoots: configured },
          ...(purpose === 'write'
            ? {
                suggestion: `Omit the path to save into the artifacts directory, or write inside: ${configured.join(', ')} (security.fileAccess.writeRoots).`,
              }
            : {}),
        },
      );
    }
    if (purpose === 'read') return real;

    const exts = opts.extensions ?? DEFAULT_WRITE_EXTENSIONS;
    const base = path.basename(real).toLowerCase();
    if (!exts.some((e) => base.endsWith(e.toLowerCase()) && base.length > e.length)) {
      throw new TgError('FILE_ACCESS_DENIED', `File type not allowed for this output: ${path.basename(real)}`, {
        context: { allowedExtensions: [...exts] },
        suggestion: `Use a file name ending in ${exts.join(', ')}.`,
      });
    }
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(real);
    } catch {
      st = undefined;
    }
    if (st) {
      if (st.isSymbolicLink() || !st.isFile())
        throw new TgError('FILE_ACCESS_DENIED', `Refusing to write through a link or non-file: ${abs}`);
      if (!fa.allowOverwrite)
        throw new TgError('FILE_ACCESS_DENIED', `File already exists: ${abs}`, {
          suggestion:
            'Choose a new file name (existing files are not overwritten unless security.fileAccess.allowOverwrite=true).',
        });
    }
    return real;
  }

  checkLaunchArgs(args: string[]): void {
    for (const a of args) {
      const flag = a.split('=')[0]?.toLowerCase() ?? '';
      if (DENIED_LAUNCH_ARGS.includes(flag)) {
        throw new TgError('PERMISSION_DENIED', `Browser launch argument ${flag} is not permitted`);
      }
    }
  }
}
