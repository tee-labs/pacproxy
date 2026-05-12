import * as vm from 'vm';
import { URL } from 'url';
import {
  Proxies,
  DirectProxy,
  Proxy,
  EngineManager,
  ProxyFinder,
  Loader,
} from './types';
import { parseFindProxyString } from './parse';
import * as pacfunc from '../pacfunc';
import { Logger } from '../logger';

export interface OttoEngineOptions {
  loader: Loader;
}

export class OttoEngine implements EngineManager, ProxyFinder {
  private isStarted = false;
  private vmContext: vm.Context | null = null;
  private findProxyFn: ((url: string, host: string) => string) | null = null;
  private pacSource = '';
  private readonly logger: Logger;

  constructor(private loader?: Loader, extLogger?: Logger) {
    this.logger = extLogger ?? new Logger(false);
  }

  static withStringLoader(pac: string): OttoEngine {
    return new OttoEngine(() => pac);
  }

  start(): void {
    if (this.isStarted) {
      this.logger.warn('Engine already started, skipping');
      return;
    }

    const loader = this.loader;
    if (!loader) {
      this.logger.error('PAC loader has not been configured');
      throw new Error('PAC loader has not been configured');
    }

    this.logger.info('Starting PAC engine...');
    const pac = loader();
    this.pacSource = pac;

    const sandbox = {
      console: {
        log: (...args: unknown[]) => {
          this.logger.debug('[PAC]', ...args);
        },
      },
      convert_addr: (ipaddr: string): number => pacfunc.convertAddr(ipaddr),
      dnsDomainIs: (host: string, domain: string): boolean =>
        pacfunc.dnsDomainIs(host, domain),
      shExpMatch: (str: string, shexp: string): boolean =>
        pacfunc.shExpMatch(str, shexp),
      isInNet: (host: string, netip: string, netmask: string): boolean =>
        pacfunc.isInNet(host, netip, netmask),
      myIpAddress: (): string => pacfunc.myIPAddress(),
      dnsResolve: (host: string): string => pacfunc.dnsResolve(host),
      isPlainHostName: (host: string): boolean =>
        pacfunc.isPlainHostName(host),
      localHostOrDomainIs: (host: string, hostdom: string): boolean =>
        pacfunc.localHostOrDomainIs(host, hostdom),
      isResolvable: (host: string): boolean => pacfunc.isResolvable(host),
      dnsDomainLevels: (host: string): number =>
        pacfunc.dnsDomainLevels(host),
      weekdayRange: function (...args: unknown[]): boolean {
        const wd1 = String(args[0] ?? '');
        const wd2 = String(args[1] ?? '');
        const gmt = String(args[2] ?? '');
        return pacfunc.weekdayRange(wd1, wd2, gmt);
      },
      dateRange: function (...args: unknown[]): boolean {
        const strArgs = args.map(a => String(a));
        return pacfunc.dateRange(...strArgs);
      },
      timeRange: function (...args: unknown[]): boolean {
        const strArgs = args.map(a => String(a));
        return pacfunc.timeRange(...strArgs);
      },
    };

    this.vmContext = vm.createContext(sandbox);
    vm.runInContext(pac, this.vmContext);

    const fn = this.vmContext.FindProxyForURL;
    if (typeof fn !== 'function') {
      this.vmContext = null;
      if (fn === undefined) {
        this.logger.error("FindProxyForURL is not defined in PAC script");
        throw new Error("ReferenceError: 'FindProxyForURL' is not defined");
      }
      this.logger.error('FindProxyForURL is not a function');
      throw new Error('TypeError: "FindProxyForURL" is not a function');
    }

    this.findProxyFn = fn as (url: string, host: string) => string;
    this.isStarted = true;
    this.logger.info('PAC engine started successfully');
  }

  stop(): void {
    this.logger.info('Stopping PAC engine');
    this.vmContext = null;
    this.findProxyFn = null;
    this.pacSource = '';
    this.isStarted = false;
  }

  reload(): void {
    this.logger.info('Reloading PAC script...');
    this.stop();
    this.start();
  }

  findProxyForURL(u: URL): Proxies {
    if (!this.findProxyFn) {
      this.logger.error('findProxyForURL called but engine not started');
      throw new Error('PAC engine not started');
    }

    this.logger.debug('findProxyForURL:', u.toString());
    const result = String(this.findProxyFn(u.toString(), u.hostname));
    this.logger.debug('PAC result:', result);

    return parseFindProxyString(result);
  }
}
