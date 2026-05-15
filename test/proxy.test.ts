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
  constructor(private proxy: { hostname: string; port: number; username?: string; password?: string }) {}
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

  it('should send Proxy-Authorization to upstream proxy using auth from proxy object', async () => {
    // Mock upstream proxy that requires auth
    const upstreamServer = http.createServer();
    await new Promise<void>(resolve => upstreamServer.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstreamServer.address() as net.AddressInfo).port;

    // Use object wrapper to avoid TypeScript narrowing issue with closure-assigned variable
    const captured: { req: http.IncomingMessage | null } = { req: null };
    upstreamServer.on('connect', (req, clientSocket, head) => {
      captured.req = req;
      if (!req.headers['proxy-authorization']) {
        clientSocket.write('HTTP/1.1 407 Proxy Auth Required\r\nProxy-Authenticate: Basic\r\n\r\n');
        clientSocket.end();
        return;
      }
      const targetSocket = net.connect(targetPort, '127.0.0.1', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        targetSocket.write(head);
        targetSocket.pipe(clientSocket);
        clientSocket.pipe(targetSocket);
      });
      targetSocket.on('error', () => {
        clientSocket.destroy();
        targetSocket.destroy();
      });
    });

    // FixedProxyFinder returns a proxy with username/password (simulating PAC returning auth)
    const handler = createTestHandler(new FixedProxyFinder({
      hostname: '127.0.0.1',
      port: upstreamPort,
      username: 'testuser',
      password: 'testpass',
    }));
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
    await new Promise<void>(resolve => upstreamServer.close(() => resolve()));

    // Verify the upstream proxy received the Proxy-Authorization header
    expect(captured.req?.headers['proxy-authorization']).toBeDefined();
    const authHeader = captured.req?.headers['proxy-authorization'] as string;
    expect(authHeader).toMatch(/^Basic /);
    const decoded = Buffer.from(authHeader.substring(6), 'base64').toString();
    expect(decoded).toBe('testuser:testpass');
    expect(response.body).toContain('hello');
  }, 10000);

  it('should not return rejected CONNECT connection to pool', async () => {
    // Upstream proxy that rejects CONNECT but keeps TCP connection alive
    // (simulating enterprise proxies like proxysg.huawei.com:8080)
    const upstreamServer = http.createServer();
    await new Promise<void>(resolve => upstreamServer.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstreamServer.address() as net.AddressInfo).port;

    upstreamServer.on('connect', (_req, clientSocket) => {
      // Reject with 407 but DON'T close — keep TCP alive (like real enterprise proxy)
      clientSocket.write('HTTP/1.1 407 Proxy Auth Required\r\nProxy-Authenticate: Basic\r\n\r\n');
    });

    const handler = createTestHandler(new FixedProxyFinder({
      hostname: '127.0.0.1',
      port: upstreamPort,
    }));
    const proxyServer = handler.createServer();
    await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
    const proxyAddr = proxyServer.address() as net.AddressInfo;

    // Send CONNECT — should fail with 502
    await new Promise<void>((resolve) => {
      const socket = net.connect(proxyAddr.port, '127.0.0.1', () => {
        socket.write('CONNECT 127.0.0.1:9999 HTTP/1.1\r\nHost: 127.0.0.1:9999\r\n\r\n');
      });
      socket.on('data', () => {});
      socket.on('close', resolve);
      socket.on('error', resolve);
      setTimeout(() => { socket.destroy(); resolve(); }, 2000);
    });

    // The rejected TCP connection should NOT be in the pool
    expect((handler as any).connPool.idleCount).toBe(0);

    await closeServer(proxyServer);
    await new Promise<void>(resolve => {
      // Force close the upstream server (its socket may be lingering after serverConn.destroy())
      upstreamServer.close(() => resolve());
      setTimeout(resolve, 1000);
    });
  }, 10000);

  describe('env var auth fallback', () => {
    const ORIG_USER = process.env.PROXY_USER;
    const ORIG_PASS = process.env.PROXY_PASS;

    afterEach(() => {
      if (ORIG_USER === undefined) delete process.env.PROXY_USER;
      else process.env.PROXY_USER = ORIG_USER;
      if (ORIG_PASS === undefined) delete process.env.PROXY_PASS;
      else process.env.PROXY_PASS = ORIG_PASS;
    });

    it('should use PROXY_USER/PROXY_PASS env vars when proxy object has no auth', async () => {
      // Set env vars
      process.env.PROXY_USER = 'envuser';
      process.env.PROXY_PASS = 'envpass';

      // Mock upstream proxy that requires auth
      const upstreamServer = http.createServer();
      await new Promise<void>(resolve => upstreamServer.listen(0, '127.0.0.1', resolve));
      const upstreamPort = (upstreamServer.address() as net.AddressInfo).port;

      const captured: { req: http.IncomingMessage | null } = { req: null };
      upstreamServer.on('connect', (req, clientSocket, head) => {
        captured.req = req;
        if (!req.headers['proxy-authorization']) {
          clientSocket.write('HTTP/1.1 407 Proxy Auth Required\r\nProxy-Authenticate: Basic\r\n\r\n');
          clientSocket.end();
          return;
        }
        const targetSocket = net.connect(targetPort, '127.0.0.1', () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          targetSocket.write(head);
          targetSocket.pipe(clientSocket);
          clientSocket.pipe(targetSocket);
        });
        targetSocket.on('error', () => { clientSocket.destroy(); targetSocket.destroy(); });
      });

      // FixedProxyFinder with NO auth — env vars should fill in
      const handler = createTestHandler(new FixedProxyFinder({
        hostname: '127.0.0.1',
        port: upstreamPort,
      }));
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
        setTimeout(() => { socket.destroy(); resolve({ body: data }); }, 5000);
      });

      await closeServer(proxyServer);
      await new Promise<void>(resolve => upstreamServer.close(() => resolve()));

      expect(captured.req?.headers['proxy-authorization']).toBeDefined();
      const authHeader = captured.req?.headers['proxy-authorization'] as string;
      expect(authHeader).toMatch(/^Basic /);
      const decoded = Buffer.from(authHeader.substring(6), 'base64').toString();
      expect(decoded).toBe('envuser:envpass');
      expect(response.body).toContain('hello');
    }, 10000);

    it('should prefer PAC auth over env vars when both are present', async () => {
      process.env.PROXY_USER = 'envuser';
      process.env.PROXY_PASS = 'envpass';

      const upstreamServer = http.createServer();
      await new Promise<void>(resolve => upstreamServer.listen(0, '127.0.0.1', resolve));
      const upstreamPort = (upstreamServer.address() as net.AddressInfo).port;

      const captured: { req: http.IncomingMessage | null } = { req: null };
      upstreamServer.on('connect', (req, clientSocket, head) => {
        captured.req = req;
        if (!req.headers['proxy-authorization']) {
          clientSocket.write('HTTP/1.1 407 Proxy Auth Required\r\nProxy-Authenticate: Basic\r\n\r\n');
          clientSocket.end();
          return;
        }
        const targetSocket = net.connect(targetPort, '127.0.0.1', () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          targetSocket.write(head);
          targetSocket.pipe(clientSocket);
          clientSocket.pipe(targetSocket);
        });
        targetSocket.on('error', () => { clientSocket.destroy(); targetSocket.destroy(); });
      });

      // PAC auth (user:pacpass) should win over env vars (envuser:envpass)
      const handler = createTestHandler(new FixedProxyFinder({
        hostname: '127.0.0.1',
        port: upstreamPort,
        username: 'pacuser',
        password: 'pacpass',
      }));
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
        setTimeout(() => { socket.destroy(); resolve({ body: data }); }, 5000);
      });

      await closeServer(proxyServer);
      await new Promise<void>(resolve => upstreamServer.close(() => resolve()));

      expect(captured.req?.headers['proxy-authorization']).toBeDefined();
      const authHeader = captured.req?.headers['proxy-authorization'] as string;
      const decoded = Buffer.from(authHeader.substring(6), 'base64').toString();
      expect(decoded).toBe('pacuser:pacpass');
      expect(response.body).toContain('hello');
    }, 10000);

    it('should send no Proxy-Authorization when neither PAC nor env vars set auth', async () => {
      // Ensure env vars are NOT set
      delete process.env.PROXY_USER;
      delete process.env.PROXY_PASS;

      const upstreamServer = http.createServer();
      await new Promise<void>(resolve => upstreamServer.listen(0, '127.0.0.1', resolve));
      const upstreamPort = (upstreamServer.address() as net.AddressInfo).port;

      const captured: { req: http.IncomingMessage | null } = { req: null };
      upstreamServer.on('connect', (req, clientSocket, head) => {
        captured.req = req;
        // Always grant CONNECT but capture the request
        const targetSocket = net.connect(targetPort, '127.0.0.1', () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          targetSocket.write(head);
          targetSocket.pipe(clientSocket);
          clientSocket.pipe(targetSocket);
        });
        targetSocket.on('error', () => { clientSocket.destroy(); targetSocket.destroy(); });
      });

      const handler = createTestHandler(new FixedProxyFinder({
        hostname: '127.0.0.1',
        port: upstreamPort,
      }));
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
        setTimeout(() => { socket.destroy(); resolve({ body: data }); }, 5000);
      });

      await closeServer(proxyServer);
      await new Promise<void>(resolve => upstreamServer.close(() => resolve()));

      expect(captured.req?.headers['proxy-authorization']).toBeUndefined();
      expect(response.body).toContain('hello');
    }, 10000);
  });
});
