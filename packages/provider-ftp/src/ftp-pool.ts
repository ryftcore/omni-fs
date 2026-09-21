import { OmniFsError, throwIfAborted } from '@omni-fs/core';
import type { Logger } from '@omni-fs/core';
import { isConnectionLimit, toOmniFsError } from './errors.js';
import type { FtpChannel } from './ftp-channel.js';

export interface FtpPoolOptions {
  /** The ceiling this pool starts with. It only ever goes down. */
  readonly maxConnections: number;
  readonly open: (signal?: AbortSignal) => Promise<FtpChannel>;
  readonly logger: Logger;
}

interface PoolWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * The control channels this connection has, and who is using them.
 *
 * FTP carries one command per connection, so a single channel means a large
 * download blocks browsing until it finishes. That is a client limitation, not
 * a protocol one, and every desktop FTP client answers it the same way: open
 * another connection. The ceiling is a setting, defaulting to 1, so the
 * out-of-the-box behaviour is the conservative one no server can object to.
 *
 * Every operation leases a channel for its whole duration, which is also what
 * makes `RNFR`/`RNTO` safe — that pair must not interleave with anything.
 */
export class FtpPool {
  readonly #open: FtpPoolOptions['open'];
  readonly #logger: Logger;
  readonly #live = new Set<FtpChannel>();
  readonly #idle: FtpChannel[] = [];
  readonly #waiters: PoolWaiter[] = [];
  #ceiling: number;
  #opening = 0;
  #closed = false;

  constructor(options: FtpPoolOptions) {
    this.#ceiling = options.maxConnections;
    this.#open = options.open;
    this.#logger = options.logger;
  }

  /** What `capabilities.maxConcurrency` reports, so the queue follows it down. */
  get ceiling(): number {
    return this.#ceiling;
  }

  get size(): number {
    return this.#live.size;
  }

  isAlive(): boolean {
    if (this.#closed) return false;
    for (const channel of this.#live) if (channel.isAlive()) return true;
    return false;
  }

  async acquire(signal?: AbortSignal): Promise<FtpChannel> {
    for (;;) {
      if (this.#closed) throw closedError();
      throwIfAborted(signal, 'FTP connection');

      const idle = this.#idle.pop();
      if (idle !== undefined) {
        if (idle.isAlive()) return idle;
        // The server idles a connection out after a few minutes and says
        // nothing until the next command. Replacing it before the operation
        // starts is pool bookkeeping, not a retry: a channel that dies *during*
        // an operation surfaces `ConnectionFailed{retryable}` and is core's to
        // reconnect, through the `isAlive()` check in `ConnectionManager`.
        this.#discard(idle);
        continue;
      }

      if (this.#live.size + this.#opening < this.#ceiling) {
        const opened = await this.#openOne(signal);
        if (opened !== undefined) return opened;
        continue;
      }

      await this.#waitForRelease(signal);
    }
  }

  release(channel: FtpChannel): void {
    if (this.#closed || !channel.isAlive()) this.#discard(channel);
    else this.#idle.push(channel);
    this.#waiters.shift()?.resolve();
  }

  async lease<T>(body: (channel: FtpChannel) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const channel = await this.acquire(signal);
    try {
      return await body(channel);
    } finally {
      this.release(channel);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    for (const waiter of this.#waiters.splice(0)) waiter.reject(closedError());
    this.#idle.length = 0;

    const channels = [...this.#live];
    this.#live.clear();
    await Promise.all(channels.map((channel) => channel.close().catch(() => undefined)));
  }

  /** `undefined` means "the ceiling moved, go round again", not "it failed". */
  async #openOne(signal?: AbortSignal): Promise<FtpChannel | undefined> {
    // The slot is reserved before the await, or two concurrent acquires both
    // see room below the ceiling and open one connection too many.
    this.#opening += 1;
    try {
      const channel = await this.#open(signal);
      if (this.#closed) {
        await channel.close().catch(() => undefined);
        throw closedError();
      }
      this.#live.add(channel);
      return channel;
    } catch (error) {
      if (isConnectionLimit(error) && this.#live.size > 0) {
        this.#shrink();
        return undefined;
      }
      throw toOmniFsError(error);
    } finally {
      this.#opening -= 1;
    }
  }

  /**
   * Permanently, for the life of this connection. A server that refuses a
   * fourth login will refuse it again in a minute, and asking repeatedly is a
   * failed login per operation for as long as the connection lives.
   */
  #shrink(): void {
    const next = Math.max(1, this.#live.size);
    if (next >= this.#ceiling) return;
    this.#ceiling = next;
    this.#logger.log('warn', 'FTP server refused another login; lowering the pool ceiling', {
      ceiling: next,
    });
  }

  #discard(channel: FtpChannel): void {
    this.#live.delete(channel);
    void channel.close().catch(() => undefined);
  }

  async #waitForRelease(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // `onAbort` names `waiter` and `waiter` names `onAbort`, so one of the
      // two has to be a forward reference. Both are only ever reached from a
      // callback, long after this function has returned.
      const onAbort = (): void => {
        // The waiter that aborted, found by identity — never whichever happens
        // to be at the head, or the abort evicts the caller standing behind it.
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        waiter.reject(
          new OmniFsError({
            code: 'Cancelled',
            message: 'Cancelled: FTP connection',
            providerId: 'ftp',
          }),
        );
      };

      // Detaching on settle is what keeps a release and an abort from both
      // acting on one waiter: once `release` has shifted it off the queue and
      // resolved it, a later abort on the same signal reaches nothing.
      const waiter: PoolWaiter = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject: (error: unknown) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }
}

function closedError(): OmniFsError {
  return new OmniFsError({
    code: 'ConnectionFailed',
    message: 'FTP connection is closed.',
    providerId: 'ftp',
    retryable: false,
  });
}
