export interface Proxy {
    hostname: string;
    port: number;
}
export declare const DirectProxy: Proxy;
export declare function isDirectProxy(p: Proxy): boolean;
export declare class Proxies {
    private readonly items;
    constructor(items?: Proxy[]);
    get length(): number;
    get(index: number): Proxy;
    toString(): string;
    toArray(): Proxy[];
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
//# sourceMappingURL=types.d.ts.map