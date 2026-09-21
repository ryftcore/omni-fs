import { PassThrough, Readable, Writable } from 'node:stream';
import { createSecureContext } from 'node:tls';
import { Client } from 'basic-ftp';
import { OmniFsError, throwIfAborted, withCancellation } from '@omni-fs/core';
import type { Logger, OmniFsErrorCode } from '@omni-fs/core';
import { toOmniFsError } from './errors.js';
import { fromFileInfo, parseMlstResponse } from './ftp-helpers.js';
import type { FileInfoLike, FtpEntry, FtpReadRange } from './ftp-helpers.js';
import type { FtpSettings, FtpTlsMinVersion } from './settings.js';

/** Socket inactivity, not total transfer time — `basic-ftp`'s own meaning. */
const CONTROL_TIMEOUT_MS = 30_000;

/**
 * OpenSSL 3 refuses the key sizes and signature algorithms a 2012-era FTPS
 * server offers, whatever protocol version is negotiated. Lowering the floor
 * without this would be a setting the user configures correctly and which still
 * fails. See spec decision 8.
 */
export const LEGACY_CIPHERS = 'DEFAULT@SECLEVEL=0';
const RELAXED_VERSIONS: readonly FtpTlsMinVersion[] = ['TLSv1', 'TLSv1.1'];

/**
 * Failures that mean the control channel can no longer be trusted. An ordinary
 * server refusal — a 550, a 553 — says nothing about the connection and leaves
 * it usable, which is the difference that keeps the pool from churning.
 */
const POISONING_CODES: ReadonlySet<OmniFsErrorCode> = new Set([
  'Cancelled',
  'ConnectionFailed',
  'Timeout',
  'ProtocolError',
]);

/**
 * Characters that would end a command early. FTP commands are CRLF-terminated
 * and `basic-ftp` hands the string to the socket unchanged — `send` is
 * `ftp.request(command)` with no sanitisation, and its own `remove`, `rename`,
 * `list` and `removeEmptyDir` interpolate a path into `DELE`/`RNFR`/`LIST`/`RMD`
 * the same way. `RemotePath` does not reject control characters, so a path
 * carrying `\r\n` would inject a second command onto the control channel.
 *
 * This file is the only place that can defend it, so every path is checked here
 * before it reaches the client — not only the two commands built with a
 * template literal.
 */
const COMMAND_UNSAFE = /[\r\n\0]/;

/**
 * Refused rather than stripped. Silently rewriting the caller's path would
 * turn an injection attempt into an operation on a *different* file, which is
 * its own surprise and a worse one to debug.
 */
function assertCommandSafe(path: string): void {
  if (COMMAND_UNSAFE.test(path)) {
    throw new OmniFsError({
      code: 'ProtocolError',
      message: 'FTP path contains a carriage return, line feed or NUL byte.',
      providerId: 'ftp',
      path,
    });
  }
}

export interface FtpTransferOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((transferred: number) => void) | undefined;
}

/**
 * One control connection, as the rest of the package sees it.
 *
 * Every path is absolute. No method changes the working directory, which is
 * what makes a pooled channel interchangeable — and why `basic-ftp`'s
 * `ensureDir` and `removeDir`, both built on `CWD`, are not used.
 */
export interface FtpChannel {
  /** Whether the server advertised `MLST` in `FEAT`. Decides how `stat` works. */
  readonly hasMlst: boolean;
  /** What the login negotiated, for the log. Never consulted for behaviour. */
  readonly session: FtpSessionInfo;
  /** Set when the control channel was abandoned mid-command. Never unset. */
  readonly poisoned: boolean;
  isAlive(): boolean;
  poison(): void;
  close(): Promise<void>;

  pwd(signal?: AbortSignal): Promise<string>;
  mlst(path: string, signal?: AbortSignal): Promise<FtpEntry | undefined>;
  list(path: string, signal?: AbortSignal): Promise<readonly FtpEntry[]>;
  mkdir(path: string, signal?: AbortSignal): Promise<void>;
  rmdir(path: string, signal?: AbortSignal): Promise<void>;
  unlink(path: string, signal?: AbortSignal): Promise<void>;
  rename(from: string, to: string, signal?: AbortSignal): Promise<void>;

