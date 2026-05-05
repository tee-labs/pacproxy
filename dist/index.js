"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const url_1 = require("url");
const engine_1 = require("./pac/engine");
const selector_1 = require("./pac/selector");
const handler_1 = require("./proxy/handler");
const loader_1 = require("./pac/loader");
const NAME = 'pacproxy';
const VERSION = '2.0.7';
const ABOUT = 'A no-frills local HTTP server powered by a proxy auto-config (PAC) file';
const REPO = 'https://github.com/williambailey/pacproxy';
function parseArgs(argv) {
    const opts = {
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
function printUsage() {
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
function main() {
    const opts = parseArgs(process.argv);
    if (!opts.pac.trim()) {
        process.stderr.write('Missing required flag -c\n');
        printUsage();
        process.exit(2);
    }
    if (!opts.verbose) {
        console.log = () => { };
    }
    const engine = new engine_1.OttoEngine((0, loader_1.smartLoader)(opts.pac));
    engine.start();
    if (opts.resolve) {
        doResolve(engine, opts.resolve);
        return;
    }
    startServer(engine, opts.listen);
}
function doResolve(engine, resolveUrl) {
    try {
        const u = new url_1.URL(resolveUrl);
        const proxies = engine.findProxyForURL(u);
        const arr = proxies.toArray();
        for (const p of arr) {
            if (p.hostname === '' && p.port === 0) {
                process.stdout.write('DIRECT\n');
            }
            else {
                process.stdout.write(`PROXY ${p.hostname}:${p.port}\n`);
            }
        }
    }
    catch (err) {
        process.stderr.write(`Error: ${err.message}\n`);
        process.exit(1);
    }
}
function startServer(engine, listenAddr) {
    const selector = new selector_1.FirstItemSelector();
    const proxyHandler = new handler_1.ProxyHTTPHandler(engine, selector);
    const [host, portStr] = listenAddr.includes(':')
        ? listenAddr.split(':')
        : ['127.0.0.1', listenAddr];
    const port = parseInt(portStr, 10);
    const server = proxyHandler.createServer();
    server.keepAliveTimeout = 60000;
    server.headersTimeout = 65000;
    server.listen(port, host, () => {
        console.log(`Listening on "${listenAddr}"`);
    });
    process.on('SIGHUP', () => {
        console.log('SIGHUP');
        try {
            engine.reload();
        }
        catch (err) {
            process.stderr.write(`Failed to reload PAC: ${err.message}\n`);
            process.exit(1);
        }
    });
}
main();
//# sourceMappingURL=index.js.map