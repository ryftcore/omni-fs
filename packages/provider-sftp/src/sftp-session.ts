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
export class SftpSession implements SftpRequests {
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

    try {
      const knownHosts = await readKnownHosts(settings.knownHostsPath);
      const auth = await buildAuth(settings, secret);
      const client = new Client();
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
      client.on('error', (error: Error) => {
        if (session !== undefined) session.#markDead(error);
      });
      client.on('close', () => {
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
          client.removeListener('ready', onReady);
          client.removeListener('error', onError);
          signal?.removeEventListener('abort', onAbort);
          if (error === undefined) resolve();
          else reject(error);
        };
        const onReady = (): void => settle();
        const onError = (error: Error): void => settle(refusal ?? error);
        const onAbort = (): void => {
          client.end();
          settle(OmniFsError.cancelled(`SFTP connect to ${settings.host}`));
        };

        client.once('ready', onReady);
        client.once('error', onError);
        signal?.addEventListener('abort', onAbort, { once: true });
        client.connect(config);
      });

      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((error, channel) => (error ? reject(error) : resolve(channel)));
      });

      session = new SftpSession(sftp, detectExtensions(sftp), logger, client);

      logger.log('info', 'SFTP session opened', {
        host: settings.host,
        port: settings.port,
        extensions: session.extensions,
      });

      return session;
    } catch (error) {
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
    if (signal?.aborted === true) throw OmniFsError.cancelled('SFTP request');

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        reject(OmniFsError.cancelled('SFTP request'));
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

function toAttrs(stats: Stats): SftpAttrs {
  return {
    mode: stats.mode,
    size: stats.size,
    mtime: stats.mtime,
    uid: stats.uid,
    gid: stats.gid,
  };
}
