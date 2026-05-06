import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { OttoEngine } from './pac/engine';
import { FirstItemSelector } from './pac/selector';
import { ProxyHTTPHandler } from './proxy/handler';
import { smartLoader } from './pac/loader';

const NAME = 'pacproxy';
const VERSION = '2.0.7';
const ABOUT = 'A no-frills local HTTP server powered by a proxy auto-config (PAC) file';
const REPO = 'https://github.com/williambailey/pacproxy';

interface CliOptions {
  pac: string;
  listen: string;
  verbose: boolean;
  resolve: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    pac: '',
    listen: '127.0.0.1:8080',
    verbose: false,
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
  console.log('  -c string    PAC file name, url or javascript to use (required)');
  console.log('  -l string    Interface and port to listen on (default "127.0.0.1:8080")');
  console.log('  -r string    Resolve the proxies for the provided url to STDOUT and exit');
  console.log('  -v           Send verbose output to STDERR');
}

function verboseLog(verbose: boolean, ...args: unknown[]): void {
  if (verbose) {
    process.stderr.write(`[pacproxy] ${args.map(String).join(' ')}\n`);
  }
}

function main(): void {
  const opts = parseArgs(process.argv);

  if (!opts.pac.trim()) {
    process.stderr.write('Missing required flag -c\n');
    printUsage();
    process.exit(2);
  }

  verboseLog(opts.verbose, 'PAC source:', opts.pac);

  const engine = new OttoEngine(smartLoader(opts.pac));
  engine.start();

  if (opts.resolve) {
    doResolve(engine, opts.resolve);
    return;
  }

  startServer(engine, opts.listen, opts.verbose);
}

function doResolve(engine: OttoEngine, resolveUrl: string): void {
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
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}

function startServer(engine: OttoEngine, listenAddr: string, verbose: boolean): void {
    const selector = new FirstItemSelector();
    const proxyHandler = new ProxyHTTPHandler(engine, selector, undefined, verbose);

    const [host, portStr] = listenAddr.includes(':')
      ? listenAddr.split(':')
      : ['127.0.0.1', listenAddr];
    const port = parseInt(portStr, 10);

    const server = proxyHandler.createServer();

    server.keepAliveTimeout = 60000;
    server.headersTimeout = 65000;

  server.listen(port, host, () => {
    process.stdout.write(`Listening on "${listenAddr}"\n`);
  });

  process.on('SIGHUP', () => {
    verboseLog(verbose, 'Received SIGHUP, reloading PAC');
    try {
      engine.reload();
    } catch (err: any) {
      process.stderr.write(`Failed to reload PAC: ${err.message}\n`);
      process.exit(1);
    }
  });
}

main();