  openReadStream(
    path: string,
    range?: FtpReadRange,
    options?: FtpTransferOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  upload(path: string, data: Uint8Array, options?: FtpTransferOptions): Promise<void>;
  openWriteStream(path: string, options?: FtpTransferOptions): Promise<WritableStream<Uint8Array>>;
}

export interface FtpSessionInfo {
  /** The first line of the server's 220 greeting, e.g. `220 Microsoft FTP Service`. */
  readonly greeting: string | undefined;
  /** e.g. `TLSv1.3`. Undefined for a plain control channel. */
  readonly tlsProtocol: string | undefined;
  /** OpenSSL's cipher name, e.g. `ECDHE-RSA-AES256-SHA`. */
  readonly tlsCipher: string | undefined;
}

/**
 * `basic-ftp`'s `FtpContext`: the control socket, and the one function every
 * line of the library's own protocol log goes through. `log` is written, not
 * called — replacing it is how that log reaches ours instead of `console`.
 */
export interface FtpContextLike {
  readonly socket: unknown;
  log: (message: string) => void;
}

/**
 * The part of `basic-ftp`'s `Client` this package uses, declared structurally
 * so the hermetic tests can supply one without a socket. `Client` satisfies it
 * as written, which `ftp-channel.test.ts` asserts by assignment.
 */
export interface FtpClientLike {
  readonly closed: boolean;
  /** Optional so a test fake without a socket still satisfies the interface. */
  readonly ftp?: FtpContextLike;
  close(): void;
  access(options: AccessOptionsLike): Promise<{ readonly message: string }>;
  features(): Promise<Map<string, string>>;
  pwd(): Promise<string>;
  send(command: string): Promise<{ readonly code: number; readonly message: string }>;
  list(path: string): Promise<readonly FileInfoLike[]>;
  downloadTo(destination: Writable, path: string, startAt?: number): Promise<unknown>;
  uploadFrom(source: Readable, path: string): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  remove(path: string): Promise<unknown>;
  removeEmptyDir(path: string): Promise<unknown>;
  trackProgress(handler?: (info: { readonly bytesOverall: number }) => void): void;
}

export interface SecureOptionsLike {
  rejectUnauthorized?: boolean;
  /** Exactly Node's `SecureVersion`, which is `FtpTlsMinVersion` without `auto`. */
  minVersion?: Exclude<FtpTlsMinVersion, 'auto'>;
  ciphers?: string;
}

/**
 * `basic-ftp`'s `AccessOptions` with every field required and `secureOptions`
 * narrowed to what this package sets.
 *
 * The optional property is written without `| undefined` on purpose:
 * `AccessOptions.secureOptions` is declared `secureOptions?: TLSConnectionOptions`,
 * and under `exactOptionalPropertyTypes` a property that may *hold* `undefined`
 * is not assignable to one that may only be *absent*. Plain FTP therefore omits
 * the key rather than setting it to `undefined`.
 */
export interface AccessOptionsLike {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly secure: boolean | 'implicit';
  readonly secureOptions?: SecureOptionsLike;
}

export interface FtpChannelOptions {
  readonly settings: FtpSettings;
  /** Already resolved by the caller, so the channel never sees `ProviderContext`. */
  readonly secret: Readonly<Record<string, unknown>>;
  readonly logger: Logger;
  readonly signal?: AbortSignal | undefined;
  /** The seam the hermetic tests replace. Production never passes it. */
  readonly createClient?: (() => FtpClientLike) | undefined;
}

export type OpenChannel = (options: FtpChannelOptions) => Promise<FtpChannel>;

/**
 * `secureOptions` reaches both ends of the connection: `basic-ftp` keeps it as
 * `ftp.tlsOptions` and spreads it into every data connection's `tls.connect`
 * (`transfer.js:128`). That is why the TLS floor is set here once rather than
 * per transfer — a mismatch would fail the data connection rather than the
 * login, which is a far worse error to be handed.
 */
export function buildAccessOptions(
  settings: FtpSettings,
  password: string,
  securityLevels: boolean = hasSecurityLevels(),
): AccessOptionsLike {
  const base = {
    host: settings.host,
    port: settings.port,
    user: settings.username,
    password,
  } as const;

  if (settings.secure === 'none') return { ...base, secure: false };

  const secureOptions: SecureOptionsLike = {};
  if (settings.allowSelfSigned) secureOptions.rejectUnauthorized = false;
  if (settings.tlsMinVersion !== 'auto') secureOptions.minVersion = settings.tlsMinVersion;
  if (securityLevels && relaxesCipherPolicy(settings.tlsMinVersion)) {
    secureOptions.ciphers = LEGACY_CIPHERS;
  }

  return { ...base, secure: settings.secure === 'implicit' ? 'implicit' : true, secureOptions };
}

let securityLevelsSupported: boolean | undefined;

/**
 * Whether the TLS library understands `@SECLEVEL`. OpenSSL does; BoringSSL —
 * what Electron, and therefore VS Code, links instead — has no security levels
 * and refuses the whole cipher string with `ERR_SSL_INVALID_COMMAND`, so
 * passing it there turns the legacy setting into a connection that can never
 * open. Asked of the library rather than inferred from the host, because it is
 * the library that decides.
 */
export function hasSecurityLevels(): boolean {
  if (securityLevelsSupported === undefined) {
    try {
      createSecureContext({ ciphers: LEGACY_CIPHERS });
      securityLevelsSupported = true;
    } catch {
      securityLevelsSupported = false;
    }
  }
  return securityLevelsSupported;
}

export function relaxesCipherPolicy(version: FtpTlsMinVersion): boolean {
  return RELAXED_VERSIONS.includes(version);
}

export class FtpControlChannel implements FtpChannel {
  readonly hasMlst: boolean;
  readonly session: FtpSessionInfo;

