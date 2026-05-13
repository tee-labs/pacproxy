import * as http from 'http';
import * as net from 'net';
import { URL } from 'url';
import { ProxyFinder, ProxySelector, Proxies, Proxy, DirectProxy } from '../pac/types';
import { Logger } from '../logger';
import { TcpConnectionPool } from './connection-pool';
type Socket = net.Socket;

/**
 * Read the HTTP status line + headers from a socket for a CONNECT response.
 * Resolves with true (2xx success) or false (non-2xx), or rejects on error/timeout.
 */
function readConnectResponse(socket: net.Socket, timeoutMs = 10000): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('CONNECT response timeout'));
    }, timeoutMs);

    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      cleanup();
      const statusLine = buf.substring(0, buf.indexOf('\r\n'));
      const statusCode = parseInt(statusLine.split(' ')[1], 10);
      resolve(statusCode >= 200 && statusCode < 300);
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onClose = () => {
      cleanup();
      reject(new Error('Connection closed before CONNECT response'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

export class ProxyHTTPHandler {
  private readonly httpClient: http.Agent;
  private readonly nonProxyHandler: http.RequestListener;
  private readonly logger: Logger;
  private readonly connPool: TcpConnectionPool;

  constructor(
    private readonly proxyFinder: ProxyFinder,
    private readonly proxySelector: ProxySelector,
    nonProxyHandler?: http.RequestListener,
    private readonly verbose: boolean = false,
    private readonly extLogger?: Logger,
  ) {
    this.logger = extLogger ?? new Logger(verbose);
    this.connPool = new TcpConnectionPool({}, this.logger);
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
        await this.doHTTPProxy(req, res, proxyUrl);

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

      if (proxyUrl) {
        // —— 走上游代理 ——
        const proxyHost = proxyUrl.hostname;
        const proxyPort = parseInt(proxyUrl.port, 10) || 3128;

        serverConn = await this.connPool.acquire(proxyHost, proxyPort);
        reqLogger.debug(`Acquired TCP connection to upstream proxy ${proxyHost}:${proxyPort}`);

        // 构建 CONNECT 请求
        const connectReqLines = [
          `CONNECT ${req.url} HTTP/1.1`,
          `Host: ${req.url}`,
        ];
        if (proxyUrl.username) {
          const auth = Buffer.from(`${proxyUrl.username}:${proxyUrl.password || ''}`).toString('base64');
          connectReqLines.push(`Proxy-Authorization: Basic ${auth}`);
          reqLogger.debug('Sending Proxy-Authorization for upstream proxy');
        }
        connectReqLines.push('', '');
        serverConn.write(connectReqLines.join('\r\n'));

        // 读取上游代理的 CONNECT 响应
        const success = await readConnectResponse(serverConn);
        if (!success) {
          // 非 2xx 响应 — 将连接放回池中，通知客户端失败
          this.connPool.release(proxyHost, proxyPort, serverConn);
          serverConn = null;
          reqLogger.warn(`Upstream proxy rejected CONNECT for ${req.url}`);
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          clientSocket.destroy();
          return;
        }

        // 2xx — 通知客户端隧道已建立，然后透传上游剩余数据
        reqLogger.debug('Upstream proxy granted CONNECT tunnel');
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) {
          serverConn.write(head);
        }
      } else {
        // —— 直连目标 ——
        const targetHost = targetHostPort.substring(0, colonIdx);
        const targetPort = parseInt(targetHostPort.substring(colonIdx + 1), 10) || 443;

        serverConn = await tcpConnect(targetHost, targetPort);
        reqLogger.debug(`TCP connection established to target ${targetHost}:${targetPort}`);

        clientSocket.write('HTTP/1.0 200 OK\r\n\r\n');
        if (head.length > 0) {
          serverConn.write(head);
        }
      }

      // 建立双向数据管道
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
    // Priority 1: PAC file auth (from proxy object)
    if (proxy.username) {
      proxyUrl.username = proxy.username;
      if (proxy.password) {
        proxyUrl.password = proxy.password;
      }
    }
    // Priority 2: Environment variable fallback
    else if (process.env.PROXY_USER) {
      proxyUrl.username = process.env.PROXY_USER;
      proxyUrl.password = process.env.PROXY_PASS || '';
    }
    // Priority 3: Client request header
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

  private async doHTTPProxy(req: http.IncomingMessage, res: http.ServerResponse, proxyUrl?: URL | null): Promise<void> {
    removeProxyHeaders(req);

    const targetUrl = new URL(req.url!);

    let options: http.RequestOptions;

    if (proxyUrl) {
      // 通过上游代理转发：请求发到代理，path 设完整 URL
      options = {
        hostname: proxyUrl.hostname,
        port: parseInt(proxyUrl.port, 10) || 3128,
        path: req.url,
        method: req.method,
        headers: req.headers,
        agent: this.httpClient,
      };
    } else {
      // 直连目标
      options = {
        hostname: targetUrl.hostname,
        port: parseInt(targetUrl.port, 10) || 80,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: req.headers,
        agent: this.httpClient,
      };
    }

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
    socket.setKeepAlive(true, 30000);
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
  delete req.headers['proxy-connection'];
  delete req.headers['connection'];
  // Note: accept-encoding is intentionally passed through to allow
  // compressed responses from the target server.
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
