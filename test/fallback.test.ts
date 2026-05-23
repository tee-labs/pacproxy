import * as http from 'http';
import * as net from 'net';
import { ProxyHTTPHandler } from '../src/proxy/handler';
import { Proxies, Proxy, DirectProxy } from '../src/pac/types';
import { FirstItemSelector } from '../src/pac/selector';

/**
 * A ProxyFinder that returns a chain of proxies for fallback testing.
 */
class ChainProxyFinder {
  constructor(private proxies: Proxy[]) {}
  async findProxyForURL(): Promise<Proxies> {
    return new Proxies(this.proxies);
  }
}

/**
 * Create a handler with fallback enabled or disabled.
 */
function createHandler(finder: { findProxyForURL(url: URL): Promise<Proxies> }, fallback: boolean): ProxyHTTPHandler {
  const selector = new FirstItemSelector();
  return new ProxyHTTPHandler(finder as any, selector, undefined, true, undefined, fallback);
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Helper: send an HTTP GET through the pacproxy to a target URL.
 * Uses http.request with explicit proxy host/port (not http.get which follows redirects).
 */
function httpGetViaProxy(proxyPort: number, targetUrl: string, timeout = 5000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const req = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: targetUrl,
      method: 'GET',
      headers: {
        Host: parsed.host,
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

/**
 * Helper: send a CONNECT request through the proxy and collect the response.
 */
function connectViaProxy(proxyPort: number, target: string): Promise<{ statusLine: string; body: string }> {
  return new Promise((resolve) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let data = '';
    let resolved = false;
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString();
      if (!resolved && data.includes('\r\n\r\n')) {
        const statusLine = data.split('\r\n')[0];
        if (statusLine.includes('200')) {
          socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
        } else {
          resolved = true;
          resolve({ statusLine, body: data });
          socket.destroy();
        }
      }
      if (!resolved && data.includes('hello')) {
        resolved = true;
        resolve({ statusLine: data.split('\r\n')[0], body: data });
        socket.destroy();
      }
    });
    socket.on('error', () => {
      if (!resolved) {
        resolved = true;
        resolve({ statusLine: '', body: data });
      }
    });
    socket.on('close', () => {
      if (!resolved) {
        resolved = true;
        resolve({ statusLine: '', body: data });
      }
    });
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ statusLine: '', body: data });
      }
      socket.destroy();
    }, 5000);
  });
}