  readonly #client: FtpClientLike;
  readonly #logger: Logger;
  #poisoned = false;

  private constructor(
    client: FtpClientLike,
    hasMlst: boolean,
    session: FtpSessionInfo,
    logger: Logger,
  ) {
    this.#client = client;
    this.hasMlst = hasMlst;
    this.session = session;
    this.#logger = logger;
  }

  static async open(options: FtpChannelOptions): Promise<FtpControlChannel> {
    const { settings, secret, logger, signal } = options;
    const target = `ftp://${settings.host}:${settings.port}`;

    const password = secret['password'];
    if (typeof password !== 'string' || password === '') {
      throw new OmniFsError({
        code: 'AuthenticationFailed',
        message: 'FTP connection has no password.',
        providerId: 'ftp',
        path: target,
      });
    }

    const client = (options.createClient ?? (() => new Client(CONTROL_TIMEOUT_MS)))();
    routeProtocolLog(client, logger);
    try {
      const welcome = await withCancellation(
        client.access(buildAccessOptions(settings, password)),
        signal,
        target,
      );
      // `basic-ftp` reads FEAT during access for its own MLSD decision but does
      // not expose the map, so it is asked for once more here and cached for
      // the life of the channel. One extra round trip at login, never again.
      const features = await client.features();

      const session = describeSession(client, welcome.message);
      logger.log('debug', 'FTP channel opened', {
        tls: session.tlsProtocol ?? 'none',
        mlst: features.has('MLST'),
      });
      return new FtpControlChannel(client, features.has('MLST'), session, logger);
    } catch (error) {
      client.close();
      throw toOmniFsError(error, target);
    }
  }

  get poisoned(): boolean {
    return this.#poisoned;
  }

  isAlive(): boolean {
    return !this.#poisoned && !this.#client.closed;
  }

