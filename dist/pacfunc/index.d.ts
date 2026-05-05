export interface Nower {
    now(): Date;
}
export declare class TimeNower implements Nower {
    now(): Date;
}
export declare class StaticNower implements Nower {
    private readonly _now;
    constructor(_now: Date);
    now(): Date;
}
export declare let defaultNower: Nower;
export declare function setDefaultNower(nower: Nower): void;
export declare function restoreDefaultNower(): void;
export declare function convertAddr(ipaddr: string): number;
export declare function dnsDomainIs(host: string, domain: string): boolean;
export declare function shExpMatch(str: string, shexp: string): boolean;
export declare function isInNet(host: string, netip: string, netmask: string): boolean;
export declare function myIPAddress(): string;
export declare function dnsResolve(host: string): string;
export declare function isPlainHostName(host: string): boolean;
export declare function localHostOrDomainIs(host: string, hostdom: string): boolean;
export declare function isResolvable(host: string): boolean;
export declare function dnsDomainLevels(host: string): number;
export declare function weekdayRange(wd1: string, wd2: string, gmt: string): boolean;
export declare function dateRange(...args: string[]): boolean;
export declare function timeRange(...args: string[]): boolean;
//# sourceMappingURL=index.d.ts.map