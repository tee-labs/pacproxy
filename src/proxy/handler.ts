import * as http from 'http';
import * as net from 'net';
import { URL } from 'url';
import { ProxyFinder, ProxySelector, Proxies, Proxy, DirectProxy } from '../pac/types';
import { Logger } from '../logger';
type Socket = net.Socket;

export class ProxyHTTPHandler {
  private readonly httpClient: http.Agent;
  private readonly nonProxyHandler: http.RequestListener;
  private readonly logger: Logger;

  constructor(
    private readonly proxyFinder: ProxyFinder,
    private readonly proxySelector: ProxySelector,
    nonProxyHandler?: http.RequestListener,
    private readonly verbose: boolean = false,
    private readonly extLogger?: Logger,
  ) {
    this.logger = extLogger ?? new Logger(verbose);
    this.httpClient = new http.Agent({
      keepAlive: true,
      maxSockets: 50,
      maxFreeSockets: 20,
      timeout: 60000,
    });
    this.nonProxyHandler = nonProxyHandler ?? defaultNonProxyHandler;
  }

  createServer(): http.Server {
    const server = http.createServer((req, res) => {
      this.handleHTTP(req, res).catch((err) => {
        this.logger.error('HTTP request failed:', err);
        if (!res.headersSent) {
          res.writeHead(502);
          res.end('Bad Gateway');
        }
      });
    });

    server.on('connect', (req, clientSocket, head) => {
      this.handleConnect(req, clientSocket as Socket, head).catch((err) => {
        this.logger.error('CONNECT tunnel failed:', err);
        clientSocket.destroy();
      });
    });

    return server;
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === 'CONNECT') {
      throw new Error('CONNECT should be handled at server level');
    }
    await this.handleHTTP(req, res);
  }

  private async handleHTTP(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.url && req.url.startsWith('http')) {
      const reqId = this.logger.nextRequestId();
      const reqLogger = this.logger.withRequestId(reqId);
      const startTime = Date.now();

      try {
        const proxyUrl = await this.lookupProxy(req);
        const targetUrl = new URL(req.url);
        const proxy = proxyUrl ? `${proxyUrl.hostname}:${proxyUrl.port}` : 'DIRECT';

        reqLogger.proxyResolution(req.method || 'GET', targetUrl.host, targetUrl.pathname, proxy);
        await this.doHTTPProxy(req, res);

        const duration = Date.now() - startTime;
        reqLogger.debug(`${req.method} ${targetUrl.host}${targetUrl.pathname} completed in ${duration}ms via ${proxy}`);
      } catch (err: any) {
        const duration = Date.now() - startTime;
        reqLogger.error(`${req.method} ${req.url} failed after ${duration}ms:`, err);
        throw err;
      }
    } else if (this.nonProxyHandler) {
      this.logger.info(`${req.method} ${req.url} (non-proxy)`);
      this.nonProxyHandler(req, res);
    } else {
      this.logger.warn('Non-proxy request rejected:', req.method, req.url);
      res.writeHead(400);
      res.end();
    }
  }

  private async handleConnect(req: http.IncomingMessage, clientSocket: Socket, head: Buffer): Promise<void> {
    let serverConn: net.Socket | null = null;
    const reqId = this.logger.nextRequestId();
    const reqLogger = this.logger.withRequestId(reqId);
    const startTime = Date.now();

    try {
      const proxyUrl = await this.lookupProxy(req);
      const proxy = proxyUrl ? `${proxyUrl.hostname}:${proxyUrl.port}` : 'DIRECT';
      reqLogger.connectTunnel(req.url || 'unknown', proxy);

      const targetHostPort = req.url!;
      const colonIdx = targetHostPort.lastIndexOf(':');
      const targetHost = proxyUrl ? proxyUrl.hostname : targetHostPort.substring(0, colonIdx);
      const targetPort = proxyUrl
        ? parseInt(proxyUrl.port, 10) || 443
        : parseInt(targetHostPort.substring(colonIdx + 1), 10) || 443;

      serverConn = await tcpConnect(targetHost, targetPort);
      reqLogger.debug(`TCP connection established to ${targetHost}:${targetPort}`);

      if (proxyUrl) {
        const connectReqLines = [`CONNECT ${req.url} HTTP/1.1`, `Host: ${req.url}`];
        if (proxyUrl.username) {
          const auth = Buffer.from(`${proxyUrl.username}:${proxyUrl.password || ''}`).toString('base64');
          connectReqLines.push(`Proxy-Authorization: Basic ${auth}`);
          reqLogger.debug('Sending Proxy-Authorization for upstream proxy');
        }
        connectReqLines.push('', '');
        serverConn.write(connectReqLines.join('\r\n'));
      } else {
        clientSocket.write('HTTP/1.0 200 OK\r\n\r\n');
        if (head.length > 0) {
          serverConn.write(head);
        }
      }

      serverConn.pipe(clientSocket);
      clientSocket.pipe(serverConn);

      const cleanup = () => {
        if (serverConn && !serverConn.destroyed) serverConn.destroy();
        if (!clientSocket.destroyed) clientSocket.destroy();
        const duration = Date.now() - startTime;
        reqLogger.debug(`CONNECT tunnel ${req.url} closed after ${duration}ms`);
      };

      serverConn.on('close', cleanup);
      clientSocket.on('close', cleanup);
      serverConn.on('error', cleanup);
      clientSocket.on('error', cleanup);
    } catch (err: any) {
      const duration = Date.now() - startTime;
      reqLogger.error(`CONNECT ${req.url} failed after ${duration}ms:`, err);
      if (serverConn) serverConn.destroy();
      try {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      } catch { /* ignore */ }
      clientSocket.destroy();
    }
  }

  private async lookupProxy(req: http.IncomingMessage): Promise<URL | null> {
    const urlStr = req.url!;
    const fullUrl = urlStr.startsWith('http') ? urlStr : `http://${urlStr}`;
    const targetUrl = new URL(fullUrl);
    const proxies = await this.proxyFinder.findProxyForURL(targetUrl);
    const proxy = this.proxySelector.selectProxy(proxies);

    if (proxy.hostname === '' && proxy.port === 0) {
      return null;
    }

    const proxyUrl = new URL(`http://${proxy.hostname}:${proxy.port}`);
    // Auth from PAC file takes priority; client request header can supplement
    if (proxy.username) {
      proxyUrl.username = proxy.username;
      if (proxy.password) {
        proxyUrl.password = proxy.password;
      }
    }
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

  private async doHTTPProxy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    removeProxyHeaders(req);

    const targetUrl = new URL(req.url!);
    const options: http.RequestOptions = {
      hostname: targetUrl.hostname,
      port: parseInt(targetUrl.port, 10) || 80,
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers: req.headers,
      agent: this.httpClient,
    };

    const headers = options.headers as Record<string, any>;
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

function tcpConnect(host: string, port: number): Promise<net.Socket> {
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

function removeProxyHeaders(req: http.IncomingMessage): void {
  delete req.headers['accept-encoding'];
  delete req.headers['proxy-connection'];
  delete req.headers['connection'];
}

function copyHeaders(dst: http.ServerResponse, src: http.OutgoingHttpHeaders): void {
  for (const [key, value] of Object.entries(src)) {
    if (value !== undefined) {
      if (Array.isArray(value)) {
        value.forEach(v => dst.setHeader(key, v));
      } else {
        dst.setHeader(key, value);
      }
    }
  }
}

function parseBasicAuth(auth: string): { username: string; password: string } | null {
  const prefix = 'Basic ';
  if (!auth.startsWith(prefix)) return null;
  try {
    const decoded = Buffer.from(auth.substring(prefix.length), 'base64').toString('utf-8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx < 0) return null;
    return {
      username: decoded.substring(0, colonIdx),
      password: decoded.substring(colonIdx + 1),
    };
  } catch {
    return null;
  }
}

function defaultNonProxyHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(502);
  res.end(`pacproxy v2.0.7\nhttps://github.com/williambailey/pacproxy`);
}
