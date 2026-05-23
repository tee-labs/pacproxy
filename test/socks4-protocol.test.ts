import * as net from 'net';
import { socks4Connect } from '../src/proxy/socks4-protocol';

/**
 * Minimal SOCKS4 mock server for unit testing.
 * Supports standard SOCKS4 (IPv4) and SOCKS4a (domain) requests.
 */
function createMockSocks4Server(options: {
  rejectConnect?: boolean;
} = {}): net.Server {
  const { rejectConnect = false } = options;

  return net.createServer((clientSocket) => {
    const onData = (data: Buffer) => {
      if (data[0] !== 0x04 || data[1] !== 0x01) {
        clientSocket.destroy();
        return;
      }

      if (rejectConnect) {
        // 0x5B = rejected
        const reply = Buffer.from([0x00, 0x5b, 0x00, 0x00, 0, 0, 0, 0]);
        clientSocket.write(reply);
        clientSocket.end();
        return;
      }

      // Check for SOCKS4a: IP is 0.0.0.x (x != 0)
      const ip1 = data[4];
      const ip2 = data[5];
      const ip3 = data[6];
      const ip4 = data[7];

      if (ip1 === 0 && ip2 === 0 && ip3 === 0 && ip4 !== 0) {
        // SOCKS4a — find null-terminated userid, then null-terminated domain
        let offset = 8;
        while (offset < data.length && data[offset] !== 0x00) offset++;
        offset++; // skip userid null terminator
        let domainEnd = offset;
        while (domainEnd < data.length && data[domainEnd] !== 0x00) domainEnd++;
        // Domain is data[offset..domainEnd] — we don't need to use it, just validate
      }

      // Grant — status 0x5A
      const reply = Buffer.from([0x00, 0x5a, 0x00, 0x00, 0, 0, 0, 0]);
      clientSocket.write(reply);

      // Switch to echo tunnel
      clientSocket.removeListener('data', onData);
      clientSocket.on('data', (chunk: Buffer) => {
        clientSocket.write(chunk);
      });
    };

    clientSocket.on('data', onData);
    clientSocket.on('error', () => {});
  });
}

describe('socks4-protocol', () => {
  function closeNetServer(server: net.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  it('should complete SOCKS4 handshake with IPv4 address', async () => {
    const server = createMockSocks4Server();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>(resolve => socket.on('connect', resolve));

    const result = await socks4Connect(socket, '10.0.0.1', 80);
    expect(result).toBe(true);

    // Echo test to verify tunnel works
    const echoPromise = new Promise<string>((resolve) => {
      let buf = '';
      socket.on('data', (chunk: Buffer) => { buf += chunk.toString(); if (buf === 'ping') resolve(buf); });
    });
    socket.write('ping');
    expect(await echoPromise).toBe('ping');

    socket.destroy();
    await closeNetServer(server);
  }, 10000);

  it('should complete SOCKS4a handshake with domain name', async () => {
    const server = createMockSocks4Server();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>(resolve => socket.on('connect', resolve));

    const result = await socks4Connect(socket, 'example.com', 443);
    expect(result).toBe(true);

    socket.destroy();
    await closeNetServer(server);
  }, 10000);

  it('should complete SOCKS4 handshake with userid', async () => {
    const server = createMockSocks4Server();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>(resolve => socket.on('connect', resolve));

    const result = await socks4Connect(socket, '192.168.1.1', 8080, 'testuser');
    expect(result).toBe(true);

    socket.destroy();
    await closeNetServer(server);
  }, 10000);

  it('should throw on CONNECT rejection', async () => {
    const server = createMockSocks4Server({ rejectConnect: true });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>(resolve => socket.on('connect', resolve));

    await expect(socks4Connect(socket, '10.0.0.1', 80))
      .rejects.toThrow('SOCKS4: CONNECT request rejected');

    socket.destroy();
    await closeNetServer(server);
  }, 10000);
});
