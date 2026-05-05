import * as http from 'http';
import { ProxyFinder, ProxySelector } from '../pac/types';
export declare class ProxyHTTPHandler {
    private readonly proxyFinder;
    private readonly proxySelector;
    private readonly httpClient;
    private readonly nonProxyHandler;
    constructor(proxyFinder: ProxyFinder, proxySelector: ProxySelector, nonProxyHandler?: http.RequestListener);
    createServer(): http.Server;
    handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
    private handleHTTP;
    private handleConnect;
    private lookupProxy;
    private doHTTPProxy;
}
//# sourceMappingURL=handler.d.ts.map