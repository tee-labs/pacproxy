import * as net from 'net';
import { Logger } from '../logger';

const POOL_KEY_SEPARATOR = ':';

interface PoolEntry {
  socket: net.Socket;
  lastUsed: number;
  timer: NodeJS.Timeout | null;
}

/**
 * TCP 连接池，用于复用 upstream proxy 的连接。
 *
 * CONNECT 隧道走 upstream proxy 时，TCP 连接建立后发送 CONNECT 请求。
 * 如果 upstream 返回非 200（如 407 Proxy Auth Required），
 * TCP 连接本身仍然健康，可以放回池中供下一个 CONNECT 重用。
 *
 * 如果 CONNECT 返回 200，连接进入隧道模式并被消耗，不会放回池中。
 */
export class TcpConnectionPool {
  private pool = new Map<string, PoolEntry[]>();
  private readonly logger: Logger;

  constructor(
    private readonly options: {
      maxIdlePerKey?: number;
      idleTimeoutMs?: number;
      connectTimeoutMs?: number;
      keepAliveMs?: number;
    } = {},
    logger?: Logger,
  ) {
    this.logger = logger ?? new Logger(false);
    this.options.maxIdlePerKey ??= 5;
    this.options.idleTimeoutMs ??= 30000;
    this.options.connectTimeoutMs ??= 10000;
    this.options.keepAliveMs ??= 30000;
  }

  private poolKey(host: string, port: number): string {
    return `${host}${POOL_KEY_SEPARATOR}${port}`;
  }

  /**
   * 获取一个连接到 (host, port) 的 socket。
   * 优先从空闲池中取，无可用连接时新建。
   */
  acquire(host: string, port: number): Promise<net.Socket> {
    const key = this.poolKey(host, port);
    const entries = this.pool.get(key);

    // 尝试从池中取一个健康的 socket
    if (entries && entries.length > 0) {
      const entry = entries.pop()!;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      const socket = entry.socket;
      if (!socket.destroyed && socket.readable && socket.writable) {
        this.logger.debug(`[pool] Reused idle connection to ${key}`);
        return Promise.resolve(socket);
      }
      // socket 已挂，丢弃并创建新的
      this.logger.debug(`[pool] Idle connection to ${key} stale, creating new`);
    }

    return this.createSocket(host, port, key);
  }

  /**
   * 将 socket 放回池中。
   * 仅当连接仍健康时才放回，并设置超时自动清理。
   */
  release(host: string, port: number, socket: net.Socket): void {
    if (socket.destroyed || !socket.readable || !socket.writable) {
      socket.destroy();
      return;
    }

    const key = this.poolKey(host, port);
    let entries = this.pool.get(key);
    if (!entries) {
      entries = [];
      this.pool.set(key, entries);
    }

    // 超过最大空闲数，直接销毁
    if (entries.length >= this.options.maxIdlePerKey!) {
      this.logger.debug(`[pool] Max idle per key reached for ${key}, destroying`);
      socket.destroy();
      return;
    }

    const entry: PoolEntry = {
      socket,
      lastUsed: Date.now(),
      timer: setTimeout(() => {
        this.logger.debug(`[pool] Idle connection to ${key} timed out, closing`);
        this.removeEntry(key, entry);
        socket.destroy();
      }, this.options.idleTimeoutMs!),
    };
    // 允许进程退出时不要被 timer 阻塞
    if (entry.timer) entry.timer.unref();

    entries.push(entry);
    this.logger.debug(`[pool] Released connection to ${key} (pool size: ${entries.length})`);
  }

  /**
   * 关闭所有空闲连接。
   */
  drain(): void {
    this.pool.forEach((entries, key) => {
      entries.forEach(entry => {
        if (entry.timer) clearTimeout(entry.timer);
        if (!entry.socket.destroyed) entry.socket.destroy();
      });
      this.pool.delete(key);
    });
  }

  /**
   * 池中当前空闲连接数。
   */
  get idleCount(): number {
    let count = 0;
    this.pool.forEach(entries => {
      count += entries.length;
    });
    return count;
  }

  private createSocket(host: string, port: number, key: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, host);
      socket.setKeepAlive(true, this.options.keepAliveMs!);
      socket.setTimeout(this.options.connectTimeoutMs!);

      socket.on('connect', () => {
        socket.setTimeout(0);
        this.logger.debug(`[pool] New connection to ${key}`);
        resolve(socket);
      });

      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error(`Connection to ${key} timed out`));
      });

      socket.on('error', (err) => {
        socket.destroy();
        reject(err);
      });
    });
  }

  private removeEntry(key: string, entry: PoolEntry): void {
    const entries = this.pool.get(key);
    if (!entries) return;
    const idx = entries.indexOf(entry);
    if (idx >= 0) entries.splice(idx, 1);
    if (entries.length === 0) this.pool.delete(key);
  }
}
