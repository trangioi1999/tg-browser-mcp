/**
 * Normalized error model. Every failure surfaced to an AI client is a TgError with a stable
 * code, a safe human-readable message, whether retrying is safe, and a suggested recovery.
 * Stack traces and raw underlying messages that may contain secrets are never returned to clients.
 */

export const ErrorCodes = [
  'BROWSER_NOT_FOUND',
  'BROWSER_LAUNCH_FAILED',
  'BROWSER_DISCONNECTED',
  'SESSION_NOT_FOUND',
  'SESSION_EXPIRED',
  'SESSION_EXISTS',
  'SESSION_BUSY',
  'SESSION_AMBIGUOUS',
  'PAGE_NOT_FOUND',
  'FRAME_NOT_FOUND',
  'ELEMENT_NOT_FOUND',
  'ELEMENT_NOT_VISIBLE',
  'ELEMENT_AMBIGUOUS',
  'STALE_ELEMENT_REFERENCE',
  'TARGET_CHANGED',
  'PAGE_BUSY',
  'ACTION_TIMEOUT',
  'ACTION_FAILED',
  'NAVIGATION_TIMEOUT',
  'NAVIGATION_FAILED',
  'NETWORK_DNS_FAILED',
  'NETWORK_PROXY_FAILED',
  'NETWORK_TLS_FAILED',
  'NETWORK_CONNECTION_FAILED',
  'DOMAIN_NOT_ALLOWED',
  'PERMISSION_DENIED',
  'APPROVAL_REQUIRED',
  'FILE_ACCESS_DENIED',
  'INVALID_ARGUMENT',
  'CONFIG_INVALID',
  'WORKFLOW_INVALID',
  'WORKFLOW_FAILED',
  'WORKFLOW_NOT_FOUND',
  'ASSERTION_FAILED',
  'RESOURCE_LIMIT_EXCEEDED',
  'NOT_SUPPORTED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ErrorCodes)[number];

export interface TgErrorOptions {
  context?: Record<string, unknown>;
  retryable?: boolean;
  suggestion?: string;
  cause?: unknown;
}

const DEFAULT_SUGGESTIONS: Partial<Record<ErrorCode, string>> = {
  BROWSER_NOT_FOUND:
    'Run `tg-browser-mcp browsers` to list detected browsers, or set browser.executablePath.',
  BROWSER_LAUNCH_FAILED:
    'Run `tg-browser-mcp doctor`. Check that the profile directory is not locked by another browser.',
  BROWSER_DISCONNECTED: 'The browser closed or crashed. Call browser_launch or retry the action to relaunch.',
  SESSION_NOT_FOUND: 'Call session_list to see sessions, or session_create to create one.',
  PAGE_NOT_FOUND: 'Call browser_tabs to list open pages.',
  ELEMENT_NOT_FOUND: 'Call browser_snapshot to get current element references.',
  ELEMENT_NOT_VISIBLE: 'Scroll the element into view, close overlays, or wait for it to appear.',
  ELEMENT_AMBIGUOUS: 'Use a snapshot ref or a more specific locator (role + exact name).',
  TARGET_CHANGED: 'Target identity changed. Call browser_snapshot and review the new target before retrying.',
  PAGE_BUSY:
    'Another action is still running on this page. Wait, then call browser_snapshot to see its effect before acting again.',
  STALE_ELEMENT_REFERENCE: 'The page changed since the snapshot. Call browser_snapshot to get fresh refs.',
  ACTION_TIMEOUT: 'Element may be disabled, covered, or still loading. Take a snapshot and check its state.',
  NAVIGATION_TIMEOUT: 'Check that the server is running and reachable. Run network_diagnose for the URL.',
  NETWORK_DNS_FAILED: 'Check the hostname and DNS settings. Run network_diagnose.',
  NETWORK_PROXY_FAILED: 'Check proxy server/credentials (network.proxy). Run network_proxy_status.',
  NETWORK_TLS_FAILED:
    'Configure the corporate CA certificate (network.tls.caFile). TLS verification is never disabled.',
  DOMAIN_NOT_ALLOWED: 'Ask the user to add this host to security.allowedDomains in the configuration.',
  PERMISSION_DENIED: 'This tool or action is disabled by policy. Ask the user to change the configuration.',
  APPROVAL_REQUIRED:
    'This action needs human approval. Ask the user to approve it or change security.approval policy.',
  FILE_ACCESS_DENIED: 'Only files inside security.fileAccess.allowedRoots can be used.',
  RESOURCE_LIMIT_EXCEEDED: 'Close unused tabs/sessions or narrow the request (scope, limit, page).',
};

export class TgError extends Error {
  readonly code: ErrorCode;
  readonly context: Record<string, unknown>;
  readonly retryable: boolean;
  readonly suggestion: string | undefined;

  constructor(code: ErrorCode, message: string, opts: TgErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'TgError';
    this.code = code;
    this.context = opts.context ?? {};
    this.retryable = opts.retryable ?? false;
    this.suggestion = opts.suggestion ?? DEFAULT_SUGGESTIONS[code];
  }

  toJSON(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.suggestion ? { suggestion: this.suggestion } : {}),
      ...(Object.keys(this.context).length ? { context: this.context } : {}),
    };
  }
}

