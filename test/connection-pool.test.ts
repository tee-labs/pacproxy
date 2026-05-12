import * as net from 'net';
import { TcpConnectionPool } from '../src/proxy/connection-pool';

describe('TcpConnectionPool', () => {
  let server: net.Server;
  let serverPort: number;
  const allSockets: net.Socket[] = [];
  let pool: TcpConnectionPool | null = null;

  beforeAll((done) => {
    server = net.createServer((socket) => {
      socket.on('data', () => {
        socket.write('HTTP/1.1 200 OK\r\n\r\n');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      serverPort = (server.address() as net.AddressInfo).port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  function trackSocket(s: net.Socket): net.Socket {
    allSockets.push(s);
    return s;
  }

  afterEach(() => {
    if (pool) pool.drain();
    pool = null;
    // Destroy any sockets that weren't cleaned up
    allSockets.forEach(s => { if (!s.destroyed) s.destroy(); });
    allSockets.length = 0;
  });

  describe('acquire', () => {
    it('should create a new connection when pool is empty', async () => {
      pool = new TcpConnectionPool();
      const socket = trackSocket(await pool.acquire('127.0.0.1', serverPort));
      expect(socket.destroyed).toBe(false);
      expect(socket.readable).toBe(true);
    });

    it('should reuse idle connections', async () => {
      pool = new TcpConnectionPool({ maxIdlePerKey: 5, idleTimeoutMs: 50000 });
      const socket1 = trackSocket(await pool.acquire('127.0.0.1', serverPort));
      pool.release('127.0.0.1', serverPort, socket1);
      expect(pool.idleCount).toBe(1);

      const socket2 = trackSocket(await pool.acquire('127.0.0.1', serverPort));
      expect(socket2).toBe(socket1); // Same socket
      expect(pool.idleCount).toBe(0);
    });

    it('should create new connection when idle socket is stale', async () => {
      pool = new TcpConnectionPool({ maxIdlePerKey: 5, idleTimeoutMs: 50000 });
      const socket1 = trackSocket(await pool.acquire('127.0.0.1', serverPort));
      socket1.destroy();
      pool.release('127.0.0.1', serverPort, socket1);
      expect(pool.idleCount).toBe(0);

      const socket2 = trackSocket(await pool.acquire('127.0.0.1', serverPort));
      expect(socket2).not.toBe(socket1);
      expect(socket2.destroyed).toBe(false);
    });

    it('should reject when connection fails', async () => {
      pool = new TcpConnectionPool({ connectTimeoutMs: 1000 });
      await expect(pool.acquire('192.0.2.1', 12345)).rejects.toThrow();
    });
  });

  describe('release', () => {
    it('should keep connection in pool for reuse', async () => {
      pool = new TcpConnectionPool({ maxIdlePerKey: 5, idleTimeoutMs: 50000 });
      const socket = trackSocket(await pool.acquire('127.0.0.1', serverPort));

      pool.release('127.0.0.1', serverPort, socket);
      expect(pool.idleCount).toBe(1);
    });

    it('should not release destroyed sockets', async () => {
      pool = new TcpConnectionPool({ maxIdlePerKey: 5, idleTimeoutMs: 50000 });
      const socket = trackSocket(await pool.acquire('127.0.0.1', serverPort));
      socket.destroy();
      pool.release('127.0.0.1', serverPort, socket);
      expect(pool.idleCount).toBe(0);
    });

    it('should enforce maxIdlePerKey limit', async () => {
      pool = new TcpConnectionPool({ maxIdlePerKey: 2, idleTimeoutMs: 50000 });
      const sockets = await Promise.all([
        pool.acquire('127.0.0.1', serverPort),
        pool.acquire('127.0.0.1', serverPort),
        pool.acquire('127.0.0.1', serverPort),
      ]);

      sockets.forEach(s => trackSocket(s));
      sockets.forEach(s => pool!.release('127.0.0.1', serverPort, s));
      expect(pool.idleCount).toBe(2);
      // The third socket should be destroyed due to maxIdlePerKey
      const alive = sockets.filter(s => !s.destroyed).length;
      expect(alive).toBe(2);
    });
  });

  describe('drain', () => {
    it('should close all idle connections', async () => {
      pool = new TcpConnectionPool({ maxIdlePerKey: 5, idleTimeoutMs: 50000 });
      const socket = trackSocket(await pool.acquire('127.0.0.1', serverPort));
      pool.release('127.0.0.1', serverPort, socket);

      expect(pool.idleCount).toBe(1);
      pool.drain();
      expect(pool.idleCount).toBe(0);
      expect(socket.destroyed).toBe(true);
    });
  });

  describe('idle timeout', () => {
    it('should auto-close idle connections after timeout', async () => {
      pool = new TcpConnectionPool({ maxIdlePerKey: 5, idleTimeoutMs: 50 });
      const socket = trackSocket(await pool.acquire('127.0.0.1', serverPort));

      pool.release('127.0.0.1', serverPort, socket);
      expect(pool.idleCount).toBe(1);

      // Wait for timeout
      await new Promise(r => setTimeout(r, 150));
      expect(pool.idleCount).toBe(0);
    });
  });
});
