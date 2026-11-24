import { z } from 'zod';

export const ToolProfileSchema = z.enum(['minimal', 'developer', 'testing', 'full']);
export type ToolProfile = z.infer<typeof ToolProfileSchema>;

export const BrowserConfigSchema = z.object({
  /** Playwright engine. */
  engine: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  /** Chromium channel: chrome, msedge, chrome-beta, chromium (Playwright-managed) ... */
  channel: z.string().nullable().default('chrome'),
  headless: z.boolean().default(false),
  executablePath: z.string().nullable().default(null),
  /** Persist a dedicated automation profile on disk for the default session. Never a personal profile. */
  persistent: z.boolean().default(false),
  userDataDir: z.string().default('~/.tg-browser/profiles/default'),
  /** Default action timeout (ms). */
  timeout: z.number().int().positive().max(300_000).default(30_000),
  navigationTimeout: z.number().int().positive().max(300_000).default(30_000),
  viewport: z
    .object({ width: z.number().int().min(200), height: z.number().int().min(200) })
    .nullable()
    .default({ width: 1280, height: 800 }),
  /** Extra launch args. Validated against a denylist (e.g. --disable-web-security). */
  args: z.array(z.string()).default([]),
  /** Existing Chromium connection via CDP. Must be localhost unless allowRemoteCdp is set. */
  /** Chromium OS-level sandbox (Playwright default: off). Enable where the host supports it. */
  chromiumSandbox: z.boolean().default(false),
  /** Show a "TG Browser MCP" badge in controlled pages. null = only when the browser is headed. */
  indicator: z.boolean().nullable().default(null),
  cdpEndpoint: z.string().nullable().default(null),
  allowRemoteCdp: z.boolean().default(false),
});

export const ProxySchema = z.object({
  enabled: z.boolean().default(false),
  server: z.string().nullable().default(null),
  /** Names of environment variables holding credentials. Credentials are never stored in config. */
  usernameEnv: z.string().nullable().default(null),
  passwordEnv: z.string().nullable().default(null),
  bypass: z.array(z.string()).default(['localhost', '127.0.0.1', '::1']),
});

export const NetworkConfigSchema = z.object({
  /** system: use env/OS defaults; manual: use network.proxy; direct: no proxy for the browser. */
  mode: z.enum(['system', 'manual', 'direct']).default('system'),
  proxy: ProxySchema.default(ProxySchema.parse({})),
  tls: z
    .object({
      /** Always true. The field exists only to reject attempts to disable verification explicitly. */
      verify: z.literal(true).default(true),
      caFile: z.string().nullable().default(null),
    })
    .default({ verify: true, caFile: null }),
  capture: z
    .object({
      maxRequests: z.number().int().min(10).max(10_000).default(500),
      maxConsole: z.number().int().min(10).max(10_000).default(300),
      /** Request/response bodies are never captured unless enabled. */
      captureBodies: z.boolean().default(false),
      maxBodyBytes: z.number().int().min(0).max(1_000_000).default(16_384),
    })
    .default({ maxRequests: 500, maxConsole: 300, captureBodies: false, maxBodyBytes: 16_384 }),
});

export const ApprovalModeSchema = z.enum(['allow', 'ask', 'deny']);

export const ApprovalSchema = z.object({
  /** Policy for tools classified high risk (upload, CDP connect, eval...). */
  highRisk: ApprovalModeSchema.default('ask'),
  /** Policy for clicks on elements whose name matches destructivePatterns. */
  destructive: ApprovalModeSchema.default('ask'),
  destructivePatterns: z
    .array(z.string())
    .default([
      '\\bdelete\\b',
      '\\bremove\\b',
      '\\bdestroy\\b',
      '\\bdrop\\b',
      '\\bpay(ment)?\\b',
      '\\btransfer\\b',
      '\\bpurchase\\b',
      '\\bunsubscribe\\b',
    ]),
});