  /**
   * Gives up on this connection. Closing the socket is what makes an abandoned
   * command actually stop, and what stops the pool handing this channel to
   * someone who would read the previous command's reply as their own.
   */
  poison(): void {
    if (this.#poisoned) return;
    this.#poisoned = true;
    this.#client.close();
  }

  async close(): Promise<void> {
    this.#client.close();
  }

  async pwd(signal?: AbortSignal): Promise<string> {
    return this.#run(() => this.#client.pwd(), 'PWD', signal);
  }

  async mlst(path: string, signal?: AbortSignal): Promise<FtpEntry | undefined> {
    assertCommandSafe(path);
    const response = await this.#run(() => this.#client.send(`MLST ${path}`), path, signal);
    return parseMlstResponse(response.message);
  }

  async list(path: string, signal?: AbortSignal): Promise<readonly FtpEntry[]> {
    assertCommandSafe(path);
    const infos = await this.#run(() => this.#client.list(path), path, signal);
    return infos
      .map(fromFileInfo)
      .filter((entry) => entry.name !== '.' && entry.name !== '..' && entry.name !== '');
  }

  async mkdir(path: string, signal?: AbortSignal): Promise<void> {
    assertCommandSafe(path);
    await this.#run(() => this.#client.send(`MKD ${path}`), path, signal);
  }

  async rmdir(path: string, signal?: AbortSignal): Promise<void> {
    assertCommandSafe(path);
    await this.#run(() => this.#client.removeEmptyDir(path), path, signal);
  }

  async unlink(path: string, signal?: AbortSignal): Promise<void> {
    assertCommandSafe(path);
    await this.#run(() => this.#client.remove(path), path, signal);
  }

  async rename(from: string, to: string, signal?: AbortSignal): Promise<void> {
    assertCommandSafe(from);
    assertCommandSafe(to);
    await this.#run(() => this.#client.rename(from, to), from, signal);
  }

  async openReadStream(
    path: string,
    range?: FtpReadRange,
    options?: FtpTransferOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    assertCommandSafe(path);
    throwIfAborted(options?.signal, path);

    const limit = range?.length;
    const pass = new PassThrough();
    let seen = 0;
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error === undefined) pass.end();
      else pass.destroy(error);
    };

    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        // `settled` is our own teardown; `pass.destroyed` is the consumer's —
        // `ReadableStream.cancel()` destroys the PassThrough directly, without
        // going through `finish`. Either way there is nowhere left to put the
        // bytes, and arming a `drain`/`close` listener below on a stream that
        // can no longer emit either would strand this callback and hang
        // `basic-ftp` until its control timeout. Reading `destroyed` rather
        // than waiting for `close` also closes the window between the two,
        // since `destroy()` sets the flag now and emits the event a tick later.
        if (settled || pass.destroyed) {
          callback();
          return;
        }
        // `limit - seen`, not `limit`: the budget is spent across every chunk
        // of the transfer, not renewed for each one.
        const remaining = limit === undefined ? chunk.length : limit - seen;
        const slice = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
        seen += slice.length;
        const ready = pass.write(slice);
        options?.onProgress?.(seen);

        if (limit !== undefined && seen >= limit) {
          // The protocol has no end-of-range, so the only way to stop a RETR
          // early is to tear the transfer down — which leaves the control
          // channel mid-command. ABOR would need the out-of-band IP/SYNCH
          // sequence that `basic-ftp` does not implement, and servers disagree
          // about the reply order afterwards, so the recovery path would end
          // here anyway. Spec decision 6.
          finish();
          this.poison();
          callback();
          return;
        }

        if (ready) {
          callback();
          return;
        }