export interface SerializedError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  suggestion?: string;
  context?: Record<string, unknown>;
}

/** Maps network error strings reported by Chromium/Firefox/WebKit into normalized codes. */
export function classifyNetworkError(raw: string): ErrorCode | undefined {
  const s = raw.toUpperCase();
  if (/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|DNS/.test(s)) return 'NETWORK_DNS_FAILED';
  if (/PROXY|TUNNEL_CONNECTION_FAILED/.test(s)) return 'NETWORK_PROXY_FAILED';
  if (/CERT|SSL|TLS|SEC_ERROR/.test(s)) return 'NETWORK_TLS_FAILED';
  if (
    /CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|ECONNREFUSED|ECONNRESET|ADDRESS_UNREACHABLE|NETWORK_CHANGED|INTERNET_DISCONNECTED/.test(
      s,
    )
  )
    return 'NETWORK_CONNECTION_FAILED';
  if (/TIMED_OUT|ETIMEDOUT/.test(s)) return 'NAVIGATION_TIMEOUT';
  return undefined;
}

/**
 * Converts any thrown value into a TgError. Playwright errors are classified by message.
 * The raw message is reduced to its first line and stripped of Playwright call logs.
 */
export function toTgError(err: unknown, fallback: ErrorCode = 'INTERNAL_ERROR'): TgError {
  if (err instanceof TgError) return err;
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = (raw.split('\n')[0] ?? raw).replace(/\s+/g, ' ').trim().slice(0, 300);
  const name = err instanceof Error ? err.name : '';

  if (
    /Target page, context or browser has been closed|Browser has been closed|browser has disconnected/i.test(
      raw,
    )
  )
    return new TgError('BROWSER_DISCONNECTED', firstLine, { retryable: true, cause: err });
  if (name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(raw)) {
    const isNav = /page\.goto|navigat|waitForURL|waitForLoadState/i.test(raw);
    return new TgError(isNav ? 'NAVIGATION_TIMEOUT' : 'ACTION_TIMEOUT', firstLine, {
      retryable: true,
      cause: err,
    });
  }
  if (/strict mode violation/i.test(raw)) return new TgError('ELEMENT_AMBIGUOUS', firstLine, { cause: err });
  if (/net::ERR_BLOCKED_BY_CLIENT|ERR_ACCESS_DENIED/i.test(raw))
    return new TgError('DOMAIN_NOT_ALLOWED', 'Request blocked by domain policy', { cause: err });
  const net = classifyNetworkError(raw);
  if (net) return new TgError(net, firstLine, { retryable: net !== 'NETWORK_TLS_FAILED', cause: err });
  if (/not visible|element is outside of the viewport/i.test(raw))
    return new TgError('ELEMENT_NOT_VISIBLE', firstLine, { retryable: true, cause: err });
  return new TgError(fallback, firstLine, { cause: err });
}