export const SecurityConfigSchema = z.object({
  /** If non-empty, ONLY these hosts may be navigated/requested (wildcards: *.example.com). */
  allowedDomains: z.array(z.string()).default([]),
  blockedDomains: z.array(z.string()).default([]),
  /** Allow localhost/127.0.0.1/::1 targets (local dev servers). */
  allowLocalhost: z.boolean().default(true),
  /** Allow RFC1918 / link-local / ULA private networks. Cloud metadata is blocked regardless. */
  allowPrivateNetwork: z.boolean().default(false),
  /** Additional URL schemes besides http/https/about/data/blob. file: is never allowed implicitly. */
  allowFileUrls: z.boolean().default(false),
  /** Enforce the domain policy on every sub-request (not just navigations). */
  enforceOnSubresources: z.boolean().default(true),
  fileAccess: z
    .object({
      /** Roots that upload/screenshot/trace/workflow file paths must live in. Default: working dir + data dir. */
      allowedRoots: z.array(z.string()).default([]),
    })
    .default({ allowedRoots: [] }),
  approval: ApprovalSchema.default(ApprovalSchema.parse({})),
  /** Extra field names (case-insensitive substrings) to redact in snapshots, network, and logs. */
  sensitiveFields: z.array(z.string()).default([]),
  maxSessions: z.number().int().min(1).max(50).default(10),
  maxPagesPerSession: z.number().int().min(1).max(100).default(20),
});

export const ToolsConfigSchema = z.object({
  profile: ToolProfileSchema.default('developer'),
  enabled: z.array(z.string()).default([]),
  disabled: z.array(z.string()).default([]),
});

export const SnapshotConfigSchema = z.object({
  maxChars: z.number().int().min(500).max(500_000).default(12_000),
  maxDepth: z.number().int().min(1).max(100).default(40),
  maxTextLength: z.number().int().min(10).max(2000).default(80),
  /** Include non-interactive static text nodes. */
  includeText: z.boolean().default(true),
});

export const OutputConfigSchema = z.object({
  /** inline: return screenshots as MCP image content; file: save to artifacts dir and return path. */
  screenshots: z.enum(['inline', 'file', 'both']).default('inline'),
  verbose: z.boolean().default(false),
});

export const HttpConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(8931),
  /** Name of env var holding the bearer token. Required for HTTP transport. */
  tokenEnv: z.string().default('TG_BROWSER_TOKEN'),
  allowedOrigins: z.array(z.string()).default([]),
  rateLimitPerMinute: z.number().int().min(1).max(100_000).default(600),
  /**
   * Header carrying the real client IP, set by a trusted front door (e.g. the Cloudflare Worker).
   * Only enable when the server is reachable exclusively through that front door.
   */
  trustedClientIpHeader: z.string().nullable().default(null),
  /** Extra Host header values accepted besides the bind address (e.g. the front door's internal host). */
  allowedHosts: z.array(z.string()).default([]),
  maxSessions: z.number().int().min(1).max(100).default(5),
  /** Sessions idle longer than this are closed (and their browser with them). */
  idleTimeoutMinutes: z
    .number()
    .min(1)
    .max(24 * 60)
    .default(30),
  /** When all slots are taken, a new client may evict a session idle for at least this long. */
  evictIdleAfterSeconds: z
    .number()
    .int()
    .min(1)
    .max(24 * 3600)
    .default(120),
});

export const ConfigSchema = z.object({
  project: z.string().default('default'),
  dataDir: z.string().default('~/.tg-browser'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  browser: BrowserConfigSchema.default(BrowserConfigSchema.parse({})),
  network: NetworkConfigSchema.default(NetworkConfigSchema.parse({})),
  security: SecurityConfigSchema.default(SecurityConfigSchema.parse({})),
  tools: ToolsConfigSchema.default(ToolsConfigSchema.parse({})),
  snapshot: SnapshotConfigSchema.default(SnapshotConfigSchema.parse({})),
  output: OutputConfigSchema.default(OutputConfigSchema.parse({})),
  http: HttpConfigSchema.default(HttpConfigSchema.parse({})),
  sessions: z
    .object({
      /** Saved session state older than this (hours) is treated as expired. */
      expirationHours: z
        .number()
        .positive()
        .default(24 * 7),
      encrypt: z.boolean().default(true),
    })
    .default({ expirationHours: 24 * 7, encrypt: true }),
});

export type TgConfig = z.infer<typeof ConfigSchema>;
export type TgConfigInput = z.input<typeof ConfigSchema>;
