import type { BrowserContext, Page, Request } from 'playwright';
import type { DataRedactor } from '../security/data-redactor.js';
import { classifyNetworkError } from '../shared/errors.js';

export interface NetworkEntry {
  id: string;
  seq: number;
  pageId: string | undefined;
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  ok: boolean | null;
  failure: string | null;
  failureCode: string | null;
  blockedByPolicy: boolean;
  startedAt: number;
  durationMs: number | null;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
}

export interface ConsoleEntry {
  seq: number;
  pageId: string | undefined;
  type: string;
  text: string;
  location?: string;
  count: number;
  firstAt: number;
  lastAt: number;
}

export interface NetworkFilter {
  url?: string;
  method?: string;
  status?: number | 'failed' | 'error';
  resourceType?: string;
  pageId?: string;
  sinceMs?: number;
  sinceSeq?: number;
  limit?: number;
}

export interface MonitorOptions {
  maxRequests: number;
  maxConsole: number;
  captureBodies: boolean;
  maxBodyBytes: number;
}

/**
 * Captures network and console activity for one browser context into bounded ring buffers.
 * Headers and bodies are only kept on demand (details), redacted, and bodies are off by default.
 * Console messages are deduplicated (same type+text+location increments `count`).
 */
export class NetworkMonitor {
  private seq = 0;
  private readonly requests: NetworkEntry[] = [];
  private readonly byRequest = new WeakMap<Request, NetworkEntry>();
  private readonly consoleEntries: ConsoleEntry[] = [];
  private readonly consoleIndex = new Map<string, ConsoleEntry>();
  private readonly blockedUrls = new Set<string>();

  constructor(
    private readonly opts: MonitorOptions,
    private readonly redactor: DataRedactor,
    private readonly pageIdOf: (p: Page) => string | undefined,
  ) {}

  attachContext(ctx: BrowserContext): void {
    ctx.on('request', (r) => this.onRequest(r));
    ctx.on('requestfinished', (r) => void this.onFinished(r));
    ctx.on('requestfailed', (r) => this.onFailed(r));
  }

  attachPage(page: Page): void {
    page.on('console', (m) => {
      const loc = m.location();
      this.addConsole(page, m.type(), m.text(), loc.url ? `${loc.url}:${loc.lineNumber}` : undefined);
    });
    page.on('pageerror', (err) =>
      this.addConsole(page, 'pageerror', `${err.name}: ${err.message}`, undefined),
    );
  }

  markBlocked(url: string): void {
    this.blockedUrls.add(url);
    if (this.blockedUrls.size > 1000) this.blockedUrls.clear();
  }

  private pageOf(r: Request): string | undefined {
    try {
      const f = r.frame();
      return this.pageIdOf(f.page());
    } catch {
      return undefined;
    }
  }

  private onRequest(r: Request): void {
    const e: NetworkEntry = {
      id: `r${++this.seq}`,
      seq: this.seq,
      pageId: this.pageOf(r),
      method: r.method(),
      url: this.redactor.url(r.url()),
      resourceType: r.resourceType(),
      status: null,
      ok: null,
      failure: null,
      failureCode: null,
      blockedByPolicy: false,
      startedAt: Date.now(),
      durationMs: null,
    };
    this.byRequest.set(r, e);
    this.requests.push(e);
    if (this.requests.length > this.opts.maxRequests) this.requests.shift();
  }

  private async onFinished(r: Request): Promise<void> {
    const e = this.byRequest.get(r);
    if (!e) return;
    const res = await r.response().catch(() => null);
    e.status = res?.status() ?? null;
    e.ok = res ? res.ok() : null;
    const timing = r.timing();
    e.durationMs = timing.responseEnd > 0 ? Math.round(timing.responseEnd) : Date.now() - e.startedAt;
    if (this.opts.captureBodies && res && ['xhr', 'fetch', 'document'].includes(e.resourceType)) {
      try {
        e.requestBody = r.postData()
          ? this.redactor.body(r.postData() ?? '', this.opts.maxBodyBytes)
          : undefined;
        const buf = await res.body();
        const ct = res.headers()['content-type'] ?? '';
        if (/json|text|xml|javascript/.test(ct))
          e.responseBody = this.redactor.body(buf.toString('utf8'), this.opts.maxBodyBytes);
      } catch {
        // Body may be unavailable (redirects, navigations); ignore.
      }
    }
    try {
      e.requestHeaders = this.redactor.headers(await r.allHeaders());
      if (res) e.responseHeaders = this.redactor.headers(await res.allHeaders());
    } catch {
      // ignore
    }
  }

  private onFailed(r: Request): void {
    const e = this.byRequest.get(r);
    if (!e) return;
    const text = r.failure()?.errorText ?? 'failed';
    e.failure = text;
    e.durationMs = Date.now() - e.startedAt;
    e.blockedByPolicy = this.blockedUrls.has(r.url()) || /BLOCKED_BY_CLIENT/.test(text);
    e.failureCode = e.blockedByPolicy ? 'DOMAIN_NOT_ALLOWED' : (classifyNetworkError(text) ?? null);
  }

