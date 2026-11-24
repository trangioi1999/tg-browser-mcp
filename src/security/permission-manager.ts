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

  /** Validates a file path against allowed roots. Resolves symlinks for existing files. */
  checkFilePath(p: string, purpose: 'read' | 'write'): string {
    const abs = path.resolve(p);
    let real = abs;
    try {
      real =
        purpose === 'read'
          ? fs.realpathSync(abs)
          : path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      if (purpose === 'read')
        throw new TgError('FILE_ACCESS_DENIED', `File not found: ${path.basename(abs)}`);
    }
    const roots = this.cfg.security.fileAccess.allowedRoots.map((r) => {
      try {
        return fs.realpathSync(r);
      } catch {
        return path.resolve(r);
      }
    });
    if (!roots.some((r) => isPathInside(r, real))) {
      throw new TgError('FILE_ACCESS_DENIED', `Path is outside allowed roots: ${abs}`, {
        context: { allowedRoots: this.cfg.security.fileAccess.allowedRoots },
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
