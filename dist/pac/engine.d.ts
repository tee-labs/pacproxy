import { URL } from 'url';
import { Proxies, EngineManager, ProxyFinder, Loader } from './types';
export interface OttoEngineOptions {
    loader: Loader;
}
export declare class OttoEngine implements EngineManager, ProxyFinder {
    private loader?;
    private isStarted;
    private vmContext;
    private findProxyFn;
    constructor(loader?: Loader | undefined);
    static withStringLoader(pac: string): OttoEngine;
    start(): void;
    stop(): void;
    reload(): void;
    findProxyForURL(u: URL): Proxies;
}
//# sourceMappingURL=engine.d.ts.map