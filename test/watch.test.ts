import * as fs from 'fs';
import * as path from 'path';
import { setupFileWatcher, isLocalFile } from '../src/watch';

// Mock engine that records reload calls
class MockEngine {
  public reloadCalls: number = 0;
  reload(): void {
    this.reloadCalls++;
  }
}

// Mock logger
class MockLogger {
  public messages: string[] = [];
  info(...args: unknown[]): void {
    this.messages.push(['INFO', ...args].join(' '));
  }
  warn(...args: unknown[]): void {
    this.messages.push(['WARN', ...args].join(' '));
  }
  error(...args: unknown[]): void {
    this.messages.push(['ERROR', ...args].join(' '));
  }
}

describe('isLocalFile', () => {
  it('should return true for an existing file path', () => {
    const result = isLocalFile(__filename);
    expect(result).toBe(true);
  });

  it('should return false for a non-existent path', () => {
    const result = isLocalFile('/nonexistent/path/for/sure');
    expect(result).toBe(false);
  });

  it('should return false for a URL string', () => {
    const result = isLocalFile('http://example.com/proxy.pac');
    expect(result).toBe(false);
  });
});

describe('setupFileWatcher', () => {
  const tmpDir = fs.mkdtempSync('pacproxy-watch-test-');
  const testPac = path.join(tmpDir, 'test.pac');

  beforeEach(() => {
    fs.writeFileSync(testPac, 'function FindProxyForURL(url, host) { return "DIRECT"; }', 'utf-8');
  });

  afterEach(() => {
    try { fs.unlinkSync(testPac); } catch { /* ignore */ }
  });

  afterAll(() => {
    try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
  });

  it('should create an fs.FSWatcher instance', () => {
    const engine = new MockEngine();
    const logger = new MockLogger();
    const watcher = setupFileWatcher(testPac, engine as any, logger as any);
    expect(watcher).not.toBeNull();
    expect(typeof watcher!.close).toBe('function');
    watcher!.close();
  });

  it('should call engine.reload when the watched file changes', (done) => {
    const engine = new MockEngine();
    const logger = new MockLogger();
    const watcher = setupFileWatcher(testPac, engine as any, logger as any);
    expect(watcher).not.toBeNull();
    let finished = false;

    // Modify the file after a short delay
    setTimeout(() => {
      fs.writeFileSync(testPac, 'function FindProxyForURL(url, host) { return "PROXY localhost:9999"; }', 'utf-8');
    }, 50);

    // Check if reload was called within a reasonable time
    const checkInterval = setInterval(() => {
      if (!finished && engine.reloadCalls >= 1) {
        finished = true;
        clearInterval(checkInterval);
        watcher!.close();
        done();
      }
    }, 20);

    // Timeout after 2 seconds
    setTimeout(() => {
      if (!finished) {
        finished = true;
        clearInterval(checkInterval);
        watcher!.close();
        done(new Error('reload was not called after file change'));
      }
    }, 2000);
  }, 5000);

  it('should log an info message on reload', (done) => {
    const engine = new MockEngine();
    const logger = new MockLogger();
    const watcher = setupFileWatcher(testPac, engine as any, logger as any);
    expect(watcher).not.toBeNull();
    let finished = false;

    setTimeout(() => {
      fs.writeFileSync(testPac, 'function FindProxyForURL(url, host) { return "PROXY changed:9999"; }', 'utf-8');
    }, 50);

    const checkInterval = setInterval(() => {
      if (!finished && logger.messages.some(m => m.includes('reload') || m.includes('changed'))) {
        finished = true;
        clearInterval(checkInterval);
        watcher!.close();
        done();
      }
    }, 20);

    setTimeout(() => {
      if (!finished) {
        finished = true;
        clearInterval(checkInterval);
        watcher!.close();
        done(new Error('reload log message not found'));
      }
    }, 2000);
  }, 5000);

  it('should log a warning for non-existent file paths', () => {
    const engine = new MockEngine();
    const logger = new MockLogger();
    setupFileWatcher('/tmp/does-not-exist.pac', engine as any, logger as any);
    expect(logger.messages.some(m => m.includes('not found') || m.includes('does not exist'))).toBe(true);
  });
});
