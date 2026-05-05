import { Proxies, Proxy, DirectProxy } from './types';

const PAC_STATEMENT_SPLIT = /\s*;\s*/;
const PAC_ITEM_SPLIT = /\s+/;

export function parseFindProxyString(s: string): Proxies {
  const proxies: Proxy[] = [];
  const statements = s.split(PAC_STATEMENT_SPLIT);

  for (const statement of statements) {
    if (statement === '') continue;
    const part = statement.split(PAC_ITEM_SPLIT).slice(0, 2);
    const cmd = part[0].toUpperCase();

    switch (cmd) {
      case 'DIRECT':
        proxies.push(DirectProxy);
        break;
      case 'PROXY': {
        if (part.length !== 2) {
          throw new Error(`unable to parse proxy details from "${statement}"`);
        }
        const addr = part[1];
        const colonIdx = addr.lastIndexOf(':');
        if (colonIdx < 0) {
          throw new Error(`unable to parse hostname and port from "${addr}"`);
        }
        const hostname = addr.substring(0, colonIdx);
        const portStr = addr.substring(colonIdx + 1);
        const port = parseInt(portStr, 10);
        if (hostname === '' || portStr === '' || isNaN(port)) {
          throw new Error(`unable to parse hostname and port from "${addr}"`);
        }
        proxies.push({ hostname, port });
        break;
      }
      default:
        throw new Error(`unsupported PAC command "${cmd}"`);
    }
  }

  return new Proxies(proxies);
}
