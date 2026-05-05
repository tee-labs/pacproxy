"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProxyHTTPHandler = void 0;
const http = __importStar(require("http"));
const net = __importStar(require("net"));
const url_1 = require("url");
class ProxyHTTPHandler {
    proxyFinder;
    proxySelector;
    httpClient;
    nonProxyHandler;
    constructor(proxyFinder, proxySelector, nonProxyHandler) {
        this.proxyFinder = proxyFinder;
        this.proxySelector = proxySelector;
        this.httpClient = new http.Agent({
            keepAlive: true,
            maxSockets: 50,
            maxFreeSockets: 20,
            timeout: 60000,
        });
        this.nonProxyHandler = nonProxyHandler ?? defaultNonProxyHandler;
    }
    createServer() {
        const server = http.createServer((req, res) => {
            this.handleHTTP(req, res).catch(() => {
                if (!res.headersSent) {
                    res.writeHead(502);
                    res.end('Bad Gateway');
                }
            });
        });
        server.on('connect', (req, clientSocket, head) => {
            this.handleConnect(req, clientSocket, head).catch(() => {
                clientSocket.destroy();
            });
        });
        return server;
    }
    async handle(req, res) {
        if (req.method === 'CONNECT') {
            throw new Error('CONNECT should be handled at server level');
        }
        await this.handleHTTP(req, res);
    }
    async handleHTTP(req, res) {
        if (req.url && req.url.startsWith('http')) {
            await this.doHTTPProxy(req, res);
        }
        else if (this.nonProxyHandler) {
            this.nonProxyHandler(req, res);
        }
        else {
            res.writeHead(400);
            res.end();
        }
    }
    async handleConnect(req, clientSocket, head) {
        let serverConn = null;
        try {
            const proxyUrl = await this.lookupProxy(req);
            const targetHostPort = req.url;
            const colonIdx = targetHostPort.lastIndexOf(':');
            const targetHost = proxyUrl ? proxyUrl.hostname : targetHostPort.substring(0, colonIdx);
            const targetPort = proxyUrl
                ? parseInt(proxyUrl.port, 10) || 443
                : parseInt(targetHostPort.substring(colonIdx + 1), 10) || 443;
            serverConn = await tcpConnect(targetHost, targetPort);
            if (proxyUrl) {
                const connectReq = `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n\r\n`;
                serverConn.write(connectReq);
            }
            else {
                clientSocket.write('HTTP/1.0 200 OK\r\n\r\n');
                if (head.length > 0) {
                    serverConn.write(head);
                }
            }
            serverConn.pipe(clientSocket);
            clientSocket.pipe(serverConn);
            const cleanup = () => {
                if (serverConn && !serverConn.destroyed)
                    serverConn.destroy();
                if (!clientSocket.destroyed)
                    clientSocket.destroy();
            };
            serverConn.on('close', cleanup);
            clientSocket.on('close', cleanup);
            serverConn.on('error', cleanup);
            clientSocket.on('error', cleanup);
        }
        catch (err) {
            if (serverConn)
                serverConn.destroy();
            try {
                clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            }
            catch { /* ignore */ }
            clientSocket.destroy();
        }
    }
    async lookupProxy(req) {
        const urlStr = req.url;
        const fullUrl = urlStr.startsWith('http') ? urlStr : `http://${urlStr}`;
        const targetUrl = new url_1.URL(fullUrl);
        const proxies = await this.proxyFinder.findProxyForURL(targetUrl);
        const proxy = this.proxySelector.selectProxy(proxies);
        if (proxy.hostname === '' && proxy.port === 0) {
            return null;
        }
        const proxyUrl = new url_1.URL(`http://${proxy.hostname}:${proxy.port}`);
        const proxyAuth = req.headers['proxy-authorization'];
        if (proxyAuth) {
            const parsed = parseBasicAuth(proxyAuth);
            if (parsed) {
                proxyUrl.username = parsed.username;
                proxyUrl.password = parsed.password;
            }
        }
        return proxyUrl;
    }
    async doHTTPProxy(req, res) {
        removeProxyHeaders(req);
        const targetUrl = new url_1.URL(req.url);
        const options = {
            hostname: targetUrl.hostname,
            port: parseInt(targetUrl.port, 10) || 80,
            path: targetUrl.pathname + targetUrl.search,
            method: req.method,
            headers: req.headers,
            agent: this.httpClient,
        };
        const headers = options.headers;
        delete headers['proxy-connection'];
        delete headers['proxy-authorization'];
        const proxyReq = http.request(options, (proxyRes) => {
            for (const key of res.getHeaderNames()) {
                res.removeHeader(key);
            }
            copyHeaders(res, proxyRes.headers);
            res.writeHead(proxyRes.statusCode || 200);
            proxyRes.pipe(res);
        });
        proxyReq.on('error', (err) => {
            if (!res.headersSent) {
                res.writeHead(502);
                res.end(err.message || 'Bad Gateway');
            }
        });
        req.pipe(proxyReq);
    }
}
exports.ProxyHTTPHandler = ProxyHTTPHandler;
function tcpConnect(host, port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, host);
        socket.setTimeout(10000);
        socket.on('connect', () => resolve(socket));
        socket.on('timeout', () => {
            socket.destroy();
            reject(new Error(`Connection to ${host}:${port} timed out`));
        });
        socket.on('error', reject);
    });
}
function removeProxyHeaders(req) {
    delete req.headers['accept-encoding'];
    delete req.headers['proxy-connection'];
    delete req.headers['connection'];
}
function copyHeaders(dst, src) {
    for (const [key, value] of Object.entries(src)) {
        if (value !== undefined) {
            if (Array.isArray(value)) {
                value.forEach(v => dst.setHeader(key, v));
            }
            else {
                dst.setHeader(key, value);
            }
        }
    }
}
function parseBasicAuth(auth) {
    const prefix = 'Basic ';
    if (!auth.startsWith(prefix))
        return null;
    try {
        const decoded = Buffer.from(auth.substring(prefix.length), 'base64').toString('utf-8');
        const colonIdx = decoded.indexOf(':');
        if (colonIdx < 0)
            return null;
        return {
            username: decoded.substring(0, colonIdx),
            password: decoded.substring(colonIdx + 1),
        };
    }
    catch {
        return null;
    }
}
function defaultNonProxyHandler(req, res) {
    res.writeHead(502);
    res.end(`pacproxy v2.0.7\nhttps://github.com/williambailey/pacproxy`);
}
//# sourceMappingURL=handler.js.map