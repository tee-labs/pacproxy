import 'dotenv/config';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { OttoEngine } from './pac/engine';
import { FirstItemSelector } from './pac/selector';
import { ProxyHTTPHandler } from './proxy/handler';
import { smartLoader } from './pac/loader';
import { Logger, type LogLevel } from './logger';

const NAME = 'pacproxy';
const VERSION = '2.0.7';
const ABOUT = 'A no-frills local HTTP server powered by a proxy auto-config (PAC) file';
const REPO = 'https://github.com/williambailey/pacproxy';

interface CliOptions {
  pac: string;
  listen: string;
  verbose: boolean;
  logLevel: LogLevel;
  resolve: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    pac: '',
    listen: '127.0.0.1:8080',
    verbose: false,
    logLevel: 'INFO',
    resolve: '',
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-c':
        opts.pac = argv[++i];
        break;
      case '-l':
        opts.listen = argv[++i];
        break;
      case '-v':
        opts.verbose = true;
        break;
      case '-L':
      case '--log-level': {
        const val = argv[++i]?.toLowerCase();
        if (val === 'debug' || val === 'info' || val === 'warn' || val === 'error') {
          opts.verbose = true;
          opts.logLevel = val.toUpperCase() as LogLevel;
        } else {
          process.stderr.write(`Invalid log level "${val}". Use: debug, info, warn, error\n`);
          process.exit(2);
        }
        break;
      }
      case '-r':
        opts.resolve = argv[++i];
        break;
      case '-h':
      case '--help':
        printUsage();
        process.exit(0);
        break;
    }
  }

  return opts;
}

function printUsage(): void {
  console.log(`${NAME} v${VERSION}`);
  console.log('');
  console.log(ABOUT);
  console.log(REPO);
  console.log('');
  console.log('Usage:');
  console.log('  -c string      PAC file name, url or javascript to use (required)');
  console.log('  -l string      Interface and port to listen on (default "127.0.0.1:8080")');
  console.log('  -r string      Resolve the proxies for the provided url to STDOUT and exit');
  console.log('  -v             Enable verbose output (INFO level, use --log-level for more control)');
  console.log('  -L, --log-level <level>  Set log level: debug, info, warn, error (default: info)');
}

function main(): void {
  const opts = parseArgs(process.argv);
  const logger = new Logger(opts.verbose, opts.logLevel);

  logger.info(`${NAME} v${VERSION} starting`);
  logger.info(ABOUT);
  logger.info(REPO);

  if (!opts.pac.trim()) {
    logger.error('Missing required flag -c');
    process.stderr.write('Missing required flag -c\n');
    printUsage();
    process.exit(2);
  }

  logger.info('PAC source:', opts.pac);
  logger.info('Listen address:', opts.listen);

  const engine = new OttoEngine(smartLoader(opts.pac, logger), logger);
  engine.start();

  if (opts.resolve) {
    doResolve(engine, opts.resolve, logger);
    return;
  }

  startServer(engine, opts.listen, logger);
}

function doResolve(engine: OttoEngine, resolveUrl: string, logger: Logger): void {
  logger.info('Resolving proxy for:', resolveUrl);
  try {
    const u = new URL(resolveUrl);
    const proxies = engine.findProxyForURL(u);
    const arr = proxies.toArray();
    for (const p of arr) {
      if (p.hostname === '' && p.port === 0) {
        process.stdout.write('DIRECT\n');
      } else {
        process.stdout.write(`PROXY ${p.hostname}:${p.port}\n`);
      }
    }
  } catch (err: any) {
    logger.error('Resolution failed:', err);
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}

function startServer(engine: OttoEngine, listenAddr: string, logger: Logger): void {
    const selector = new FirstItemSelector();
    const proxyHandler = new ProxyHTTPHandler(engine, selector, undefined, logger ? true : false, logger);

    const [host, portStr] = listenAddr.includes(':')
      ? listenAddr.split(':')
      : ['127.0.0.1', listenAddr];
    const port = parseInt(portStr, 10);

    const server = proxyHandler.createServer();

    server.keepAliveTimeout = 60000;
    server.headersTimeout = 65000;

  server.listen(port, host, () => {
    logger.info(`Listening on "${listenAddr}"`);
    process.stdout.write(`Listening on "${listenAddr}"\n`);
  });

  process.on('SIGHUP', () => {
    logger.info('Received SIGHUP, reloading PAC');
    try {
      engine.reload();
    } catch (err: any) {
      logger.error('Failed to reload PAC:', err);
      process.stderr.write(`Failed to reload PAC: ${err.message}\n`);
      process.exit(1);
    }
  });
}

main();
