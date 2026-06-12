import * as http from 'http';
import * as net from 'net';
import { URL } from 'url';
import { ProxyFinder, ProxySelector, Proxies, Proxy, ProxyType, DirectProxy, isDirectProxy } from '../pac/types';
import { Logger } from '../logger';
import { TcpConnectionPool } from './connection-pool';
import { socks5Connect } from './socks5-protocol';
import { socks4Connect } from './socks4-protocol';
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

/**
 * Perform HTTP CONNECT handshake on an established TCP connection.
 */
async function httpConnect(
  socket: net.Socket,
  target: string,
  username?: string,
  password?: string,
): Promise<boolean> {
  const lines = [
    `CONNECT ${target} HTTP/1.1`,
    `Host: ${target}`,
  ];
  if (username) {
    const auth = Buffer.from(`${username}:${password || ''}`).toString('base64');
    lines.push(`Proxy-Authorization: Basic ${auth}`);
  }
  lines.push('', '');
  socket.write(lines.join('\r\n'));
  return readConnectResponse(socket);
}

/**
 * Extended URL with proxy type information attached.
 * Avoids breaking the existing URL-based interface while carrying type.
 */
interface ProxyURL extends URL {
  proxyType: ProxyType;
}

/**
 * Convert a Proxy object to a ProxyURL (or null for DIRECT).
 */
function proxyToURL(proxy: Proxy, req: http.IncomingMessage): ProxyURL | null {
  if (isDirectProxy(proxy)) {
    return null;
  }

  const proxyUrl = new URL(`http://${proxy.hostname}:${proxy.port}`) as ProxyURL;
  proxyUrl.proxyType = proxy.type;

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

/**
 * Error class for proxy failures that should trigger fallback retry.
 * Connection errors, timeout, and non-2xx CONNECT responses are retryable.
 */
export class ProxyFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyFailureError';
  }
}

export class ProxyHTTPHandler {
  private readonly httpClient: http.Agent;
  private readonly nonProxyHandler: http.RequestListener;
  private readonly logger: Logger;
  private readonly connPool: TcpConnectionPool;
  private readonly fallback: boolean;