describe('Fallback chain', () => {
  let targetServer: http.Server;
  let targetPort: number;

  beforeAll((done) => {
    targetServer = http.createServer((req, res) => {
      res.writeHead(200);
      res.end('hello');
    });
    targetServer.listen(0, '127.0.0.1', () => {
      targetPort = (targetServer.address() as net.AddressInfo).port;
      done();
    });
  });

  afterAll((done) => {
    targetServer.close(done);
  });

  describe('CONNECT tunnel fallback', () => {
    it('should fall back to second proxy when first proxy rejects CONNECT', async () => {
      // First upstream proxy: rejects all CONNECT requests
      const badProxy = http.createServer();
      await new Promise<void>((resolve) => badProxy.listen(0, '127.0.0.1', resolve));
      const badPort = (badProxy.address() as net.AddressInfo).port;
      badProxy.on('connect', (_req, clientSocket) => {
        clientSocket.write('HTTP/1.1 407 Proxy Auth Required\r\n\r\n');
        clientSocket.destroy();
      });

      // Second upstream proxy: accepts CONNECT and tunnels to target
      const goodProxy = http.createServer();
      await new Promise<void>((resolve) => goodProxy.listen(0, '127.0.0.1', resolve));
      const goodPort = (goodProxy.address() as net.AddressInfo).port;
      goodProxy.on('connect', (_req, clientSocket, head) => {
        const targetSocket = net.connect(targetPort, '127.0.0.1', () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length > 0) targetSocket.write(head);
          targetSocket.pipe(clientSocket);
          clientSocket.pipe(targetSocket);
        });
        targetSocket.on('error', () => {
          clientSocket.destroy();
          targetSocket.destroy();
        });
      });

      const handler = createHandler(
        new ChainProxyFinder([
          { type: 'http', hostname: '127.0.0.1', port: badPort },
          { type: 'http', hostname: '127.0.0.1', port: goodPort },
        ]),
        true,
      );
      const proxyServer = handler.createServer();
      await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
      const proxyAddr = proxyServer.address() as net.AddressInfo;

      const response = await connectViaProxy(proxyAddr.port, `127.0.0.1:${targetPort}`);

      await closeServer(proxyServer);
      await closeServer(badProxy);
      await closeServer(goodProxy);

      expect(response.statusLine).toContain('200');
      expect(response.body).toContain('hello');
    }, 10000);

    it('should fall back to DIRECT when all proxies reject CONNECT', async () => {
      const badProxy = http.createServer();
      await new Promise<void>((resolve) => badProxy.listen(0, '127.0.0.1', resolve));
      const badPort = (badProxy.address() as net.AddressInfo).port;
      badProxy.on('connect', (_req, clientSocket) => {
        clientSocket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        clientSocket.destroy();
      });

      const handler = createHandler(
        new ChainProxyFinder([
          { type: 'http', hostname: '127.0.0.1', port: badPort },
          DirectProxy,
        ]),
        true,
      );
      const proxyServer = handler.createServer();
      await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
      const proxyAddr = proxyServer.address() as net.AddressInfo;

      const response = await connectViaProxy(proxyAddr.port, `127.0.0.1:${targetPort}`);

      await closeServer(proxyServer);
      await closeServer(badProxy);

      expect(response.statusLine).toContain('200');
      expect(response.body).toContain('hello');
    }, 10000);

    it('should NOT fall back when fallback is disabled', async () => {
      const badProxy = http.createServer();
      await new Promise<void>((resolve) => badProxy.listen(0, '127.0.0.1', resolve));
      const badPort = (badProxy.address() as net.AddressInfo).port;
      badProxy.on('connect', (_req, clientSocket) => {
        clientSocket.write('HTTP/1.1 407 Proxy Auth Required\r\n\r\n');
        clientSocket.destroy();
      });

      const goodProxy = http.createServer();
      await new Promise<void>((resolve) => goodProxy.listen(0, '127.0.0.1', resolve));
      const goodPort = (goodProxy.address() as net.AddressInfo).port;
      goodProxy.on('connect', (_req, clientSocket, head) => {
        const targetSocket = net.connect(targetPort, '127.0.0.1', () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length > 0) targetSocket.write(head);
          targetSocket.pipe(clientSocket);
          clientSocket.pipe(targetSocket);
        });
        targetSocket.on('error', () => {
          clientSocket.destroy();
          targetSocket.destroy();
        });
      });

      const handler = createHandler(
        new ChainProxyFinder([
          { type: 'http', hostname: '127.0.0.1', port: badPort },
          { type: 'http', hostname: '127.0.0.1', port: goodPort },
        ]),
        false,
      );
      const proxyServer = handler.createServer();
      await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
      const proxyAddr = proxyServer.address() as net.AddressInfo;

      const response = await connectViaProxy(proxyAddr.port, `127.0.0.1:${targetPort}`);

      await closeServer(proxyServer);
      await closeServer(badProxy);
      await closeServer(goodProxy);

      expect(response.statusLine).toContain('502');
    }, 10000);
  });

  describe('HTTP proxy fallback', () => {
    it('should fall back to second proxy when first proxy returns 502 for HTTP', async () => {
      // First proxy: accepts connection but returns 502 Bad Gateway
      // This simulates a broken proxy (not connection refused)
      const badProxy = http.createServer((req, res) => {
        res.writeHead(502);
        res.end('Bad Gateway');
      });
      await new Promise<void>((resolve) => badProxy.listen(0, '127.0.0.1', resolve));
      const badPort = (badProxy.address() as net.AddressInfo).port;

      // Second proxy: a working HTTP forward proxy
      const goodProxy = http.createServer((req, res) => {
        const targetUrl = new URL(req.url!);
        const proxyReq = http.request(
          {
            hostname: targetUrl.hostname,
            port: targetUrl.port || 80,
            path: targetUrl.pathname + targetUrl.search,
            method: req.method,
            headers: req.headers,
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 200);
            proxyRes.pipe(res);
          },
        );
        proxyReq.on('error', () => {
          res.writeHead(502);
          res.end('Bad Gateway');
        });
        req.pipe(proxyReq);
      });
      await new Promise<void>((resolve) => goodProxy.listen(0, '127.0.0.1', resolve));
      const goodPort = (goodProxy.address() as net.AddressInfo).port;

      const handler = createHandler(
        new ChainProxyFinder([
          { type: 'http', hostname: '127.0.0.1', port: badPort },
          { type: 'http', hostname: '127.0.0.1', port: goodPort },
        ]),
        true,
      );
      const proxyServer = handler.createServer();
      await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
      const proxyAddr = proxyServer.address() as net.AddressInfo;

      const response = await httpGetViaProxy(proxyAddr.port, `http://127.0.0.1:${targetPort}/`);

      await closeServer(proxyServer);
      await closeServer(badProxy);
      await closeServer(goodProxy);

      expect(response.status).toBe(200);
      expect(response.body).toBe('hello');
    }, 10000);

    it('should fall back to DIRECT when proxy returns 502 for HTTP', async () => {
      const badProxy = http.createServer((req, res) => {
        res.writeHead(502);
        res.end('Bad Gateway');
      });
      await new Promise<void>((resolve) => badProxy.listen(0, '127.0.0.1', resolve));
      const badPort = (badProxy.address() as net.AddressInfo).port;

      const handler = createHandler(
        new ChainProxyFinder([
          { type: 'http', hostname: '127.0.0.1', port: badPort },
          DirectProxy,
        ]),
        true,
      );
      const proxyServer = handler.createServer();
      await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
      const proxyAddr = proxyServer.address() as net.AddressInfo;

      const response = await httpGetViaProxy(proxyAddr.port, `http://127.0.0.1:${targetPort}/`);

      await closeServer(proxyServer);
      await closeServer(badProxy);

      expect(response.status).toBe(200);
      expect(response.body).toBe('hello');
    }, 10000);

    it('should return 502 when all proxies in chain fail for HTTP', async () => {
      const badProxy1 = http.createServer((req, res) => {
        res.writeHead(502);
        res.end('Bad Gateway');
      });
      await new Promise<void>((resolve) => badProxy1.listen(0, '127.0.0.1', resolve));
      const badPort1 = (badProxy1.address() as net.AddressInfo).port;

      const badProxy2 = http.createServer((req, res) => {
        res.writeHead(503);
        res.end('Service Unavailable');
      });
      await new Promise<void>((resolve) => badProxy2.listen(0, '127.0.0.1', resolve));
      const badPort2 = (badProxy2.address() as net.AddressInfo).port;

      const handler = createHandler(
        new ChainProxyFinder([
          { type: 'http', hostname: '127.0.0.1', port: badPort1 },
          { type: 'http', hostname: '127.0.0.1', port: badPort2 },
        ]),
        true,
      );
      const proxyServer = handler.createServer();
      await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
      const proxyAddr = proxyServer.address() as net.AddressInfo;

      const response = await httpGetViaProxy(proxyAddr.port, `http://127.0.0.1:${targetPort}/`);

      await closeServer(proxyServer);
      await closeServer(badProxy1);
      await closeServer(badProxy2);

      expect(response.status).toBe(502);
    }, 10000);
  });
});
