import { Logger } from '../src/logger';

describe('Logger', () => {
  let stderrOutput: string[];

  beforeEach(() => {
    stderrOutput = [];
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      stderrOutput.push(chunk.toString());
      return true;
    });
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function logLine(logger: Logger): RegExp {
    return /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[pacproxy\]/;
  }

  describe('basic logging', () => {
    it('should log nothing when verbose is false', () => {
      const logger = new Logger(false);
      logger.info('hello');
      expect(stderrOutput).toHaveLength(0);
    });

    it('should log to stderr when verbose is true', () => {
      const logger = new Logger(true);
      logger.info('hello');
      expect(stderrOutput.length).toBeGreaterThan(0);
    });

    it('should include timestamp in log output', () => {
      const logger = new Logger(true);
      logger.info('test message');
      expect(stderrOutput[0]).toMatch(logLine(logger));
    });

    it('should include log level in output', () => {
      const logger = new Logger(true);
      logger.info('info msg');
      expect(stderrOutput[0]).toContain('[INFO]');
    });
  });

  describe('log levels', () => {
    it('should output DEBUG level messages when minLevel is DEBUG', () => {
      const logger = new Logger(true, 'DEBUG');
      logger.debug('debug msg');
      expect(stderrOutput[0]).toContain('[DEBUG]');
    });

    it('should output INFO level messages', () => {
      const logger = new Logger(true);
      logger.info('info msg');
      expect(stderrOutput[0]).toContain('[INFO]');
    });

    it('should output WARN level messages', () => {
      const logger = new Logger(true);
      logger.warn('warn msg');
      expect(stderrOutput[0]).toContain('[WARN]');
    });

    it('should output ERROR level messages', () => {
      const logger = new Logger(true);
      logger.error('error msg');
      expect(stderrOutput[0]).toContain('[ERROR]');
    });

    it('should suppress DEBUG when minLevel is INFO (default)', () => {
      const logger = new Logger(true);
      logger.debug('should be hidden');
      expect(stderrOutput).toHaveLength(0);
    });

    it('should suppress INFO when minLevel is WARN', () => {
      const logger = new Logger(true, 'WARN');
      logger.info('should be hidden');
      expect(stderrOutput).toHaveLength(0);
    });

    it('should suppress WARN when minLevel is ERROR', () => {
      const logger = new Logger(true, 'ERROR');
      logger.warn('should be hidden');
      expect(stderrOutput).toHaveLength(0);
    });

    it('should show all levels when minLevel is DEBUG', () => {
      const logger = new Logger(true, 'DEBUG');
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      expect(stderrOutput).toHaveLength(4);
    });

    it('should output nothing when verbose is false regardless of level', () => {
      const logger = new Logger(false, 'DEBUG');
      logger.error('critical');
      expect(stderrOutput).toHaveLength(0);
    });

    it('withRequestId should preserve minLevel', () => {
      const logger = new Logger(true, 'WARN');
      const child = logger.withRequestId('abc');
      logger.info('parent info');      // filtered: minLevel=WARN > INFO
      child.info('child info');        // filtered
      child.warn('child warn');        // passes
      expect(stderrOutput).toHaveLength(1);
      expect(stderrOutput[0]).toContain('[WARN]');
      expect(stderrOutput[0]).toContain('[abc]');
    });
  });

  describe('multiple arguments', () => {
    it('should join multiple arguments with space', () => {
      const logger = new Logger(true);
      logger.info('foo', 'bar', 'baz');
      expect(stderrOutput[0]).toContain('foo bar baz');
    });

    it('should handle numbers and objects', () => {
      const logger = new Logger(true);
      logger.info('count:', 42);
      expect(stderrOutput[0]).toContain('count: 42');
    });
  });

  describe('request ID', () => {
    it('should include request ID when provided', () => {
      const logger = new Logger(true);
      logger.withRequestId('abc123').info('req msg');
      expect(stderrOutput[0]).toContain('[abc123]');
    });

    it('should chain multiple calls with same requestId', () => {
      const logger = new Logger(true);
      const reqLog = logger.withRequestId('xyz');
      reqLog.info('msg1');
      reqLog.info('msg2');
      expect(stderrOutput[0]).toContain('[xyz]');
      expect(stderrOutput[1]).toContain('[xyz]');
    });

    it('should produce sequential request IDs', () => {
      const logger = new Logger(true);
      const id1 = logger.nextRequestId();
      const id2 = logger.nextRequestId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('PAC formatted output', () => {
    it('should format proxy resolution messages', () => {
      const logger = new Logger(true);
      logger.proxyResolution('GET', 'example.com', '/path', 'DIRECT');
      const out = stderrOutput[0];
      expect(out).toContain('GET');
      expect(out).toContain('example.com');
      expect(out).toContain('DIRECT');
    });

    it('should format CONNECT tunnel messages', () => {
      const logger = new Logger(true);
      logger.connectTunnel('example.com:443', 'PROXY proxy:8080');
      const out = stderrOutput[0];
      expect(out).toContain('CONNECT');
      expect(out).toContain('example.com:443');
    });
  });

  describe('error logging', () => {
    it('should log Error with stack trace in debug mode', () => {
      const logger = new Logger(true);
      const err = new Error('something broke');
      logger.error('failed:', err);
      expect(stderrOutput[0]).toContain('something broke');
    });
  });
});
