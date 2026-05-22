import * as net from 'net';

// Reuse the leftover-aware readExact from socks5-protocol
// (We import it rather than duplicating to share the WeakMap-based buffer)
import { readExact } from './socks5-protocol';

/**
 * Perform SOCKS4 handshake + CONNECT on an established TCP connection.
 *
 * SOCKS4 protocol (very simple):
 * - Client sends: [0x04, 0x01, port(2), ip(4), userid\0]
 * - Server replies: [0x00, status(1), port(2), ip(4)]
 *   Status: 0x5A = granted, 0x5B = rejected, 0x5C = no identd, 0x5D = identd mismatch
 *
 * Note: SOCKS4 only supports IPv4 addresses. For domain names, we use
 * SOCKS4a extension ( userid starts with \0, then domain\0 after the IP bytes,
 * with IP set to 0.0.0.x where x != 0 ).
 *
 * Returns true on success (status=0x5A), throws on protocol error.
 * After success, the socket is a transparent TCP tunnel to the target.
 */
export async function socks4Connect(
  socket: net.Socket,
  host: string,
  port: number,
  userid?: string,
): Promise<boolean> {
  // Determine if host is an IP or a domain
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = host.match(ipv4Regex);

  const userIdBuf = Buffer.from(userid || '', 'utf-8');

  if (match) {
    // Direct IPv4 — standard SOCKS4
    const octets = match.slice(1, 5).map(Number);
    const req = Buffer.alloc(8 + userIdBuf.length + 1); // +1 for null terminator
    req[0] = 0x04; // SOCKS version
    req[1] = 0x01; // CONNECT
    req.writeUInt16BE(port, 2);
    req[4] = octets[0];
    req[5] = octets[1];
    req[6] = octets[2];
    req[7] = octets[3];
    if (userIdBuf.length > 0) {
      userIdBuf.copy(req, 8);
    }
    req[8 + userIdBuf.length] = 0x00; // null terminator
    socket.write(req);
  } else {
    // Domain name — use SOCKS4a extension
    const domainBuf = Buffer.from(host, 'utf-8');
    const req = Buffer.alloc(8 + userIdBuf.length + 1 + domainBuf.length + 1);
    req[0] = 0x04; // SOCKS version
    req[1] = 0x01; // CONNECT
    req.writeUInt16BE(port, 2);
    req[4] = 0x00; // 0.0.0.x — SOCKS4a marker
    req[5] = 0x00;
    req[6] = 0x00;
    req[7] = 0x01; // x != 0 signals SOCKS4a
    if (userIdBuf.length > 0) {
      userIdBuf.copy(req, 8);
    }
    let offset = 8 + userIdBuf.length;
    req[offset++] = 0x00; // null terminator for userid
    domainBuf.copy(req, offset);
    req[offset + domainBuf.length] = 0x00; // null terminator for domain
    socket.write(req);
  }

  // Read 8-byte reply
  const reply = await readExact(socket, 8);
  if (reply[0] !== 0x00) {
    throw new Error(`SOCKS4: invalid reply (expected 0x00, got 0x${reply[0].toString(16)})`);
  }

  const status = reply[1];
  if (status !== 0x5a) {
    const statusNames: Record<number, string> = {
      0x5b: 'request rejected',
      0x5c: 'request rejected (no identd)',
      0x5d: 'request rejected (identd mismatch)',
    };
    throw new Error(`SOCKS4: CONNECT ${statusNames[status] || `failed with status 0x${status.toString(16)}`}`);
  }

  return true;
}