  private addConsole(page: Page, type: string, rawText: string, location: string | undefined): void {
    const text = this.redactor.text(rawText).slice(0, 2000);
    const pageId = this.pageIdOf(page);
    const key = `${pageId}|${type}|${text}|${location ?? ''}`;
    const now = Date.now();
    const existing = this.consoleIndex.get(key);
    if (existing) {
      existing.count++;
      existing.lastAt = now;
      existing.seq = ++this.seq;
      return;
    }
    const entry: ConsoleEntry = {
      seq: ++this.seq,
      pageId,
      type,
      text,
      ...(location ? { location: this.redactor.url(location) } : {}),
      count: 1,
      firstAt: now,
      lastAt: now,
    };
    this.consoleEntries.push(entry);
    this.consoleIndex.set(key, entry);
    if (this.consoleEntries.length > this.opts.maxConsole) {
      const old = this.consoleEntries.shift();
      if (old) this.consoleIndex.delete(`${old.pageId}|${old.type}|${old.text}|${old.location ?? ''}`);
    }
  }

  get lastSeq(): number {
    return this.seq;
  }

  network(filter: NetworkFilter = {}): { total: number; entries: NetworkEntry[] } {
    let list = this.requests;
    if (filter.pageId) list = list.filter((e) => e.pageId === filter.pageId);
    if (filter.url) {
      const needle = filter.url.toLowerCase();
      list = list.filter((e) => e.url.toLowerCase().includes(needle));
    }
    if (filter.method) list = list.filter((e) => e.method === filter.method!.toUpperCase());
    if (filter.resourceType) list = list.filter((e) => e.resourceType === filter.resourceType);
    if (filter.status === 'failed') list = list.filter((e) => e.failure !== null);
    else if (filter.status === 'error')
      list = list.filter((e) => e.failure !== null || (e.status !== null && e.status >= 400));
    else if (typeof filter.status === 'number') list = list.filter((e) => e.status === filter.status);
    if (filter.sinceMs) list = list.filter((e) => e.startedAt >= Date.now() - filter.sinceMs!);
    if (filter.sinceSeq) list = list.filter((e) => e.seq > filter.sinceSeq!);
    const limit = filter.limit ?? 50;
    return { total: list.length, entries: list.slice(-limit) };
  }

  detail(id: string): NetworkEntry | undefined {
    return this.requests.find((e) => e.id === id);
  }

  console(opts: { types?: string[]; pageId?: string; sinceSeq?: number; limit?: number } = {}): {
    total: number;
    entries: ConsoleEntry[];
  } {
    let list = this.consoleEntries;
    if (opts.pageId) list = list.filter((e) => e.pageId === opts.pageId);
    if (opts.types?.length) list = list.filter((e) => opts.types!.includes(e.type));
    if (opts.sinceSeq) list = list.filter((e) => e.seq > opts.sinceSeq!);
    const limit = opts.limit ?? 50;
    return { total: list.length, entries: list.slice(-limit) };
  }

  /** Errors summary: page errors, console errors, failed and >=400 requests. */
  errors(pageId?: string, sinceSeq?: number): { console: ConsoleEntry[]; network: NetworkEntry[] } {
    return {
      console: this.console({
        types: ['error', 'pageerror'],
        ...(pageId ? { pageId } : {}),
        ...(sinceSeq ? { sinceSeq } : {}),
        limit: 30,
      }).entries,
      network: this.network({
        status: 'error',
        ...(pageId ? { pageId } : {}),
        ...(sinceSeq ? { sinceSeq } : {}),
        limit: 30,
      }).entries,
    };
  }

  clear(): void {
    this.requests.length = 0;
    this.consoleEntries.length = 0;
    this.consoleIndex.clear();
  }
}

/** Compact one-line-per-request formatting for token-efficient output. */
export function formatNetwork(entries: NetworkEntry[]): string {
  return entries
    .map((e) => {
      const st = e.failure
        ? `FAILED ${e.failureCode ?? ''} ${e.failure}`.replace(/\s+/g, ' ')
        : String(e.status ?? 'pending');
      const dur = e.durationMs !== null ? ` ${e.durationMs}ms` : '';
      return `[${e.id}] ${e.method} ${shortUrl(e.url)} → ${st}${dur} (${e.resourceType})`;
    })
    .join('\n');
}

export function formatConsole(entries: ConsoleEntry[]): string {
  return entries
    .map(
      (e) =>
        `[${e.type}]${e.count > 1 ? ` ×${e.count}` : ''} ${e.text}${e.location ? ` (${shortUrl(e.location)})` : ''}`,
    )
    .join('\n');
}

function shortUrl(u: string): string {
  return u.length > 160 ? `${u.slice(0, 157)}…` : u;
}
