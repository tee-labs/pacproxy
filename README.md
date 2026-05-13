# pacproxy

A no-frills local HTTP proxy server powered by a proxy auto-config (PAC) file.

## Installation

```bash
npm install pacproxy
```

## Usage

### CLI

```bash
pacproxy -c <pac> [-l <listen>] [-v] [-r <url>]
```

| Flag | Description |
|------|-------------|
| `-c` | PAC file name, URL, or JavaScript string (required) |
| `-l` | Interface and port to listen on (default: `127.0.0.1:8080`) |
| `-v` | Enable verbose output (INFO level and above) |
| `-L`, `--log-level <level>` | Set log level: `debug`, `info`, `warn`, `error` (default: `info`, implies `-v`) |
| `-r` | Resolve the proxies for a given URL to STDOUT and exit |

### Examples

Start a proxy server with a local PAC file:

```bash
pacproxy -c proxy.pac
```

Use a PAC file from a URL:

```bash
pacproxy -c https://example.com/proxy.pac
```

Use an inline PAC string:

```bash
pacproxy -c "PROXY proxy.example.com:8080; DIRECT"
```

Resolve which proxy would be used for a URL without starting a server:

```bash
pacproxy -c proxy.pac -r https://www.google.com/
```

Listen on all interfaces:

```bash
pacproxy -c proxy.pac -l 0.0.0.0:3128
```

### Upstream Proxy Authentication

When the PAC file returns `PROXY upstream.example.com:8080` (without embedded credentials), you can provide authentication via environment variables:

```bash
# Via .env file (auto-loaded)
echo "PROXY_USER=myuser" >> .env
echo "PROXY_PASS=mypassword" >> .env
pacproxy -c proxy.pac

# Via environment variables
export PROXY_USER=myuser
export PROXY_PASS=mypassword
pacproxy -c proxy.pac

# Single-line
PROXY_USER=myuser PROXY_PASS=mypassword pacproxy -c proxy.pac
```

**Auth priority:**

1. PAC file embedded auth — `PROXY user:pass@host:port`
2. Environment variables — `PROXY_USER` / `PROXY_PASS`
3. Client `Proxy-Authorization` header

### SIGHUP — Reload PAC

Send `SIGHUP` to the running process to reload the PAC file without restarting the server:

```bash
kill -HUP <pid>
```

## Programmatic API

```typescript
import { OttoEngine } from 'pacproxy/pac/engine';
import { FirstItemSelector } from 'pacproxy/pac/selector';
import { ProxyHTTPHandler } from 'pacproxy/proxy/handler';
import { smartLoader, fileLoader, stringLoader } from 'pacproxy/pac/loader';

// Load a PAC file from disk
const engine = new OttoEngine(fileLoader('./proxy.pac'));
engine.start();

// Or use a string directly
const engine = OttoEngine.withStringLoader('PROXY proxy.example.com:8080; DIRECT');
engine.start();

// Resolve a proxy
const url = new URL('https://www.example.com/');
const proxies = engine.findProxyForURL(url);
console.log(proxies.toString()); // "PROXY proxy.example.com:8080; DIRECT"

// Start an HTTP proxy server
const selector = new FirstItemSelector();
const handler = new ProxyHTTPHandler(engine, selector);
const server = handler.createServer();
server.listen(8080, '127.0.0.1');
```

### Loaders

| Loader | Description |
|--------|-------------|
| `fileLoader(path)` | Load PAC content from a local file |
| `httpLoader(url)` | Load PAC content from an HTTP/HTTPS URL (synchronous, 30s timeout) |
| `stringLoader(pac)` | Use a raw PAC string |
| `smartLoader(input)` | Auto-detects the input type — tries parsing as a PAC result string, then as raw JS, then as a URL, then as a file path |

### PAC Functions

The engine implements the standard PAC helper functions:

- `convert_addr(ipaddr)` — Convert IPv4 address to integer
- `dnsDomainIs(host, domain)` — Check if host belongs to a domain
- `shExpMatch(str, shexp)` — Shell expression pattern matching
- `isInNet(host, netip, netmask)` — Check if host is in a subnet
- `myIpAddress()` — Return the local IP address
- `dnsResolve(host)` — Resolve a hostname to an IP
- `isPlainHostName(host)` — Check if hostname has no dots
- `localHostOrDomainIs(host, hostdom)` — Check if host matches a local domain
- `isResolvable(host)` — Check if any network interface is available
- `dnsDomainLevels(host)` — Count domain levels
- `weekdayRange(wd1, wd2?, gmt?)` — Check if current weekday is in range
- `dateRange(...args)` — Check if current date is in range
- `timeRange(...args)` — Check if current time is in range

## Requirements

- Node.js >= 18

## Scripts

```bash
npm run build   # Compile TypeScript
npm run test    # Run tests with Jest
npm start       # Run the compiled proxy server
npm run dev     # Run directly with ts-node
```

## License

Apache-2.0

## Repository

https://github.com/williambailey/pacproxy