  constructor(
    private readonly proxyFinder: ProxyFinder,
    private readonly proxySelector: ProxySelector,
    nonProxyHandler?: http.RequestListener,
    private readonly verbose: boolean = false,
    private readonly extLogger?: Logger,
    fallback: boolean = false,
  ) {
    this.logger = extLogger ?? new Logger(verbose);
    this.connPool = new TcpConnectionPool({}, this.logger);
    this.fallback = fallback;
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
        const targetUrl = new URL(req.url);
        const proxies = await this.proxyFinder.findProxyForURL(targetUrl);

        if (this.fallback && proxies.length > 1) {
          // Fallback mode: try each proxy in order
          await this.doHTTPProxyWithFallback(req, res, proxies, reqLogger);
        } else {
          // Single-proxy mode (no fallback or only one proxy)
          const proxyUrl = this.lookupProxyFromList(req, proxies);
          const proxy = proxyUrl ? `${proxyUrl.hostname}:${proxyUrl.port}` : 'DIRECT';
          reqLogger.proxyResolution(req.method || 'GET', targetUrl.host, targetUrl.pathname, proxy);
          await this.doHTTPProxy(req, res, proxyUrl);
        }

        const duration = Date.now() - startTime;
        reqLogger.debug(`${req.method} ${targetUrl.host}${targetUrl.pathname} completed in ${duration}ms`);
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

  /**
   * Try each proxy in the PAC chain for HTTP requests.
   * On connection error (ECONNREFUSED, ETIMEDOUT, etc.), move to the next proxy.
   * Always buffers the request body first to enable replay on retry.
   */
  private async doHTTPProxyWithFallback(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    proxies: Proxies,
    reqLogger: Logger,
  ): Promise<void> {
    const proxyList = proxies.toArray();
    let lastError: Error | null = null;

    // Always buffer the request body upfront for potential retry.
    const bodyBuffer = await bufferRequest(req);

    for (let i = 0; i < proxyList.length; i++) {
      const proxyUrl = proxyToURL(proxyList[i], req);
      const proxy = proxyUrl ? `${proxyUrl.hostname}:${proxyUrl.port}` : 'DIRECT';
      const targetUrl = new URL(req.url!);
      reqLogger.proxyResolution(req.method || 'GET', targetUrl.host, targetUrl.pathname, proxy);

      try {
        await this.doHTTPProxyRetry(res, proxyUrl, req, bodyBuffer);
        return;
      } catch (err: any) {
        if (isRetryableHTTPError(err) && i < proxyList.length - 1) {
          reqLogger.warn(`Proxy ${proxy} failed for ${req.url}: ${err.message}, trying next...`);
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    throw lastError;
  }

  /**
   * Retry attempt: replay cached body buffer to the proxy.
   * Rejects on connection error OR 5xx response from the upstream proxy
   * (5xx indicates the proxy is alive but can't fulfill the request, which is also fallback-worthy).
   */
  private doHTTPProxyRetry(
    res: http.ServerResponse,
    proxyUrl: ProxyURL | null,
    origReq: http.IncomingMessage,
    bodyBuffer: Buffer,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const options = this.buildHTTPOptions(origReq, proxyUrl);

      const proxyReq = http.request(options, (proxyRes) => {
        const statusCode = proxyRes.statusCode || 0;
        if (statusCode >= 500 && statusCode < 600) {
          // Upstream proxy returned 5xx — consume the response body and reject
          // so the fallback loop can try the next proxy.
          const chunks: Buffer[] = [];
          proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
          proxyRes.on('end', () => {
            const err: any = new Error(`Upstream returned ${statusCode}`);
            err.code = 'EUPSTREAM5XX';
            err.statusCode = statusCode;
            reject(err);
          });
          return;
        }

        this.forwardResponse(res, proxyRes);
        proxyRes.on('end', resolve);
        proxyRes.on('error', reject);
      });

      proxyReq.on('error', (err: any) => {
        if (!res.headersSent) {
          reject(err);
        } else {
          res.end();
          reject(err);
        }
      });

      if (bodyBuffer.length > 0) {
        proxyReq.write(bodyBuffer);
      }
      proxyReq.end();
    });
  }

  /**
   * Build http.RequestOptions for the given request and proxy URL.
   */
  private buildHTTPOptions(req: http.IncomingMessage, proxyUrl?: ProxyURL | null): http.RequestOptions {
    removeProxyHeaders(req);
    const targetUrl = new URL(req.url!);

    let options: http.RequestOptions;
    if (proxyUrl) {
      const proxyType = proxyUrl.proxyType;
      if (proxyType === 'socks5' || proxyType === 'socks4') {
        // For SOCKS in fallback mode, fall through to HTTP handling
        // (SOCKS fallback for HTTP is a future enhancement)
      }

      options = {
        hostname: proxyUrl.hostname,
        port: parseInt(proxyUrl.port, 10) || 3128,
        path: req.url,
        method: req.method,
        headers: { ...req.headers },
        agent: this.httpClient,
      };

      if (proxyUrl.username) {
        const auth = Buffer.from(`${proxyUrl.username}:${proxyUrl.password || ''}`).toString('base64');
        const headers = options.headers as Record<string, string | string[]>;
        headers['proxy-authorization'] = `Basic ${auth}`;
      }
    } else {
      options = {
        hostname: targetUrl.hostname,
        port: parseInt(targetUrl.port, 10) || 80,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: { ...req.headers },
        agent: this.httpClient,
      };
    }

    const headers = options.headers as Record<string, any>;
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];

    return options;
  }

  /**
   * Forward the upstream response to the client response.
   */
  private forwardResponse(res: http.ServerResponse, proxyRes: http.IncomingMessage): void {
    for (const key of res.getHeaderNames()) {
      res.removeHeader(key);
    }
    copyHeaders(res, proxyRes.headers);
    res.writeHead(proxyRes.statusCode || 200);
    proxyRes.pipe(res);
  }

  private async handleConnect(req: http.IncomingMessage, clientSocket: Socket, head: Buffer): Promise<void> {
    let serverConn: net.Socket | null = null;
    const reqId = this.logger.nextRequestId();
    const reqLogger = this.logger.withRequestId(reqId);
    const startTime = Date.now();

    const targetHostPort = req.url!;
    const colonIdx = targetHostPort.lastIndexOf(':');
    const targetHost = targetHostPort.substring(0, colonIdx);
    const targetPort = parseInt(targetHostPort.substring(colonIdx + 1), 10) || 443;

    try {
      const proxies = await this.proxyFinder.findProxyForURL(new URL(`http://${req.url}`));

      if (this.fallback && proxies.length > 1) {
        // Fallback mode: try each proxy in order for CONNECT
        const result = await this.doConnectWithFallback(req, clientSocket, head, proxies, reqLogger, targetHost, targetPort);
        serverConn = result;
      } else {
        // Single-proxy mode
        const proxyUrl = this.lookupProxyFromList(req, proxies);
        const proxy = proxyUrl ? `${proxyUrl.hostname}:${proxyUrl.port}` : 'DIRECT';
        reqLogger.connectTunnel(req.url || 'unknown', proxy);
        serverConn = await this.doConnectProxy(proxyUrl, req.url!, clientSocket, head, reqLogger, targetHost, targetPort);
      }

      // Tunnel established — set up bidirectional pipe
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) {
        serverConn.write(head);
      }

      // 先注册 error/close handler，再建立管道，避免竞态导致 unhandled error
      const cleanup = () => {
        if (serverConn && !serverConn.destroyed) serverConn.destroy();
        if (!clientSocket.destroyed) clientSocket.destroy();
        const duration = Date.now() - startTime;
        reqLogger.debug(`CONNECT tunnel ${req.url} closed after ${duration}ms`);
      };

      serverConn!.on('error', cleanup);
      clientSocket.on('error', cleanup);
      serverConn!.on('close', cleanup);
      clientSocket.on('close', cleanup);

      serverConn!.pipe(clientSocket);
      clientSocket.pipe(serverConn!);
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

  /**
   * Try each proxy in the PAC chain for CONNECT tunnels.
   * On proxy rejection (non-2xx) or connection error, try the next proxy.
   * Returns the established server connection on success.
   */
  private async doConnectWithFallback(
    req: http.IncomingMessage,
    clientSocket: Socket,
    head: Buffer,
    proxies: Proxies,
    reqLogger: Logger,
    targetHost: string,
    targetPort: number,
  ): Promise<net.Socket> {
    const proxyList = proxies.toArray();
    let lastError: Error | null = null;

    for (let i = 0; i < proxyList.length; i++) {
      const proxyUrl = proxyToURL(proxyList[i], req);
      const proxy = proxyUrl ? `${proxyUrl.hostname}:${proxyUrl.port}` : 'DIRECT';
      reqLogger.connectTunnel(req.url || 'unknown', proxy);

      try {
        return await this.doConnectProxy(proxyUrl, req.url!, clientSocket, head, reqLogger, targetHost, targetPort);
      } catch (err: any) {
        if (i < proxyList.length - 1) {
          // More proxies to try
          reqLogger.warn(`CONNECT proxy ${proxy} failed for ${req.url}: ${err.message}, trying next...`);
          lastError = err;
          continue;
        }
        // Last proxy — rethrow
        throw err;
      }
    }

    throw lastError ?? new Error('All proxies failed');
  }

  /**
   * Attempt a single CONNECT through a proxy (or DIRECT).
   * Returns the server connection on success, throws on failure.
   */
  private async doConnectProxy(
    proxyUrl: ProxyURL | null,
    target: string,
    _clientSocket: Socket,
    _head: Buffer,
    reqLogger: Logger,
    targetHost: string,
    targetPort: number,
  ): Promise<net.Socket> {
    let serverConn: net.Socket | null = null;

    if (proxyUrl) {
      const proxyHost = proxyUrl.hostname;
      const proxyPort = parseInt(proxyUrl.port, 10) || 3128;
      const proxyType = proxyUrl.proxyType;
      const username = proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined;
      const password = proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined;

      serverConn = await this.connPool.acquire(proxyHost, proxyPort);
      reqLogger.debug(`Acquired TCP connection to upstream proxy ${proxyHost}:${proxyPort} (type=${proxyType})`);

      let success: boolean;
      switch (proxyType) {
        case 'socks5':
          success = await socks5Connect(serverConn, targetHost, targetPort, username, password);
          break;
        case 'socks4':
          success = await socks4Connect(serverConn, targetHost, targetPort, username);
          break;
        case 'http':
        default:
          success = await httpConnect(serverConn, target, username, password);
          break;
      }

      if (!success) {
        serverConn.destroy();
        reqLogger.warn(`Upstream proxy rejected CONNECT for ${target}`);
        throw new ProxyFailureError(`Upstream proxy ${proxyHost}:${proxyPort} rejected CONNECT for ${target}`);
      }

      reqLogger.debug('Upstream proxy granted CONNECT tunnel');
    } else {
      // Direct connection
      serverConn = await tcpConnect(targetHost, targetPort);
      reqLogger.debug(`TCP connection established to target ${targetHost}:${targetPort}`);
    }

    return serverConn;
  }

  /**
   * Look up a single proxy from the Proxies list using the selector.
   * Used in non-fallback mode.
   */
  private lookupProxyFromList(req: http.IncomingMessage, proxies: Proxies): ProxyURL | null {
    const proxy = this.proxySelector.selectProxy(proxies);
    return proxyToURL(proxy, req);
  }

  /**
   * Legacy lookup method — selects a single proxy via selector + auth resolution.
   * Used in non-fallback mode.
   */
  private async lookupProxy(req: http.IncomingMessage): Promise<ProxyURL | null> {
    const urlStr = req.url!;
    const fullUrl = urlStr.startsWith('http') ? urlStr : `http://${urlStr}`;
    const targetUrl = new URL(fullUrl);
    const proxies = await this.proxyFinder.findProxyForURL(targetUrl);
    return this.lookupProxyFromList(req, proxies);
  }

  private async doHTTPProxy(req: http.IncomingMessage, res: http.ServerResponse, proxyUrl?: ProxyURL | null): Promise<void> {
    removeProxyHeaders(req);

    const targetUrl = new URL(req.url!);

    let options: http.RequestOptions;

    if (proxyUrl) {
      const proxyType = proxyUrl.proxyType;
      const username = proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined;
      const password = proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined;

      if (proxyType === 'socks5' || proxyType === 'socks4') {
        // SOCKS: first establish tunnel, then send HTTP over it
        await this.doHTTPProxyViaSocks(req, res, proxyUrl, targetUrl, username, password);
        return;
      }

      // HTTP proxy: send request to proxy with full URL as path
      options = {
        hostname: proxyUrl.hostname,
        port: parseInt(proxyUrl.port, 10) || 3128,
        path: req.url,
        method: req.method,
        headers: req.headers,
        agent: this.httpClient,
      };

      if (proxyUrl.username) {
        const auth = Buffer.from(`${proxyUrl.username}:${proxyUrl.password || ''}`).toString('base64');
        const headers = options.headers as Record<string, string | string[]>;
        headers['proxy-authorization'] = `Basic ${auth}`;
      }
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

  /**
   * Send HTTP request over a SOCKS5 tunnel.
   * Establishes SOCKS5 CONNECT to the target, then uses http.request
   * with createConnection to reuse the tunnel socket.
   */
  private async doHTTPProxyViaSocks(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    proxyUrl: ProxyURL,
    targetUrl: URL,
    username?: string,
    password?: string,
  ): Promise<void> {
    const proxyHost = proxyUrl.hostname;
    const proxyPort = parseInt(proxyUrl.port, 10) || 1080;
    const targetHost = targetUrl.hostname;
    const targetPort = parseInt(targetUrl.port, 10) || 80;
    const proxyType = proxyUrl.proxyType;

    const serverConn = await this.connPool.acquire(proxyHost, proxyPort);

    try {
      if (proxyType === 'socks5') {
        await socks5Connect(serverConn, targetHost, targetPort, username, password);
      } else {
        await socks4Connect(serverConn, targetHost, targetPort, username);
      }
    } catch (err: any) {
      serverConn.destroy();
      throw err;
    }

    // Tunnel established — now send HTTP request over it
    const options: http.RequestOptions = {
      hostname: targetUrl.hostname,
      port: targetPort,
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers: { ...req.headers },
      createConnection: () => serverConn,
    };

    // Remove hop-by-hop headers
    const headers = options.headers as Record<string, any>;
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    delete headers['connection'];

    const proxyReq = http.request(options, (proxyRes) => {
      for (const key of res.getHeaderNames()) {
        res.removeHeader(key);
      }
      copyHeaders(res, proxyRes.headers);
      res.writeHead(proxyRes.statusCode || 200);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      if (serverConn && !serverConn.destroyed) serverConn.destroy();
      if (!res.headersSent) {
        res.writeHead(502);
        res.end(err.message || 'Bad Gateway');
      }
    });

    req.pipe(proxyReq);
  }
}

/**
 * Buffer the entire request body into a single Buffer.
 * Used in fallback mode to enable replaying the request on proxy retry.
 */
function bufferRequest(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Determine if an HTTP proxy error is retryable (should trigger fallback).
 * Connection refused, timeout, and reset errors are retryable.
 * Errors after headers are already sent to the client are NOT retryable.
 */
function isRetryableHTTPError(err: Error): boolean {
  const code = (err as any).code;
  // Node.js connection error codes
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EAI_AGAIN'].includes(code)) {
    return true;
  }
  // ProxyFailureError (from CONNECT rejection)
  if (err instanceof ProxyFailureError) {
    return true;
  }
  // Upstream proxy returned 5xx
  if (code === 'EUPSTREAM5XX') {
    return true;
  }
  return false;
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
