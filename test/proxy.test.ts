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
  function closeNetServer(server: net.Server): Promise<void> {
   return new Promise((resolve) => server.close(() => resolve()));
  }

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
     switch (step) {
      case 0: {
       // Method negotiation
       if (data[0] !== 0x05) { clientSocket.destroy(); return; }
       const nmethods = data[1];
       const methods = Array.from(data.slice(2, 2 + nmethods));
       if (requireAuth) {
        if (methods.includes(0x02)) {
         clientSocket.write(Buffer.from([0x05, 0x02]));
         step = 1;
        } else {
         clientSocket.write(Buffer.from([0x05, 0xff]));
         clientSocket.end();
        }
       } else {
        clientSocket.write(Buffer.from([0x05, 0x00]));
        step = 2;
       }
       break;
      }
      case 1: {
       // Username/password auth
       if (data[0] !== 0x01) { clientSocket.destroy(); return; }
       const ulen = data[1];
       const plen = data[2 + ulen];
       const recvUser = data.slice(2, 2 + ulen).toString('utf-8');
       const recvPass = data.slice(3 + ulen, 3 + ulen + plen).toString('utf-8');
       if (recvUser === username && recvPass === password) {
        clientSocket.write(Buffer.from([0x01, 0x00]));
        step = 2;
       } else {
        clientSocket.write(Buffer.from([0x01, 0x01]));
        clientSocket.end();
       }
       break;
      }
      case 2: {
       // CONNECT request
       if (data[0] !== 0x05 || data[1] !== 0x01) { clientSocket.destroy(); return; }
       const atyp = data[3];
       let targetHost: string;
       let targetPort: number;
       let addrOffset: number;

       if (atyp === 0x01) {
        // IPv4
        targetHost = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`;
        targetPort = data.readUInt16BE(8);
        addrOffset = 10;
       } else if (atyp === 0x03) {
        // Domain
        const domainLen = data[4];
        targetHost = data.slice(5, 5 + domainLen).toString('utf-8');
        targetPort = data.readUInt16BE(5 + domainLen);
        addrOffset = 5 + domainLen + 2;
       } else {
        clientSocket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        clientSocket.end();
        return;
       }

       if (rejectConnect) {
        clientSocket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        clientSocket.end();
        return;
       }

       const targetSocket = net.connect(targetPort, targetHost, () => {
        clientSocket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        clientSocket.removeListener('data', onData);
        targetSocket.pipe(clientSocket);
        clientSocket.pipe(targetSocket);
       });
       targetSocket.on('error', () => {
        clientSocket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        clientSocket.end();
       });
       break;
      }
     }
    };

    clientSocket.on('data', onData);
    clientSocket.on('error', () => {});
   });
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
    username: 'testuser',
    password: 'testpass',
   });
   await new Promise<void>(resolve => socks5Server.listen(0, '127.0.0.1', resolve));
   const socks5Port = (socks5Server.address() as net.AddressInfo).port;

   const handler = createTestHandler(new FixedProxyFinder({
    type: 'socks5' as ProxyType,
    hostname: '127.0.0.1',
    port: socks5Port,
    username: 'testuser',
    password: 'testpass',
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

 describe('SOCKS4 upstream proxy', () => {
  function closeNetServer(server: net.Server): Promise<void> {
   return new Promise((resolve) => server.close(() => resolve()));
  }

  /**
   * Minimal mock SOCKS4 proxy server.
   * Supports standard SOCKS4 (IPv4) and SOCKS4a (domain) CONNECT.
   */
  function createSocks4Server(options: { rejectConnect?: boolean } = {}): net.Server {
   const { rejectConnect = false } = options;

   return net.createServer((clientSocket) => {
    const onData = (data: Buffer) => {
     if (data[0] !== 0x04 || data[1] !== 0x01) {
      clientSocket.destroy();
      return;
     }

     if (rejectConnect) {
      clientSocket.write(Buffer.from([0x00, 0x5b, 0x00, 0x00, 0, 0, 0, 0]));
      clientSocket.end();
      return;
     }

     const port = data.readUInt16BE(2);
     const ip1 = data[4], ip2 = data[5], ip3 = data[6], ip4 = data[7];
     let targetHost: string;

     if (ip1 === 0 && ip2 === 0 && ip3 === 0 && ip4 !== 0) {
      // SOCKS4a: skip userid null, then read domain null
      let offset = 8;
      while (offset < data.length && data[offset] !== 0x00) offset++;
      offset++;
      let domainEnd = offset;
      while (domainEnd < data.length && data[domainEnd] !== 0x00) domainEnd++;
      targetHost = data.slice(offset, domainEnd).toString('utf-8');
     } else {
      targetHost = `${ip1}.${ip2}.${ip3}.${ip4}`;
     }

     const targetSocket = net.connect(port, targetHost, () => {
      clientSocket.write(Buffer.from([0x00, 0x5a, 0x00, 0x00, 0, 0, 0, 0]));
      clientSocket.removeListener('data', onData);
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
     });

     targetSocket.on('error', () => {
      clientSocket.write(Buffer.from([0x00, 0x5b, 0x00, 0x00, 0, 0, 0, 0]));
      clientSocket.end();
     });
    };

    clientSocket.on('data', onData);
    clientSocket.on('error', () => {});
   });
  }

  it('should handle CONNECT tunnel via SOCKS4 upstream', async () => {
   const socks4Server = createSocks4Server();
   await new Promise<void>(resolve => socks4Server.listen(0, '127.0.0.1', resolve));
   const socks4Port = (socks4Server.address() as net.AddressInfo).port;

   const handler = createTestHandler(new FixedProxyFinder({
    type: 'socks4' as ProxyType,
    hostname: '127.0.0.1',
    port: socks4Port,
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
   await closeNetServer(socks4Server);
   expect(response.body).toContain('hello');
  }, 10000);

  it('should return 502 when SOCKS4 upstream rejects CONNECT', async () => {
   const socks4Server = createSocks4Server({ rejectConnect: true });
   await new Promise<void>(resolve => socks4Server.listen(0, '127.0.0.1', resolve));
   const socks4Port = (socks4Server.address() as net.AddressInfo).port;

   const handler = createTestHandler(new FixedProxyFinder({
    type: 'socks4' as ProxyType,
    hostname: '127.0.0.1',
    port: socks4Port,
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
   await closeNetServer(socks4Server);
   expect(response.body).toContain('502');
  }, 10000);

  it('should forward HTTP requests via SOCKS4 upstream', async () => {
   const socks4Server = createSocks4Server();
   await new Promise<void>(resolve => socks4Server.listen(0, '127.0.0.1', resolve));
   const socks4Port = (socks4Server.address() as net.AddressInfo).port;

   const handler = createTestHandler(new FixedProxyFinder({
    type: 'socks4' as ProxyType,
    hostname: '127.0.0.1',
    port: socks4Port,
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
   await closeNetServer(socks4Server);
   expect(response.status).toBe(200);
   expect(response.body).toBe('hello');
  }, 10000);
 });
});
