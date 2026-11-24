import type { BrowserContext, Dialog, Frame, Page } from 'playwright';
import { RefRegistry } from '../snapshot/element-reference.js';
import type { Snapshot } from '../snapshot/snapshot-engine.js';
import type { NetworkMonitor } from '../network/network-monitor.js';
import { TgError } from '../shared/errors.js';

export interface PendingDialog {
  type: string;
  message: string;
  defaultValue: string;
  dialog: Dialog;
}

export class PageState {
  readonly refs = new RefRegistry();
  lastSnapshot: Snapshot | undefined;
  activeFrame: Frame | undefined;
  pendingDialog: PendingDialog | undefined;
  /** Set when the domain policy stopped a redirect hop of a navigation. */
  blockedNavigation: { url: string; reason: string; at: number } | undefined;
  openedAt = Date.now();

  constructor(
    readonly id: string,
    readonly page: Page,
  ) {}

  /** Frame used for semantic locators and snapshots (set via browser_frame_switch). */
  frame(): Frame {
    if (this.activeFrame && !this.activeFrame.isDetached()) return this.activeFrame;
    this.activeFrame = undefined;
    return this.page.mainFrame();
  }
}

export type SessionStatus = 'active' | 'closed';

export interface SessionInfo {
  id: string;
  name: string;
  project: string;
  agentId?: string;
  browserId: string;
  persistent: boolean;
  connected: boolean;
  status: SessionStatus;
  pages: Array<{ id: string; url: string; title: string; active: boolean }>;
  createdAt: string;
}

/** One isolated browser context (cookies/storage) plus its pages. */
export class Session {
  readonly pages = new Map<string, PageState>();
  activePageId: string | undefined;
  status: SessionStatus = 'active';
  readonly createdAt = new Date();
  private pageSeq = 0;
  /** Pages opened by the app (popups, target=_blank) that the caller has not seen yet. */
  readonly newPagesQueue: string[] = [];
  /** Pages being opened by the harness itself (not by the website), awaiting their `page` event. */
  ownPagesPending = 0;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly project: string,
    readonly context: BrowserContext,
    readonly browserId: string,
    readonly monitor: NetworkMonitor,
    readonly persistent: boolean,
    readonly connected: boolean,
    readonly agentId: string | undefined,
  ) {}

  nextPageId(): string {
    return `p${++this.pageSeq}`;
  }

  pageIdOf(page: Page): string | undefined {
    for (const [id, st] of this.pages) if (st.page === page) return id;
    return undefined;
  }

  page(pageId?: string): PageState {
    const id = pageId ?? this.activePageId;
    const st = id ? this.pages.get(id) : undefined;
    if (!st || st.page.isClosed()) {
      throw new TgError(
        'PAGE_NOT_FOUND',
        pageId ? `Page ${pageId} not found in session ${this.name}` : `Session ${this.name} has no open page`,
        {
          context: { pages: [...this.pages.keys()] },
        },
      );
    }
    return st;
  }

  async info(): Promise<SessionInfo> {
    const pages = await Promise.all(
      [...this.pages.values()].map(async (p) => ({
        id: p.id,
        url: p.page.url(),
        title: await p.page.title().catch(() => ''),
        active: p.id === this.activePageId,
      })),
    );
    return {
      id: this.id,
      name: this.name,
      project: this.project,
      ...(this.agentId ? { agentId: this.agentId } : {}),
      browserId: this.browserId,
      persistent: this.persistent,
      connected: this.connected,
      status: this.status,
      pages,
      createdAt: this.createdAt.toISOString(),
    };
  }
}
