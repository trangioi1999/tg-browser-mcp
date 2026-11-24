import fs from 'node:fs';
import path from 'node:path';
import { ConfigSchema, type TgConfig, type TgConfigInput } from './schema.js';
import { TgError } from '../shared/errors.js';
import { expandHome } from '../shared/util.js';

export interface CliOverrides {
  configPath?: string;
  browser?: string;
  headless?: boolean;
  profile?: string;
  project?: string;
  cdpEndpoint?: string;
  executablePath?: string;
  allowedDomains?: string[];
  logLevel?: string;
}

const CONFIG_FILENAMES = ['tg-browser.config.json', '.tg-browser.json'];

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge where arrays and scalars from `b` replace `a`. */
export function deepMerge(a: Json, b: Json): Json {
  const out: Json = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k] as Json, v) : v;
  }
  return out;
}

/** Maps a browser shortcut (chrome, edge, chromium, firefox, webkit) to engine/channel. */
export function browserShortcut(name: string): {
  engine: 'chromium' | 'firefox' | 'webkit';
  channel: string | null;
} {
  switch (name.toLowerCase()) {
    case 'chrome':
      return { engine: 'chromium', channel: 'chrome' };
    case 'edge':
    case 'msedge':
      return { engine: 'chromium', channel: 'msedge' };
    case 'chromium':
      return { engine: 'chromium', channel: null };
    case 'firefox':
      return { engine: 'firefox', channel: null };
    case 'webkit':
    case 'safari':
      return { engine: 'webkit', channel: null };
    default:
      if (name.startsWith('chrome-') || name.startsWith('msedge-'))
        return { engine: 'chromium', channel: name };
      throw new TgError(
        'CONFIG_INVALID',
        `Unknown browser "${name}". Use chrome, edge, chromium, firefox or webkit.`,
      );
  }
}

function fromEnv(env: NodeJS.ProcessEnv): Json {
  const o: Json = {};
  const browser: Json = {};
  if (env.TG_BROWSER) Object.assign(browser, browserShortcut(env.TG_BROWSER));
  if (env.TG_BROWSER_HEADLESS)
    browser.headless = env.TG_BROWSER_HEADLESS === '1' || env.TG_BROWSER_HEADLESS === 'true';
  if (env.TG_BROWSER_EXECUTABLE) browser.executablePath = env.TG_BROWSER_EXECUTABLE;
  if (env.TG_BROWSER_CDP_ENDPOINT) browser.cdpEndpoint = env.TG_BROWSER_CDP_ENDPOINT;
  if (env.TG_BROWSER_CHROMIUM_SANDBOX)
    browser.chromiumSandbox =
      env.TG_BROWSER_CHROMIUM_SANDBOX === '1' || env.TG_BROWSER_CHROMIUM_SANDBOX === 'true';
  if (Object.keys(browser).length) o.browser = browser;
  if (env.TG_BROWSER_PROFILE) o.tools = { profile: env.TG_BROWSER_PROFILE };
  if (env.TG_BROWSER_PROJECT) o.project = env.TG_BROWSER_PROJECT;
  if (env.TG_BROWSER_DATA_DIR) o.dataDir = env.TG_BROWSER_DATA_DIR;
  if (env.TG_LOG_LEVEL) o.logLevel = env.TG_LOG_LEVEL;
  return o;
}

function fromCli(cli: CliOverrides): Json {
  const o: Json = {};
  const browser: Json = {};
  if (cli.browser) Object.assign(browser, browserShortcut(cli.browser));
  if (cli.headless !== undefined) browser.headless = cli.headless;
  if (cli.cdpEndpoint) browser.cdpEndpoint = cli.cdpEndpoint;
  if (cli.executablePath) browser.executablePath = cli.executablePath;
  if (Object.keys(browser).length) o.browser = browser;
  if (cli.profile) o.tools = { profile: cli.profile };
  if (cli.project) o.project = cli.project;
  if (cli.allowedDomains?.length) o.security = { allowedDomains: cli.allowedDomains };
  if (cli.logLevel) o.logLevel = cli.logLevel;
  return o;
}

export function findConfigFile(cwd: string = process.cwd()): string | undefined {
  for (const name of CONFIG_FILENAMES) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

export function readConfigFile(file: string): Json {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new TgError('CONFIG_INVALID', `Cannot read config file ${file}: ${(e as Error).message}`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) throw new Error('root must be an object');
    delete parsed.$schema;
    return parsed;
  } catch (e) {
    throw new TgError('CONFIG_INVALID', `Invalid JSON in ${file}: ${(e as Error).message}`);
  }
}

const PARSED = new WeakSet<object>();

/** True when `c` came out of parseConfig/loadConfig (i.e. is fully validated and normalized). */
export function isParsedConfig(c: unknown): c is TgConfig {
  return typeof c === 'object' && c !== null && PARSED.has(c);
}

export function parseConfig(input: TgConfigInput | Json): TgConfig {
  if (isParsedConfig(input)) return input;
  const res = ConfigSchema.safeParse(input);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new TgError('CONFIG_INVALID', `Invalid configuration: ${issues}`);
  }
  const cfg = normalize(res.data);
  PARSED.add(cfg);
  return cfg;
}

function normalize(cfg: TgConfig): TgConfig {
  cfg.dataDir = expandHome(cfg.dataDir);
  cfg.browser.userDataDir = expandHome(cfg.browser.userDataDir);
  if (cfg.network.tls.caFile) cfg.network.tls.caFile = expandHome(cfg.network.tls.caFile);
  cfg.security.fileAccess.allowedRoots = cfg.security.fileAccess.allowedRoots.map(expandHome);
  if (cfg.security.fileAccess.allowedRoots.length === 0) {
    cfg.security.fileAccess.allowedRoots = [process.cwd(), cfg.dataDir];
  }
  return cfg;
}

/**
 * Configuration precedence (lowest → highest):
 *   built-in defaults < config file < environment variables (TG_BROWSER_*) < CLI flags
 */
export function loadConfig(
  cli: CliOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): { config: TgConfig; file?: string } {
  const file = cli.configPath ? path.resolve(cli.configPath) : findConfigFile();
  const fileCfg = file ? readConfigFile(file) : {};
  const merged = deepMerge(deepMerge(fileCfg, fromEnv(env)), fromCli(cli));
  return { config: parseConfig(merged), ...(file ? { file } : {}) };
}
