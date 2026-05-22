import * as net from 'net';

/** Leftover buffer shared across sequential readExact calls on the same socket. */
const leftoverMap = new WeakMap<net.Socket, Buffer>();

/**
 * Read exactly `n` bytes from a socket.
 * Handles TCP segment coalescing by buffering leftover data for subsequent calls.
 * Resolves with a Buffer of length `n`, or rejects on error/timeout.
 */
export function readExact(socket: net.Socket, n: number, timeoutMs = 10000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Check leftover buffer first
    const leftover = leftoverMap.get(socket);
    if (leftover && leftover.length >= n) {
      leftoverMap.set(socket, leftover.subarray(n));
      resolve(leftover.subarray(0, n));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('SOCKS5 read timeout'));
    }, timeoutMs);

    const chunks: Buffer[] = [];
    let received = 0;

    // Prepend any leftover data
    if (leftover && leftover.length > 0) {
      chunks.push(leftover);
      received += leftover.length;
      leftoverMap.delete(socket);
    }

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= n) {
        cleanup();
        const full = Buffer.concat(chunks);
        const result = full.subarray(0, n);
        const rest = full.subarray(n);
        if (rest.length > 0) {
          leftoverMap.set(socket, Buffer.from(rest)); // copy to avoid subarray referencing
        }
        resolve(result);
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onClose = () => {
      cleanup();
      reject(new Error('SOCKS5: connection closed during handshake'));
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
 * Perform SOCKS5 handshake + CONNECT on an established TCP connection.
 *
 * RFC 1928 (SOCKS5) + RFC 1929 (Username/Password auth).
 *
 * Returns true on success (rep=0x00), throws on protocol error.
 * After success, the socket is a transparent TCP tunnel to the target.
 */
export async function socks5Connect(
  socket: net.Socket,
  host: string,
  port: number,
  username?: string,
  password?: string,
): Promise<boolean> {
  // 1. Method negotiation
  const hasAuth = !!(username && password);
  socket.write(Buffer.from([0x05, hasAuth ? 0x02 : 0x01, 0x00, ...(hasAuth ? [0x02] : [])]));

  const methodReply = await readExact(socket, 2);
  if (methodReply[0] !== 0x05) {
    throw new Error('SOCKS5: proxy is not SOCKS5');
  }
  if (methodReply[1] === 0xff) {
    throw new Error('SOCKS5: no acceptable auth method');
  }

  // 2. Username/Password sub-negotiation (RFC 1929)
  if (methodReply[1] === 0x02) {
    if (!username || !password) {
      throw new Error('SOCKS5: proxy requires auth but no credentials provided');
    }
    const userBuf = Buffer.from(username, 'utf-8');
    const passBuf = Buffer.from(password, 'utf-8');
    const authReq = Buffer.alloc(3 + userBuf.length + passBuf.length);
    authReq[0] = 0x01; // sub-negotiation version
    authReq[1] = userBuf.length;
    userBuf.copy(authReq, 2);
    authReq[2 + userBuf.length] = passBuf.length;
    passBuf.copy(authReq, 3 + userBuf.length);
    socket.write(authReq);

    const authReply = await readExact(socket, 2);
    if (authReply[1] !== 0x00) {
      throw new Error('SOCKS5: authentication failed');
    }
  }

  // 3. CONNECT request — use domain address type (0x03) for maximum compatibility
  const hostBuf = Buffer.from(host, 'utf-8');
  const req = Buffer.alloc(7 + hostBuf.length);
  req[0] = 0x05; // version
  req[1] = 0x01; // CONNECT
  req[2] = 0x00; // RSV
  req[3] = 0x03; // domain address type
  req[4] = hostBuf.length;
  hostBuf.copy(req, 5);
  req.writeUInt16BE(port, 5 + hostBuf.length);
  socket.write(req);

  // 4. Read reply — need at least 4 bytes to check status (ver + rep + rsv + atyp)
  const replyHeader = await readExact(socket, 4);
  if (replyHeader[0] !== 0x05) {
    throw new Error('SOCKS5: invalid reply version');
  }
  if (replyHeader[1] !== 0x00) {
    throw new Error(`SOCKS5: CONNECT failed with reply code 0x${replyHeader[1].toString(16)}`);
  }

  // Consume the bound address + port based on address type
  const atyp = replyHeader[3];
  let addrLen: number;
  switch (atyp) {
    case 0x01: addrLen = 4; break; // IPv4
    case 0x03: {
      // Domain: 1 byte length + domain bytes
      const domainLenBuf = await readExact(socket, 1);
      addrLen = 1 + domainLenBuf[0];
      break;
    }
    case 0x04: addrLen = 16; break; // IPv6
    default:
      throw new Error(`SOCKS5: unknown address type 0x${atyp.toString(16)}`);
  }
  // Read remaining address + 2 bytes port
  await readExact(socket, addrLen + 2);

  return true;
}
