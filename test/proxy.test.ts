import * as http from 'http';
import * as net from 'net';
import { OttoEngine } from '../src/pac/engine';
import { FirstItemSelector } from '../src/pac/selector';
import { ProxyHTTPHandler } from '../src/proxy/handler';

class DirectProxyFinder {
  async findProxyForURL(): Promise<any> {
    const { Proxies, DirectProxy } = await import('../src/pac/types');
    return new Proxies([DirectProxy]);
  }
}

class FixedProxyFinder {
  constructor(private proxy: { hostname: string; port: number }) {}
  async findProxyForURL(): Promise<any> {
    const { Proxies } = await import('../src/pac/types');
    return new Proxies([this.proxy]);
  }
}

function createTestHandler(finder: { findProxyForURL(url: URL): Promise<any> }): ProxyHTTPHandler {
  const selector = new FirstItemSelector();
  return new ProxyHTTPHandler(finder as any, selector);
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('ProxyHTTPHandler', () => {
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

  it('should forward HTTP requests directly', async () => {
    const handler = createTestHandler(new DirectProxyFinder());
    const proxyServer = handler.createServer();
    await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
    const proxyAddr = proxyServer.address() as net.AddressInfo;

    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${targetPort}/`, {
        hostname: '127.0.0.1',
        port: proxyAddr.port,
        path: `http://127.0.0.1:${targetPort}/`,
      }, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => body += chunk.toString());
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      });
      req.on('error', reject);
      req.end();
    });

    await closeServer(proxyServer);
    expect(response.status).toBe(200);
    expect(response.body).toBe('hello');
  });

  it('should strip hop-by-hop headers', async () => {
    let receivedHeaders: http.IncomingHttpHeaders = {};
    const headerCheckServer = http.createServer((req, res) => {
      receivedHeaders = { ...req.headers };
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>(resolve => headerCheckServer.listen(0, '127.0.0.1', resolve));

    const handler = createTestHandler(new DirectProxyFinder());
    const proxyServer = handler.createServer();
    await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
    const proxyAddr = proxyServer.address() as net.AddressInfo;

    await new Promise<void>((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${targetPort}/`, {
        hostname: '127.0.0.1',
        port: proxyAddr.port,
        path: `http://127.0.0.1:${targetPort}/`,
        headers: {
          'Proxy-Connection': 'keep-alive',
          'Connection': 'keep-alive',
        },
      }, (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });

    await closeServer(proxyServer);
    await closeServer(headerCheckServer);
    expect(receivedHeaders['proxy-connection']).toBeUndefined();
    expect(receivedHeaders['connection']).toBeUndefined();
  });

  it('should return 502 for CONNECT dial failure', async () => {
    const handler = createTestHandler(new DirectProxyFinder());
    const proxyServer = handler.createServer();
    await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
    const proxyAddr = proxyServer.address() as net.AddressInfo;

    const response = await new Promise<{ body: string }>((resolve) => {
      const socket = net.connect(proxyAddr.port, '127.0.0.1', () => {
        socket.write('CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n');
      });
      let data = '';
      socket.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      socket.on('close', () => resolve({ body: data }));
      socket.on('error', () => resolve({ body: data }));
      setTimeout(() => socket.destroy(), 2000);
    });

    await closeServer(proxyServer);
    expect(response.body).toContain('502');
  });

  it('should handle CONNECT tunnel directly', async () => {
    const handler = createTestHandler(new DirectProxyFinder());
    const proxyServer = handler.createServer();
    await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
    const proxyAddr = proxyServer.address() as net.AddressInfo;

    const response = await new Promise<{ body: string }>((resolve) => {
      const socket = net.connect(proxyAddr.port, '127.0.0.1', () => {
        const connectReq = `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`;
        socket.write(connectReq);
      });
      let data = '';
      let connected = false;
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString();
        if (!connected && data.includes('\r\n\r\n')) {
          connected = true;
          socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
        } else if (connected && data.includes('hello')) {
          resolve({ body: data });
        }
      });
      socket.on('error', () => resolve({ body: data }));
      setTimeout(() => {
        socket.destroy();
        resolve({ body: data });
      }, 5000);
    });

    await closeServer(proxyServer);
    expect(response.body).toContain('hello');
  }, 10000);
});
