import * as net from 'net';
import { readExact, socks5Connect } from '../src/proxy/socks5-protocol';

/**
 * Minimal SOCKS5 mock server for unit testing socks5Connect directly.
 */
function createMockSocks5Server(options: {
  requireAuth?: boolean;
  username?: string;
  password?: string;
  rejectConnect?: boolean;
} = {}): net.Server {
  const { requireAuth = false, username, password, rejectConnect = false } = options;

  return net.createServer((clientSocket) => {
    let step = 0;
    const onData = (data: Buffer) => {
      if (step === 0) {
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
      } else if (step === 1) {
        if (data[0] !== 0x01) { clientSocket.destroy(); return; }
        const ulen = data[1];
        const uname = data.slice(2, 2 + ulen).toString('utf-8');
        const plen = data[2 + ulen];
        const pword = data.slice(3 + ulen, 3 + ulen + plen).toString('utf-8');
        if (uname === username && pword === password) {
          clientSocket.write(Buffer.from([0x01, 0x00]));
          step = 2;
        } else {
          clientSocket.write(Buffer.from([0x01, 0x01]));
          clientSocket.end();
        }
      } else if (step === 2) {
        if (data[0] !== 0x05 || data[1] !== 0x01) {
          clientSocket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          clientSocket.end();
          return;
        }
        if (rejectConnect) {
          clientSocket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          clientSocket.end();
          return;
        }
        // Success — reply with bound address 0.0.0.0:0
        clientSocket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        // Echo back anything the client sends (simple echo tunnel)
        clientSocket.removeListener('data', onData);
        clientSocket.on('data', (chunk: Buffer) => {
          clientSocket.write(chunk);
        });
      }
    };
    clientSocket.on('data', onData);
    clientSocket.on('error', () => {});
  });
}

describe('socks5-protocol', () => {
  function closeNetServer(server: net.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  it('should complete SOCKS5 handshake without auth', async () => {
    const server = createMockSocks5Server();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>(resolve => socket.on('connect', resolve));

    const result = await socks5Connect(socket, 'example.com', 443);
    expect(result).toBe(true);

    // Verify tunnel is usable: send data, get echo
    const echoPromise = new Promise<string>((resolve) => {
      let buf = '';
      socket.on('data', (chunk: Buffer) => { buf += chunk.toString(); if (buf === 'ping') resolve(buf); });
    });
    socket.write('ping');
    const echoed = await echoPromise;
    expect(echoed).toBe('ping');

    socket.destroy();
    await closeNetServer(server);
  }, 10000);

  it('should complete SOCKS5 handshake with auth', async () => {
    const server = createMockSocks5Server({
      requireAuth: true,
      username: 'testuser',
      password: 'testpass',
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>(resolve => socket.on('connect', resolve));

    const result = await socks5Connect(socket, 'example.com', 443, 'testuser', 'testpass');
    expect(result).toBe(true);

    // Verify tunnel: echo test
    const echoPromise = new Promise<string>((resolve) => {
      let buf = '';
      socket.on('data', (chunk: Buffer) => { buf += chunk.toString(); if (buf === 'ping') resolve(buf); });
    });
    socket.write('ping');
    expect(await echoPromise).toBe('ping');

    socket.destroy();
    await closeNetServer(server);
  }, 10000);

  it('should throw on auth failure', async () => {
    const server = createMockSocks5Server({
      requireAuth: true,
      username: 'correct',
      password: 'pass',
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>(resolve => socket.on('connect', resolve));

    await expect(socks5Connect(socket, 'example.com', 443, 'wrong', 'creds'))
      .rejects.toThrow('SOCKS5: authentication failed');

    socket.destroy();
    await closeNetServer(server);
  });

  it('should throw on CONNECT rejection', async () => {
    const server = createMockSocks5Server({ rejectConnect: true });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>(resolve => socket.on('connect', resolve));

    await expect(socks5Connect(socket, 'example.com', 443))
      .rejects.toThrow('SOCKS5: CONNECT failed');

    socket.destroy();
    await closeNetServer(server);
  });

  it('should throw when no acceptable auth method', async () => {
    const server = createMockSocks5Server({ requireAuth: true });
    // Server requires auth but client won't offer 0x02 method
    // Actually socks5Connect always offers 0x00, and with auth also 0x02
    // So this test verifies the 0xFF response path
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>(resolve => socket.on('connect', resolve));

    // Send method negotiation without 0x02 method — only 0x00
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    const reply = await readExact(socket, 2);
    expect(reply[1]).toBe(0xff); // no acceptable method

    socket.destroy();
    await closeNetServer(server);
  });
});
