export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const PAD_LEVELS: Record<LogLevel, number> = {
  DEBUG: 5,
  INFO: 4,
  WARN: 4,
  ERROR: 5,
};

/**
 * Structured logger for pacproxy.
 *
 * Outputs to stderr and respects both a verbose toggle and a minimum log level.
 * When verbose is false, nothing is logged.
 * When verbose is true, only messages at or above minLevel are written.
 *
 * Format: [timestamp] [pacproxy] [LEVEL] [requestId?] message
 */
export class Logger {
  private static nextId = 0;

  constructor(
    private readonly verbose: boolean,
    private readonly minLevel: LogLevel = 'INFO',
    private readonly requestId: string = '',
  ) {}

  /**
   * Create a child logger scoped to a specific request ID, preserving minLevel.
   */
  withRequestId(requestId: string): Logger {
    return new Logger(this.verbose, this.minLevel, requestId);
  }

  /**
   * Generate a unique request ID for tracing.
   */
  nextRequestId(): string {
    const id = (++Logger.nextId).toString(16).padStart(4, '0');
    return id;
  }

  debug(...args: unknown[]): void {
    this.write('DEBUG', ...args);
  }

  info(...args: unknown[]): void {
    this.write('INFO', ...args);
  }

  warn(...args: unknown[]): void {
    this.write('WARN', ...args);
  }

  error(...args: unknown[]): void {
    this.write('ERROR', ...args);
  }

  /**
   * Convenience: log an HTTP proxy resolution event.
   */
  proxyResolution(method: string, host: string, path: string, proxy: string): void {
    this.info(`${method} ${host}${path} -> ${proxy}`);
  }

  /**
   * Convenience: log a CONNECT tunnel event.
   */
  connectTunnel(target: string, proxy: string): void {
    this.info(`CONNECT ${target} -> ${proxy}`);
  }

  /**
   * Format error objects for readable output.
   */
  private formatArg(arg: unknown): string {
    if (arg instanceof Error) {
      return `${arg.message}`;
    }
    return String(arg);
  }

  private write(level: LogLevel, ...args: unknown[]): void {
    if (!this.verbose) return;
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minLevel]) return;

    const timestamp = new Date().toISOString();
    const levelPadded = level.padEnd(PAD_LEVELS[level], ' ');
    const reqPart = this.requestId ? ` [${this.requestId}]` : '';
    const message = args.map(a => this.formatArg(a)).join(' ');

    process.stderr.write(`[${timestamp}] [pacproxy] [${levelPadded}]${reqPart} ${message}\n`);
  }
}
