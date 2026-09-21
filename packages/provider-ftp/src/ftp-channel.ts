import { PassThrough, Readable, Writable } from 'node:stream';
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
const LEGACY_CIPHERS = 'DEFAULT@SECLEVEL=0';
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

/**
 * The part of `basic-ftp`'s `Client` this package uses, declared structurally
 * so the hermetic tests can supply one without a socket. `Client` satisfies it
 * as written, which `ftp-channel.test.ts` asserts by assignment.
 */
export interface FtpClientLike {
  readonly closed: boolean;
  close(): void;
  access(options: AccessOptionsLike): Promise<unknown>;
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
export function buildAccessOptions(settings: FtpSettings, password: string): AccessOptionsLike {
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
  if (relaxesCipherPolicy(settings.tlsMinVersion)) secureOptions.ciphers = LEGACY_CIPHERS;

  return { ...base, secure: settings.secure === 'implicit' ? 'implicit' : true, secureOptions };
}

export function relaxesCipherPolicy(version: FtpTlsMinVersion): boolean {
  return RELAXED_VERSIONS.includes(version);
}

export class FtpControlChannel implements FtpChannel {
  readonly hasMlst: boolean;

  readonly #client: FtpClientLike;
  readonly #logger: Logger;
  #poisoned = false;

  private constructor(client: FtpClientLike, hasMlst: boolean, logger: Logger) {
    this.#client = client;
    this.hasMlst = hasMlst;
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
    try {
      await withCancellation(client.access(buildAccessOptions(settings, password)), signal, target);
      // `basic-ftp` reads FEAT during access for its own MLSD decision but does
      // not expose the map, so it is asked for once more here and cached for
      // the life of the channel. One extra round trip at login, never again.
      const features = await client.features();

      if (relaxesCipherPolicy(settings.tlsMinVersion)) {
        logger.log('warn', 'FTP TLS cipher policy relaxed for a legacy server', {
          host: settings.host,
          tlsMinVersion: settings.tlsMinVersion,
        });
      }

      return new FtpControlChannel(client, features.has('MLST'), logger);
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
    const response = await this.#run(() => this.#client.send(`MLST ${path}`), path, signal);
    return parseMlstResponse(response.message);
  }

  async list(path: string, signal?: AbortSignal): Promise<readonly FtpEntry[]> {
    const infos = await this.#run(() => this.#client.list(path), path, signal);
    return infos
      .map(fromFileInfo)
      .filter((entry) => entry.name !== '.' && entry.name !== '..' && entry.name !== '');
  }

  async mkdir(path: string, signal?: AbortSignal): Promise<void> {
    await this.#run(() => this.#client.send(`MKD ${path}`), path, signal);
  }

  async rmdir(path: string, signal?: AbortSignal): Promise<void> {
    await this.#run(() => this.#client.removeEmptyDir(path), path, signal);
  }

  async unlink(path: string, signal?: AbortSignal): Promise<void> {
    await this.#run(() => this.#client.remove(path), path, signal);
  }

  async rename(from: string, to: string, signal?: AbortSignal): Promise<void> {
    await this.#run(() => this.#client.rename(from, to), from, signal);
  }

  async openReadStream(
    path: string,
    range?: FtpReadRange,
    options?: FtpTransferOptions,
  ): Promise<ReadableStream<Uint8Array>> {
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
        if (settled) {
          callback();
          return;
        }
        const remaining = limit === undefined ? chunk.length : limit - seen;
        const slice = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
        seen += slice.length;
        pass.write(slice);
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
        }
        callback();
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
    // `Readable.from(buffer)` iterates a Buffer *byte by byte*, so the array
    // wrapper is load-bearing rather than stylistic.
    const source = Readable.from([Buffer.from(data.buffer, data.byteOffset, data.byteLength)]);
    await this.#run(() => this.#client.uploadFrom(source, path), path, options?.signal);
    options?.onProgress?.(data.byteLength);
  }

  async openWriteStream(
    path: string,
    options?: FtpTransferOptions,
  ): Promise<WritableStream<Uint8Array>> {
    throwIfAborted(options?.signal, path);

    const pass = new PassThrough();
    const done = this.#run(() => this.#client.uploadFrom(pass, path), path, options?.signal);
    // The rejection is awaited by close(); this keeps it from being an
    // unhandled rejection in the window before that happens.
    done.catch(() => undefined);

    let written = 0;
    return new WritableStream<Uint8Array>({
      write: (chunk) =>
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
