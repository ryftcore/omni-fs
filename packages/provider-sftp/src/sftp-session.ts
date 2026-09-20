import { Readable, type Writable } from 'node:stream';
import { Client } from 'ssh2';
import type { ConnectConfig, FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';
import { OmniFsError } from '@omni-fs/core';
import type { Logger } from '@omni-fs/core';
import { buildAuth } from './auth.js';
import { toOmniFsError } from './errors.js';
import { fingerprint, readKnownHosts, verifyHostKey } from './known-hosts.js';
import type { SftpSettings } from './settings.js';

/** What this provider needs from `SSH_FXP_ATTRS`. `mtime` is seconds, as SFTP counts it. */
export interface SftpAttrs {
  readonly mode: number;
  readonly size: number;
  readonly mtime: number;
  readonly uid: number;
  readonly gid: number;
}

export interface SftpEntry {
  readonly filename: string;
  readonly attrs: SftpAttrs;
}

/** OpenSSH extensions this provider can use, as announced by the connected server. */
export interface SftpExtensions {
  readonly posixRename: boolean;
  readonly fsync: boolean;
  readonly copyData: boolean;
}

/** The request-shaped half of the transport. Task 6 adds the streaming half. */
export interface SftpRequests {
  readonly extensions: SftpExtensions;
  stat(path: string, signal?: AbortSignal): Promise<SftpAttrs>;
  lstat(path: string, signal?: AbortSignal): Promise<SftpAttrs>;
  readdir(path: string, signal?: AbortSignal): Promise<readonly SftpEntry[]>;
  mkdir(path: string, signal?: AbortSignal): Promise<void>;
  rmdir(path: string, signal?: AbortSignal): Promise<void>;
  unlink(path: string, signal?: AbortSignal): Promise<void>;
  rename(from: string, to: string, signal?: AbortSignal): Promise<void>;
  posixRename(from: string, to: string, signal?: AbortSignal): Promise<void>;
  realpath(path: string, signal?: AbortSignal): Promise<string>;
}

/** `w` truncates or creates; `wx` fails when the path already exists, on the server. */
export type SftpWriteFlags = 'w' | 'wx';

export interface SftpReadRange {
  readonly start?: number | undefined;
  /** Inclusive, as `ssh2` wants it. */
  readonly end?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface SftpApi extends SftpRequests {
  writeAll(
    path: string,
    data: Uint8Array,
    flags: SftpWriteFlags,
    signal?: AbortSignal,
  ): Promise<void>;
  /** `copy-data`. Throws `Unsupported` when the server did not announce it. */
  copyData(from: string, to: string, flags: SftpWriteFlags, signal?: AbortSignal): Promise<void>;
  openReadStream(path: string, range?: SftpReadRange): Promise<ReadableStream<Uint8Array>>;
  openWriteStream(
    path: string,
    flags: SftpWriteFlags,
    signal?: AbortSignal,
  ): Promise<WritableStream<Uint8Array>>;
}

export interface SftpConnection extends SftpApi {
  isAlive(): boolean;
  close(): Promise<void>;
}

/** How the file system opens a session. Replaced by a fake in the hermetic tests. */
export type OpenSession = (options: SftpSessionOptions) => Promise<SftpConnection>;

export interface SftpSessionOptions {
  readonly settings: SftpSettings;
  /** Already resolved by the caller, so the session never sees `ProviderContext`. */
  readonly secret: Readonly<Record<string, unknown>>;
  readonly logger: Logger;
  readonly signal?: AbortSignal | undefined;
}

/**
 * One SSH connection and one SFTP channel.
 *
 * Everything callback-shaped about `ssh2` stops here: above this class the
 * provider is plain `async` code over `SftpApi`, which is what lets the
 * hermetic tests replace one small interface instead of a network library.
 *
 * `AbortSignal` is honoured as a race. SFTP has no cancel on the wire, so an
 * aborted request is *abandoned*: this class stops waiting and reports
 * `Cancelled`, and the server's eventual answer settles nothing. A mutation
 * already in flight may still land. That is inherent, not an oversight — the
 * alternative is tearing down the connection, which would cancel every other
 * operation sharing it.
 */
export class SftpSession implements SftpConnection {
  readonly extensions: SftpExtensions;

  readonly #sftp: SFTPWrapper;
  readonly #logger: Logger;
  readonly #client: Client | undefined;
  #alive = true;

  /** `client` is absent in tests, which construct a session over a fake channel. */
  constructor(sftp: SFTPWrapper, extensions: SftpExtensions, logger: Logger, client?: Client) {
    this.#sftp = sftp;
    this.extensions = extensions;
    this.#logger = logger;
    this.#client = client;
  }

  static async open(options: SftpSessionOptions): Promise<SftpSession> {
    const { settings, secret, logger, signal } = options;

    // Hoisted so the catch can reach it. Inside the try it is narrowed through
    // `connection`, a `const` the closures below can see through — a `let` this
    // one captures would lose its narrowing in every callback.
    let client: Client | undefined;

    try {
      const knownHosts = await readKnownHosts(settings.knownHostsPath);
      const auth = await buildAuth(settings, secret);
      const connection = new Client();
      client = connection;
      // Initialised explicitly so `prefer-const` sees the assignment below as a
      // reassignment. `const` at that assignment is not an option: the
      // listeners registered here close over `session` before it exists, and a
      // `const` declared later would make them throw a TDZ `ReferenceError`
      // from inside the very handler that exists to keep an `error` event from
      // being fatal.
      let session: SftpSession | undefined = undefined;
      let refusal: OmniFsError | undefined;

      // Registered before `connect` and never removed. A connection that drops
      // emits `error` on the client, and an `error` event with no listener is
      // fatal to the host process — in VS Code, the whole extension host. The
      // temporary listener inside the promise below is what rejects the connect;
      // this one exists so there is no instant where nothing is listening, and
      // it is also how `isAlive` learns to stop claiming the session is usable.
      connection.on('error', (error: Error) => {
        if (session !== undefined) session.#markDead(error);
      });
      connection.on('close', () => {
        if (session !== undefined) session.#markDead();
      });

      const config: ConnectConfig = {
        host: settings.host,
        port: settings.port,
        username: settings.username,
        ...auth,
        hostVerifier: (key: Buffer): boolean => {
          const verdict = verifyHostKey(knownHosts, settings.host, settings.port, key);
          if (verdict === 'mismatch') {
            refusal = new OmniFsError({
              code: 'AuthenticationFailed',
              message: `Host key for ${settings.host} does not match known_hosts. Offered ${fingerprint(key)}. Refusing to connect.`,
              providerId: 'sftp',
            });
            return false;
          }
          if (verdict === 'unknown') {
            logger.log('info', 'Accepting an SFTP host key that known_hosts has never seen', {
              host: settings.host,
              port: settings.port,
              fingerprint: fingerprint(key),
            });
          }
          return true;
        },
      };

      await new Promise<void>((resolve, reject) => {
        const settle = (error?: unknown): void => {
          connection.removeListener('ready', onReady);
          connection.removeListener('error', onError);
          signal?.removeEventListener('abort', onAbort);
          if (error === undefined) resolve();
          else reject(error);
        };
        const onReady = (): void => settle();
        const onError = (error: Error): void => settle(refusal ?? error);
        const onAbort = (): void => {
          connection.end();
          settle(cancelled(`SFTP connect to ${settings.host}`));
        };

        connection.once('ready', onReady);
        connection.once('error', onError);
        signal?.addEventListener('abort', onAbort, { once: true });
        connection.connect(config);
      });

      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        connection.sftp((error, channel) => (error ? reject(error) : resolve(channel)));
      });

      // The abort listener only covered the connect race. Without this check an
      // abort during the channel open hands a live session to a caller that has
      // already cancelled, and the connection leaks the moment they discard it.
      if (signal?.aborted === true) {
        throw cancelled(`SFTP connect to ${settings.host}`);
      }

      session = new SftpSession(sftp, detectExtensions(sftp), logger, connection);

      logger.log('info', 'SFTP session opened', {
        host: settings.host,
        port: settings.port,
        extensions: session.extensions,
      });

      return session;
    } catch (error) {
      // Nothing above returned, so no caller holds this connection — end it, or
      // an authenticated socket survives with nothing able to close it. A server
      // that refuses the sftp subsystem is the case that leaves it alive.
      try {
        client?.end();
      } catch {
        // The connection is already gone; there is nothing left to close.
      }
      throw toOmniFsError(error, settings.host);
    }
  }

  isAlive(): boolean {
    return this.#alive;
  }

  async close(): Promise<void> {
    const client = this.#client;
    const wasAlive = this.#alive;
    this.#alive = false;
    if (client === undefined) return;
    if (!wasAlive) {
      client.end();
      return;
    }
    await new Promise<void>((resolve) => {
      client.once('close', () => resolve());
      client.end();
    });
  }

  async stat(path: string, signal?: AbortSignal): Promise<SftpAttrs> {
    return toAttrs(await this.#request<Stats>(signal, (cb) => this.#sftp.stat(path, cb)));
  }

  async lstat(path: string, signal?: AbortSignal): Promise<SftpAttrs> {
    return toAttrs(await this.#request<Stats>(signal, (cb) => this.#sftp.lstat(path, cb)));
  }

  async readdir(path: string, signal?: AbortSignal): Promise<readonly SftpEntry[]> {
    const list = await this.#request<FileEntryWithStats[]>(signal, (cb) =>
      this.#sftp.readdir(path, cb),
    );
    return list.map((entry) => ({ filename: entry.filename, attrs: toAttrs(entry.attrs) }));
  }

  async mkdir(path: string, signal?: AbortSignal): Promise<void> {
    await this.#request<void>(signal, (cb) => this.#sftp.mkdir(path, cb));
  }

  async rmdir(path: string, signal?: AbortSignal): Promise<void> {
    await this.#request<void>(signal, (cb) => this.#sftp.rmdir(path, cb));
  }

  async unlink(path: string, signal?: AbortSignal): Promise<void> {
    await this.#request<void>(signal, (cb) => this.#sftp.unlink(path, cb));
  }

  async rename(from: string, to: string, signal?: AbortSignal): Promise<void> {
    await this.#request<void>(signal, (cb) => this.#sftp.rename(from, to, cb));
  }

  /** `posix-rename@openssh.com`: replaces the destination instead of failing on it. */
  async posixRename(from: string, to: string, signal?: AbortSignal): Promise<void> {
    await this.#request<void>(signal, (cb) => this.#sftp.ext_openssh_rename(from, to, cb));
  }

  async realpath(path: string, signal?: AbortSignal): Promise<string> {
    return this.#request<string>(signal, (cb) => this.#sftp.realpath(path, cb));
  }

  /**
   * Open, write, flush, close.
   *
   * `ssh2` chunks a buffer larger than the negotiated maximum itself and calls
   * back once at the end (`lib/protocol/SFTP.js:446`), so the whole payload goes
   * in one call. The first failure wins: a write error is reported even when the
   * close that follows also fails, because the write is the one the caller asked
   * about.
   */
  async writeAll(
    path: string,
    data: Uint8Array,
    flags: SftpWriteFlags,
    signal?: AbortSignal,
  ): Promise<void> {
    const handle = await this.#open(path, flags, signal);
    let failure: unknown;

    try {
      if (data.byteLength > 0) {
        const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        await this.#request<void>(signal, (cb) =>
          this.#sftp.write(handle, buffer, 0, buffer.byteLength, 0, cb),
        );
      }
      await this.#flush(handle, signal);
    } catch (error) {
      failure = error;
    }

    try {
      await this.#closeHandle(handle);
    } catch (error) {
      failure ??= error;
    }

    if (failure !== undefined) throw failure;
  }

  /**
   * `copy-data`: the server reads from one handle and writes to another, so the
   * bytes never cross the client. `len: 0` means "until EOF" (`ssh2`'s
   * `SFTP.md`).
   */
  async copyData(
    from: string,
    to: string,
    flags: SftpWriteFlags,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.extensions.copyData) {
      throw OmniFsError.unsupported('server-side copy', 'sftp');
    }

    const source = await this.#open(from, 'r', signal);
    try {
      const target = await this.#open(to, flags, signal);
      try {
        await this.#request<void>(signal, (cb) =>
          this.#sftp.ext_copy_data(source, 0, 0, target, 0, cb),
        );
        await this.#flush(target, signal);
      } finally {
        await this.#closeHandle(target);
      }
    } finally {
      await this.#closeHandle(source);
    }
  }

  /**
   * A Node read stream translated to a web one. Errors arrive late — the library
   * returns the stream before the request is answered — so a missing file
   * surfaces as an error event, which the file system layer translates.
   * Aborting destroys the stream with an `AbortError`, which is real
   * cancellation rather than the abandonment a request-shaped call has to settle
   * for.
   */
  async openReadStream(path: string, range?: SftpReadRange): Promise<ReadableStream<Uint8Array>> {
    if (range?.signal?.aborted === true) throw cancelled(path);

    const stream = this.#sftp.createReadStream(path, {
      ...(range?.start !== undefined ? { start: range.start } : {}),
      ...(range?.end !== undefined ? { end: range.end } : {}),
    });

    range?.signal?.addEventListener(
      'abort',
      () => stream.destroy(Object.assign(new Error(`Aborted: ${path}`), { name: 'AbortError' })),
      { once: true },
    );

    return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  }

  /**
   * A streamed write whose `close()` means the bytes are on the server.
   *
   * The handle is opened here rather than by `createWriteStream`, and passed in
   * with `autoClose: false`, so this class controls the end of the transfer:
   * finish the stream, `fsync` where the server offers it, then close the
   * handle. Each step's failure rejects `close()`.
   *
   * `onProgress` is not reported and cannot be: the caller is the one feeding
   * the stream, so it already knows how many bytes it has handed over.
   */
  async openWriteStream(
    path: string,
    flags: SftpWriteFlags,
    signal?: AbortSignal,
  ): Promise<WritableStream<Uint8Array>> {
    const handle = await this.#open(path, flags, signal);
    const stream: Writable = this.#sftp.createWriteStream(path, { handle, autoClose: false });

    return new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await new Promise<void>((resolve, reject) => {
          stream.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), (error) =>
            error === undefined || error === null ? resolve() : reject(error),
          );
        });
      },
      close: async () => {
        await new Promise<void>((resolve, reject) => {
          stream.once('error', reject);
          stream.end(() => resolve());
        });
        await this.#flush(handle, signal);
        await this.#closeHandle(handle);
      },
      abort: async () => {
        stream.destroy();
        await this.#closeHandle(handle).catch(() => undefined);
      },
    });
  }

  async #open(path: string, flags: SftpWriteFlags | 'r', signal?: AbortSignal): Promise<Buffer> {
    return this.#request<Buffer>(signal, (cb) => this.#sftp.open(path, flags, cb));
  }

  /** `fsync@openssh.com` where the server has it, and nothing where it does not. */
  async #flush(handle: Buffer, signal?: AbortSignal): Promise<void> {
    if (!this.extensions.fsync) return;
    await this.#request<void>(signal, (cb) => this.#sftp.ext_openssh_fsync(handle, cb));
  }

  /**
   * Closes a handle without a signal, deliberately: a close skipped because the
   * caller aborted would leak the handle for the life of the connection, and the
   * server has already done the work.
   */
  async #closeHandle(handle: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#sftp.close(handle, (error) =>
        error === undefined || error === null ? resolve() : reject(error),
      );
    });
  }

  #markDead(error?: Error): void {
    this.#alive = false;
    if (error !== undefined) {
      this.#logger.log('warn', 'SFTP connection failed', { message: error.message });
    }
  }

  /**
   * One request, one abort race. `settled` is what makes the abandoned reply
   * harmless: the server's callback arrives after the rejection and finds the
   * promise already settled, so it does nothing rather than throwing into a
   * dead handler.
   */
  async #request<T>(
    signal: AbortSignal | undefined,
    body: (callback: (error: unknown, value?: T) => void) => void,
  ): Promise<T> {
    if (signal?.aborted === true) throw cancelled('SFTP request');

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        reject(cancelled('SFTP request'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      body((error, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        if (error !== undefined && error !== null) reject(error);
        else resolve(value as T);
      });
    });
  }
}

