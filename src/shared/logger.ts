import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Structured logger. ALWAYS writes to stderr (fd 2): in STDIO transport mode stdout is reserved
 * exclusively for MCP protocol frames, so any stdout logging would corrupt the protocol stream.
 */
export type { Logger };

const REDACT_PATHS = [
  'password',
  '*.password',
  'token',
  '*.token',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'headers.cookie',
  'cookie',
  '*.cookie',
  'proxy.password',
  'value',
  '*.value',
];

export function createLogger(
  level: string = process.env.TG_LOG_LEVEL ?? 'info',
  extra: LoggerOptions = {},
): Logger {
  return pino(
    {
      level,
      base: { svc: 'tg-browser-mcp' },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      timestamp: pino.stdTimeFunctions.isoTime,
      ...extra,
    },
    pino.destination({ fd: 2, sync: true }),
  );
}

let rootLogger: Logger | undefined;

export function getLogger(): Logger {
  rootLogger ??= createLogger();
  return rootLogger;
}

export function setLogger(logger: Logger): void {
  rootLogger = logger;
}
