export type ProxyType = 'http' | 'socks5' | 'socks4';

export interface Proxy {
  type: ProxyType;
  hostname: string;
  port: number;
  username?: string;
  password?: string;
}

export const DirectProxy: Proxy = { type: 'http', hostname: '', port: 0 };

export function isDirectProxy(p: Proxy): boolean {
  return p.hostname === '' && p.port === 0;
}

export class Proxies {
  constructor(private readonly items: Proxy[] = []) {}

  get length(): number {
    return this.items.length;
  }

  get(index: number): Proxy {
    return this.items[index];
  }

  toString(): string {
    return this.items
    .map(p => {
      if (isDirectProxy(p)) return 'DIRECT';
      const auth = p.username ? `${p.username}:${p.password}@` : '';
      const cmd = p.type === 'socks5' ? 'SOCKS5' : p.type === 'socks4' ? 'SOCKS' : 'PROXY';
      return `${cmd} ${auth}${p.hostname}:${p.port}`;
      })
      .join('; ');
  }

  toArray(): Proxy[] {
    return [...this.items];
  }
}

export type Loader = () => string;

export interface EngineManager {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  reload(): void | Promise<void>;
}

export interface ProxyFinder {
  findProxyForURL(url: URL): Proxies | Promise<Proxies>;
}

export interface ProxySelector {
  selectProxy(from: Proxies): Proxy;
}