/**
 * Which OpenSSH extensions the connected server announced.
 *
 * `ssh2` records them at version exchange on a private field, so this is one
 * narrow, named cast rather than a guess. Its failure mode is benign: an
 * unexpected shape reads as no extensions, which costs a server-side copy and a
 * durable flush and changes nothing about correctness. `ext_copy_data` and
 * `ext_openssh_fsync` also throw synchronously when the extension is missing,
 * which is the backstop if this ever reads wrong.
 */
export function detectExtensions(sftp: SFTPWrapper): SftpExtensions {
  const announced = (sftp as unknown as { _extensions?: Readonly<Record<string, string>> })
    ._extensions;
  const has = (name: string): boolean => announced?.[name] === '1';
  return {
    posixRename: has('posix-rename@openssh.com'),
    fsync: has('fsync@openssh.com'),
    copyData: has('copy-data'),
  };
}

/**
 * `Cancelled`, built inline for the same reason `errors.ts` does: the
 * `OmniFsError.cancelled` factory carries no `providerId`, so a caller
 * filtering by provider cannot attribute what it dropped.
 */
function cancelled(operation: string): OmniFsError {
  return new OmniFsError({
    code: 'Cancelled',
    message: `Cancelled: ${operation}`,
    providerId: 'sftp',
  });
}

function toAttrs(stats: Stats): SftpAttrs {
  return {
    mode: stats.mode,
    size: stats.size,
    mtime: stats.mtime,
    uid: stats.uid,
    gid: stats.gid,
  };
}
