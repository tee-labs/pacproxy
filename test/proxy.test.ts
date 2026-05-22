import * as http from 'http';
import * as net from 'net';
import { OttoEngine } from '../src/pac/engine';
import { FirstItemSelector } from '../src/pac/selector';
import { ProxyHTTPHandler } from '../src/proxy/handler';
import { ProxyType } from '../src/pac/types';

class DirectProxyFinder {
  async findProxyForURL(): Promise<any> {
    const { Proxies, DirectProxy } = await import('../src/pac/types');
    return new Proxies([DirectProxy]);
  }
}

class FixedProxyFinder {
  constructor(private proxy: { type?: ProxyType; hostname: string; port: number; username?: string; password?: string }) {}
  async findProxyForURL(): Promise<any> {
    const { Proxies } = await import('../src/pac/types');
    return new Proxies([{ type: 'http' as ProxyType, ...this.proxy }]);
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

 describe('SOCKS5 upstream proxy', () => {
  /**
   * Minimal mock SOCKS5 proxy server (RFC 1928 + RFC 1929).
   * Supports NO_AUTH (0x00) and USERNAME/PASSWORD (0x02).
   * On successful CONNECT, pipes to the target.
   */
  function createSocks5Server(options: {
    requireAuth?: boolean;
    username?: string;
    password?: string;
    rejectConnect?: boolean;
  } = {}): net.Server {
    const { requireAuth = false, username, password, rejectConnect = false } = options;

 return net.createServer((clientSocket) => {
 let step = 0; // 0=method_neg, 1=auth, 2=connect

 const onData = (data: Buffer) => {
        if (step === 0) {
          // Method negotiation
          if (data[0] !== 0x05) { clientSocket.destroy(); return; }
          const nmethods = data[1];
          const methods = Array.from(data.slice(2, 2 + nmethods));

          if (requireAuth) {
            if (methods.includes(0x02)) {
              clientSocket.write(Buffer.from([0x05, 0x02])); // select USERNAME/PASSWORD
              step = 1;
            } else {
              clientSocket.write(Buffer.from([0x05, 0xff])); // no acceptable
              clientSocket.end();
            }
          } else {
            if (methods.includes(0x00)) {
              clientSocket.write(Buffer.from([0x05, 0x00])); // select NO_AUTH
              step = 2;
            } else if (methods.includes(0x02)) {
              clientSocket.write(Buffer.from([0x05, 0x02]));
              step = 1;
            } else {
              clientSocket.write(Buffer.from([0x05, 0xff]));
              clientSocket.end();
            }
          }
        } else if (step === 1) {
          // Username/Password sub-negotiation (RFC 1929)
          if (data[0] !== 0x01) { clientSocket.destroy(); return; }
          const ulen = data[1];
          const uname = data.slice(2, 2 + ulen).toString('utf-8');
          const plen = data[2 + ulen];
          const pword = data.slice(3 + ulen, 3 + ulen + plen).toString('utf-8');

          if (username && password && uname === username && pword === password) {
            clientSocket.write(Buffer.from([0x01, 0x00])); // success
            step = 2;
          } else {
            clientSocket.write(Buffer.from([0x01, 0x01])); // failure
            clientSocket.end();
          }
        } else if (step === 2) {
          // CONNECT request
          if (data[0] !== 0x05 || data[1] !== 0x01) {
            // Not a CONNECT command — reject
            const reply = Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
            clientSocket.write(reply);
            clientSocket.end();
            return;
          }

          if (rejectConnect) {
            const reply = Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]); // connection refused
            clientSocket.write(reply);
            clientSocket.end();
            return;
          }

          const atyp = data[3];
          let targetHost: string;
          let offset: number;

          if (atyp === 0x01) {
            // IPv4
            targetHost = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`;
            offset = 8;
          } else if (atyp === 0x03) {
            // Domain
            const domainLen = data[4];
            targetHost = data.slice(5, 5 + domainLen).toString('utf-8');
            offset = 5 + domainLen;
          } else if (atyp === 0x04) {
            // IPv6 — not commonly needed in tests
            clientSocket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            clientSocket.end();
            return;
          } else {
            clientSocket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            clientSocket.end();
            return;
          }

          const targetPort = data.readUInt16BE(offset);

          // Connect to target
          const targetSocket = net.connect(targetPort, targetHost, () => {
            // Send success reply with bound address (0.0.0.0:0)
            const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
            clientSocket.write(reply);
            // Pipe data — this is now a transparent tunnel
            targetSocket.pipe(clientSocket);
            clientSocket.pipe(targetSocket);
          });

          targetSocket.on('error', () => {
            const reply = Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
            clientSocket.write(reply);
            clientSocket.end();
          });

 // Stop the data handler — tunnel is now transparent
 // Remove the data listener so pipe can take over
 clientSocket.removeListener('data', onData);
 }
 // step === 3: tunnel mode — data is piped, ignore here
 };

 clientSocket.on('data', onData);

 clientSocket.on('error', () => {});
    });
  }

  function closeNetServer(server: net.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  it('should handle CONNECT tunnel via SOCKS5 upstream (no auth)', async () => {
    const socks5Server = createSocks5Server();
    await new Promise<void>(resolve => socks5Server.listen(0, '127.0.0.1', resolve));
    const socks5Port = (socks5Server.address() as net.AddressInfo).port;

    const handler = createTestHandler(new FixedProxyFinder({
      type: 'socks5' as ProxyType,
      hostname: '127.0.0.1',
      port: socks5Port,
    }));
    const proxyServer = handler.createServer();
    await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
    const proxyAddr = proxyServer.address() as net.AddressInfo;

    const response = await new Promise<{ body: string }>((resolve) => {
      const socket = net.connect(proxyAddr.port, '127.0.0.1', () => {
        socket.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);
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
    await closeNetServer(socks5Server);

    expect(response.body).toContain('hello');
  }, 10000);

  it('should handle CONNECT tunnel via SOCKS5 upstream with auth', async () => {
    const socks5Server = createSocks5Server({
      requireAuth: true,
      username: 'socksuser',
      password: 'sockspass',
    });
    await new Promise<void>(resolve => socks5Server.listen(0, '127.0.0.1', resolve));
    const socks5Port = (socks5Server.address() as net.AddressInfo).port;

    const handler = createTestHandler(new FixedProxyFinder({
      type: 'socks5' as ProxyType,
      hostname: '127.0.0.1',
      port: socks5Port,
      username: 'socksuser',
      password: 'sockspass',
    }));
    const proxyServer = handler.createServer();
    await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
    const proxyAddr = proxyServer.address() as net.AddressInfo;

    const response = await new Promise<{ body: string }>((resolve) => {
      const socket = net.connect(proxyAddr.port, '127.0.0.1', () => {
        socket.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);
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
    await closeNetServer(socks5Server);

    expect(response.body).toContain('hello');
  }, 10000);

  it('should return 502 when SOCKS5 upstream rejects CONNECT', async () => {
    const socks5Server = createSocks5Server({ rejectConnect: true });
    await new Promise<void>(resolve => socks5Server.listen(0, '127.0.0.1', resolve));
    const socks5Port = (socks5Server.address() as net.AddressInfo).port;

    const handler = createTestHandler(new FixedProxyFinder({
      type: 'socks5' as ProxyType,
      hostname: '127.0.0.1',
      port: socks5Port,
    }));
    const proxyServer = handler.createServer();
    await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
    const proxyAddr = proxyServer.address() as net.AddressInfo;

    const response = await new Promise<{ body: string }>((resolve) => {
      const socket = net.connect(proxyAddr.port, '127.0.0.1', () => {
        socket.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);
      });
      let data = '';
      socket.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      socket.on('close', () => resolve({ body: data }));
      socket.on('error', () => resolve({ body: data }));
      setTimeout(() => { socket.destroy(); resolve({ body: data }); }, 5000);
    });

    await closeServer(proxyServer);
    await closeNetServer(socks5Server);

    // socks5Connect throws on non-zero reply, handler catches and returns 502
    expect(response.body).toContain('502');
  }, 10000);

  it('should forward HTTP requests via SOCKS5 upstream', async () => {
    const socks5Server = createSocks5Server();
    await new Promise<void>(resolve => socks5Server.listen(0, '127.0.0.1', resolve));
    const socks5Port = (socks5Server.address() as net.AddressInfo).port;

    const handler = createTestHandler(new FixedProxyFinder({
      type: 'socks5' as ProxyType,
      hostname: '127.0.0.1',
      port: socks5Port,
    }));
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
    await closeNetServer(socks5Server);

    expect(response.status).toBe(200);
    expect(response.body).toBe('hello');
  }, 10000);

  it('should destroy SOCKS5 connection on CONNECT failure and not return to pool', async () => {
    const socks5Server = createSocks5Server({ rejectConnect: true });
    await new Promise<void>(resolve => socks5Server.listen(0, '127.0.0.1', resolve));
    const socks5Port = (socks5Server.address() as net.AddressInfo).port;

    const handler = createTestHandler(new FixedProxyFinder({
      type: 'socks5' as ProxyType,
      hostname: '127.0.0.1',
      port: socks5Port,
    }));
    const proxyServer = handler.createServer();
    await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
    const proxyAddr = proxyServer.address() as net.AddressInfo;

    // Send CONNECT — should fail
    await new Promise<void>((resolve) => {
      const socket = net.connect(proxyAddr.port, '127.0.0.1', () => {
        socket.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);
      });
      socket.on('data', () => {});
      socket.on('close', resolve);
      socket.on('error', resolve);
      setTimeout(() => { socket.destroy(); resolve(); }, 3000);
    });

    expect((handler as any).connPool.idleCount).toBe(0);

    await closeServer(proxyServer);
    await closeNetServer(socks5Server);
  }, 10000);
 });
});
