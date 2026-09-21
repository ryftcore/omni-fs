import { OmniFsError } from '@omni-fs/core';
import type {
  DeleteOptions,
  DirEntry,
  FileStat,
  Logger,
  ProviderCapabilities,
  ProviderContext,
  ReadOptions,
  RemoteFileSystem,
  RemotePath,
  WriteOptions,
} from '@omni-fs/core';
import { toOmniFsError } from './errors.js';
import { FtpControlChannel } from './ftp-channel.js';
import type { FtpChannel, OpenChannel } from './ftp-channel.js';
import { joinRemote, resolveBase, toDirEntry, toFileStat } from './ftp-helpers.js';
import { FtpPool } from './ftp-pool.js';
import { readSettings } from './settings.js';
import type { FtpSettings } from './settings.js';

/**
 * What FTP can do, before a connection exists.
 *
 * `canDeleteRecursive` is `true` although no FTP command removes a tree: the
 * flag means "the provider handles a recursive delete when asked", which is how
 * `provider-s3` and `provider-sftp` already read it, and this provider walks.
 *
 * `maxConcurrency` is 1 here and answered per connection by the getter below.
 */
export const FTP_CAPABILITIES: ProviderCapabilities = {
  canWrite: true,
  canRename: true,
  canCopyServerSide: false,
  canCreateDirectory: true,
  canDeleteRecursive: true,
  canAppend: true,
  canReadRange: true,
  canStreamWrite: true,
  canWatch: false,
  hasRealDirectories: true,
  preservesMTime: false,
  hasVersionTokens: false,
  maxConcurrency: 1,
  listIsPaginated: false,
};

/**
 * FTP and FTPS (explicit `AUTH TLS` and implicit TLS-on-connect).
 *
 * The defining constraint is the control channel: one command at a time, per
 * connection. This class never sees it — `FtpPool` hands it a channel for the
 * duration of an operation, and how many channels exist is the connection's
 * `maxConnections` setting. That is also why nothing here changes the working
 * directory: every command carries an absolute path, which is what makes a
 * pooled channel interchangeable.
 */
export class FtpFileSystem implements RemoteFileSystem {
  readonly #context: ProviderContext;
  readonly #settings: FtpSettings;
  readonly #logger: Logger;
  readonly #openChannel: OpenChannel;
  #pool: FtpPool | undefined;
  #base = '/';

  /**
   * `openChannel` is the seam the hermetic tests replace. Production never
   * passes it, so `ProviderDefinition.create` stays a one-liner.
   */
  constructor(context: ProviderContext, openChannel: OpenChannel = FtpControlChannel.open) {
    this.#context = context;
    this.#settings = readSettings(context.config.settings);
    this.#logger = context.logger;
    this.#openChannel = openChannel;
  }

  /**
   * Static until the settings are read, then truthful about this connection.
   *
   * This is the first provider whose capabilities depend on a *setting* rather
   * than on the server. `TransferQueue` reads `maxConcurrency` at call time, so
   * a pool that shrank after a `421` stops the queue asking for more transfers
   * than the server will hold, without core changing.
   */
  get capabilities(): ProviderCapabilities {
    return {
      ...FTP_CAPABILITIES,
      maxConcurrency: this.#pool?.ceiling ?? this.#settings.maxConnections,
    };
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#pool?.isAlive() === true) return;

    const previous = this.#pool;
    this.#pool = undefined;
    await previous?.close();

    const pool = new FtpPool({
      maxConnections: this.#settings.maxConnections,
      logger: this.#logger,
      open: async (openSignal) => {
        // Fetched per channel rather than once, so credentials are resolved at
        // connect time as `ProviderContext.getSecret` documents.
        const secret = await this.#context.getSecret(openSignal);
        return this.#openChannel({
          settings: this.#settings,
          secret,
          logger: this.#logger,
          ...(openSignal !== undefined ? { signal: openSignal } : {}),
        });
      },
    });

    try {
      this.#base = await pool.lease(
        async (channel) => resolveBase(this.#settings.rootPrefix, await channel.pwd(signal)),
        signal,
      );
    } catch (error) {
      await pool.close();
      throw toOmniFsError(error, this.#settings.rootPrefix);
    }

    this.#pool = pool;
    this.#logger.log('info', 'FTP connected', {
      host: this.#settings.host,
      base: this.#base,
      secure: this.#settings.secure,
      maxConnections: this.#settings.maxConnections,
    });
  }

  isAlive(): boolean {
    return this.#pool?.isAlive() ?? false;
  }

  async stat(path: RemotePath, signal?: AbortSignal): Promise<FileStat> {
    return this.#requirePool().lease((channel) => this.#stat(channel, path, signal), signal);
  }

  async *list(path: RemotePath, signal?: AbortSignal): AsyncIterable<DirEntry> {
    const remote = this.#remote(path);
    // The lease ends here, before the first entry is yielded. `list` has an
    // array in hand — FTP has no listing cursor — so holding a control channel
    // while a slow consumer iterates would block everything else for nothing.
    const entries = await this.#requirePool().lease(
      (channel) => channel.list(remote, signal),
      signal,
    );
    for (const entry of entries) yield toDirEntry(entry, path);
  }

  async readFile(_path: RemotePath, _options?: ReadOptions): Promise<Uint8Array> {
    throw notImplemented('readFile');
  }

  async createReadStream(
    _path: RemotePath,
    _options?: ReadOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    throw notImplemented('createReadStream');
  }

  async writeFile(_path: RemotePath, _data: Uint8Array, _options?: WriteOptions): Promise<void> {
    throw notImplemented('writeFile');
  }

  async delete(_path: RemotePath, _options?: DeleteOptions): Promise<void> {
    throw notImplemented('delete');
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const pool = this.#pool;
    this.#pool = undefined;
    await pool?.close();
  }

  /**
   * `MLST` where the server has it, a parent listing where it does not.
   *
   * Not `SIZE` plus `MDTM`: `SIZE` fails on directories and refuses outright in
   * ASCII mode, and `MDTM` is missing from a good fraction of servers, so
   * telling "missing" from "is a directory" would need a third probe.
   */
  async #stat(channel: FtpChannel, path: RemotePath, signal?: AbortSignal): Promise<FileStat> {
    if (channel.hasMlst) {
      const found = await channel.mlst(this.#remote(path), signal);
      if (found !== undefined) return toFileStat(found);
    }

    if (path.isRoot) {
      // The connection base has no parent inside the connection. Listing it is
      // the only question available, and a listing that succeeds answers it.
      await channel.list(this.#base, signal);
      return { type: 'directory', size: 0 };
    }

    const entries = await channel.list(this.#remote(path.parent), signal);
    const match = entries.find((entry) => entry.name === path.basename);
    if (match === undefined) throw this.#notFound(path);
    return toFileStat(match);
  }

  #notFound(path: RemotePath): OmniFsError {
    return new OmniFsError({
      code: 'NotFound',
      message: `Not found: ${path.value}`,
      path: path.value,
      providerId: 'ftp',
    });
  }

  #remote(path: RemotePath): string {
    return joinRemote(this.#base, path);
  }

  #requirePool(): FtpPool {
    const pool = this.#pool;
    if (pool === undefined) {
      throw new OmniFsError({
        code: 'ConnectionFailed',
        message: 'FTP connection is not open. Call connect() first.',
        providerId: 'ftp',
        retryable: true,
      });
    }
    return pool;
  }
}

function notImplemented(operation: string): OmniFsError {
  return new OmniFsError({
    code: 'Unsupported',
    message: `FTP provider: ${operation} is not implemented yet.`,
    providerId: 'ftp',
  });
}
