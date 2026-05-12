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

        // Split out auth portion: "user:pass@host:port"
        let hostnameAndPort = addr;
        let username: string | undefined;
        let password: string | undefined;
        const atIdx = addr.indexOf('@');
        if (atIdx >= 0) {
          const authPart = addr.substring(0, atIdx);
          hostnameAndPort = addr.substring(atIdx + 1);
          const colonIdx = authPart.indexOf(':');
          if (colonIdx >= 0) {
            username = decodeURIComponent(authPart.substring(0, colonIdx));
            password = decodeURIComponent(authPart.substring(colonIdx + 1));
          } else {
            username = decodeURIComponent(authPart);
          }
        }

        const colonIdx = hostnameAndPort.lastIndexOf(':');
        if (colonIdx < 0) {
          throw new Error(`unable to parse hostname and port from "${addr}"`);
        }
        const hostname = hostnameAndPort.substring(0, colonIdx);
        const portStr = hostnameAndPort.substring(colonIdx + 1);
        const port = parseInt(portStr, 10);
        if (hostname === '' || portStr === '' || isNaN(port)) {
          throw new Error(`unable to parse hostname and port from "${addr}"`);
        }
        proxies.push({ hostname, port, username, password });
        break;
      }
      default:
        throw new Error(`unsupported PAC command "${cmd}"`);
    }
  }

  return new Proxies(proxies);
}