        // Back-pressure. `pass.write` returning false means the consumer of the
        // web stream is behind; holding this callback is what makes `basic-ftp`
        // stop reading its data socket, and what stops a slow reader on a large
        // file buffering the whole transfer in memory. `close` is listened for
        // as well as `drain`, so a stream that ends or is destroyed while the
        // download waits releases it rather than stalling the transfer forever.
        const release = (): void => {
          pass.off('drain', release);
          pass.off('close', release);
          callback();
        };
        pass.once('drain', release);
        pass.once('close', release);
      },
    });

    const onAbort = (): void => {
      this.poison();
      finish(toOmniFsError(new DOMException('Aborted', 'AbortError'), path));
    };
    options?.signal?.addEventListener('abort', onAbort, { once: true });

    void this.#client
      .downloadTo(sink, path, range?.start ?? 0)
      .then(() => finish())
      .catch((error: unknown) => finish(toOmniFsError(error, path)))
      .finally(() => options?.signal?.removeEventListener('abort', onAbort));

    return Readable.toWeb(pass) as ReadableStream<Uint8Array>;
  }

  async upload(path: string, data: Uint8Array, options?: FtpTransferOptions): Promise<void> {
    assertCommandSafe(path);
    // The `Buffer.from` is the load-bearing part, not the array around it.
    // `Readable.from` special-cases Buffer and string and pushes the whole
    // value as one chunk; a bare `Uint8Array` is just an iterable of numbers,
    // so it would be yielded a byte at a time and the transfer would fail
    // loudly with `ERR_INVALID_ARG_TYPE` on the first chunk. The array wrapper
    // is belt and braces if the conversion is ever dropped.
    const source = Readable.from([Buffer.from(data.buffer, data.byteOffset, data.byteLength)]);
    await this.#run(() => this.#client.uploadFrom(source, path), path, options?.signal);
    options?.onProgress?.(data.byteLength);
  }

  async openWriteStream(
    path: string,
    options?: FtpTransferOptions,
  ): Promise<WritableStream<Uint8Array>> {
    assertCommandSafe(path);
    throwIfAborted(options?.signal, path);

    const pass = new PassThrough();
    // Destroying the source below emits `error`, and an `error` event with no
    // listener is an uncaught exception. The failure reaches the caller
    // through the WritableStream instead, so this one is deliberately silent.
    pass.on('error', () => undefined);

    const done = this.#run(() => this.#client.uploadFrom(pass, path), path, options?.signal);

    /**
     * A transfer that fails part-way has to reach whoever is *writing*, not
     * only whoever calls `close()`. `basic-ftp` stops reading the moment
     * `uploadFrom` rejects, the PassThrough fills to its 16 KB high-water
     * mark, and the pending `write()` callback is never called again — and
     * `destroy()` does not settle an already in-flight write callback either,
     * so tearing the stream down is not on its own enough. Every write
     * therefore races this, and an aborted `signal` travels the same path
     * because `#run` rejects `done`.
     */
    const failed = new Promise<never>((_resolve, reject) => {
      done.catch((error: unknown) => {
        const failure = toOmniFsError(error, path);
        // Still destroy it: that releases the buffered chunks and tells the
        // library its source is gone.
        pass.destroy(failure);
        reject(failure);
      });
    });
    // `close()` awaits `done` and `write()` races `failed`; these keep neither
    // from being an unhandled rejection in the window before that happens.
    done.catch(() => undefined);
    failed.catch(() => undefined);

    let written = 0;
    return new WritableStream<Uint8Array>({
      write: (chunk) =>
        Promise.race([
          new Promise<void>((resolve, reject) => {
            pass.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), (error) => {
              if (error !== undefined && error !== null) {
                reject(toOmniFsError(error, path));
                return;
              }
              written += chunk.byteLength;
              options?.onProgress?.(written);
              resolve();
            });
          }),
          failed,
        ]),
      close: async () => {
        pass.end();
        // The whole point: close() resolves when the *server* has accepted the
        // transfer, not when the last byte left this process.
        await done;
      },
      abort: async () => {
        pass.destroy();
        this.poison();
        await done.catch(() => undefined);
      },
    });
  }

  /**
   * `AbortSignal` is honoured as a race: FTP has no cancel on the wire, so an
   * aborted command is *abandoned*. This class stops waiting, reports
   * `Cancelled`, and poisons the channel — because the server's eventual reply
   * would otherwise be read as the answer to whatever command came next. A
   * mutation already in flight may still land. That is inherent, and wider than
   * SFTP's version of the same gap, which at least keeps its connection.
   */
  async #run<T>(body: () => Promise<T>, path: string, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal, path);
    try {
      return await withCancellation(body(), signal, path);
    } catch (error) {
      const translated = toOmniFsError(error, path);
      if (POISONING_CODES.has(translated.code)) {
        this.#logger.log('debug', 'FTP channel poisoned', { path, code: translated.code });
        this.poison();
      }
      throw translated;
    }
  }
}

/**
 * `basic-ftp` writes every command it sends (`> LIST /data`, with `PASS`
 * already masked by `FtpContext.send`), every reply it reads, and its TLS
 * decisions through `FtpContext.log` — to `console`, and only when `verbose`
 * is set. Pointing it at our logger at `trace` gives the equivalent of
 * FileZilla's message log, and the level filter decides whether anyone sees it.
 */
function routeProtocolLog(client: FtpClientLike, logger: Logger): void {
  if (client.ftp === undefined) return;
  client.ftp.log = (message) => {
    logger.log('trace', message.trimEnd());
  };
}

function describeSession(client: FtpClientLike, greeting: string): FtpSessionInfo {
  const socket = client.ftp?.socket as Partial<TlsSocketLike> | undefined;
  const protocol =
    typeof socket?.getProtocol === 'function' ? (socket.getProtocol() ?? undefined) : undefined;
  const cipher =
    typeof socket?.getCipher === 'function' ? (socket.getCipher()?.name ?? undefined) : undefined;
  return {
    greeting: greeting.split(/\r?\n/)[0]?.trim() || undefined,
    tlsProtocol: protocol,
    tlsCipher: cipher,
  };
}

/** The two `TLSSocket` methods read above; a plain `Socket` has neither. */
interface TlsSocketLike {
  getProtocol(): string | null;
  getCipher(): { readonly name: string } | undefined;
}
