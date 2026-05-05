import { Proxies, Proxy, DirectProxy } from './types';
import { ProxySelector } from './types';

export class FirstItemSelector implements ProxySelector {
  selectProxy(from: Proxies): Proxy {
    if (from.length < 1) return DirectProxy;
    return from.get(0);
  }
}
