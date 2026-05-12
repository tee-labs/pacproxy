type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const PAD_LEVELS: Record<LogLevel, number> = {
  DEBUG: 5,
  INFO: 4,
  WARN: 4,
  ERROR: 5,
};

/**
 * Structured logger for pacproxy.
 *
 * Outputs to stderr and is only active when verbose mode is enabled.
 * All log lines include ISO timestamps, log level, and optional request ID.
 *
 * Format: [timestamp] [pacproxy] [LEVEL] [requestId?] message
 */
export class Logger {
  private static nextId = 0;

  constructor(
    private readonly verbose: boolean,
    private readonly requestId: string = '',
  ) {}

  /**
   * Create a child logger scoped to a specific request ID.
   */
  withRequestId(requestId: string): Logger {
    return new Logger(this.verbose, requestId);
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

    const timestamp = new Date().toISOString();
    const levelPadded = level.padEnd(PAD_LEVELS[level], ' ');
    const reqPart = this.requestId ? ` [${this.requestId}]` : '';
    const message = args.map(a => this.formatArg(a)).join(' ');

    process.stderr.write(`[${timestamp}] [pacproxy] [${levelPadded}]${reqPart} ${message}\n`);
  }
}
