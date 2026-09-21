import { OmniFsError, RemotePath, collectStream, streamFrom, throwIfAborted } from '@omni-fs/core';
import type {
  DeleteOptions,
  DirEntry,
  FileStat,
  Logger,
  OverwriteOptions,
  ProviderCapabilities,
  ProviderContext,
  ReadOptions,
  RemoteFileSystem,
  WriteOptions,
} from '@omni-fs/core';
import { isReplyCode, toOmniFsError } from './errors.js';
import { FtpControlChannel } from './ftp-channel.js';
import type { FtpChannel, FtpTransferOptions, OpenChannel } from './ftp-channel.js';
import {
  buildRange,
  joinRemote,
  releasingStream,
  releasingWritable,
  resolveBase,
  toDirEntry,
  toFileStat,
} from './ftp-helpers.js';
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

  async readFile(path: RemotePath, options?: ReadOptions): Promise<Uint8Array> {
    return collectStream(await this.createReadStream(path, options));
  }

  async createReadStream(
    path: RemotePath,
    options?: ReadOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    const range = buildRange(options);
    const signal = options?.signal;

    if (range === 'empty') {
      // No protocol has a spelling for "zero bytes", and answering it locally
      // must not turn a missing path into an empty success — so existence
      // stays the server's to decide. The same shape, and the same reasoning,
      // as the other three providers.
      await this.stat(path, signal);
      return streamFrom(new Uint8Array());
    }

    const pool = this.#requirePool();
    const channel = await pool.acquire(signal);
    try {
      const stream = await channel.openReadStream(
        this.#remote(path),
        range,
        this.#transferOptions(options),
      );
      // The lease outlives this call: a read is only finished when its stream
      // is, and every way out of that stream has to hand the channel back.
      return releasingStream(stream, () => {
        pool.release(channel);
      });
    } catch (error) {
      pool.release(channel);
      throw toOmniFsError(error, path.value);
    }
  }

  async writeFile(path: RemotePath, data: Uint8Array, options?: WriteOptions): Promise<void> {
    const signal = options?.signal;
    await this.#requirePool().lease(async (channel) => {
      await this.#prepareWrite(channel, path, options, signal);
      await channel.upload(this.#remote(path), data, this.#transferOptions(options));
    }, signal);
  }

  async createWriteStream(
    path: RemotePath,
    options?: WriteOptions,
  ): Promise<WritableStream<Uint8Array>> {
    const signal = options?.signal;
    const pool = this.#requirePool();
    const channel = await pool.acquire(signal);
    try {
      await this.#prepareWrite(channel, path, options, signal);
      const stream = await channel.openWriteStream(
        this.#remote(path),
        this.#transferOptions(options),
      );
      return releasingWritable(stream, () => pool.release(channel));
    } catch (error) {
      pool.release(channel);
      throw toOmniFsError(error, path.value);
    }
  }

  async createDirectory(path: RemotePath, signal?: AbortSignal): Promise<void> {
    await this.#requirePool().lease(async (channel) => {
      await this.#mkdirp(channel, path, signal);
      // `MKD` on something that already exists is swallowed above, matching
      // `MemoryFileSystem` — the contract's reference implementation. A *file*
      // in the way is `AlreadyExists`, and only a stat can tell which it was.
      const stat = await this.#stat(channel, path, signal);
      if (stat.type !== 'directory') {
        throw new OmniFsError({
          code: 'AlreadyExists',
          message: `Already exists: ${path.value}`,
          path: path.value,
          providerId: 'ftp',
        });
      }
    }, signal);
  }

  async delete(path: RemotePath, options?: DeleteOptions): Promise<void> {
    const signal = options?.signal;
    await this.#requirePool().lease(async (channel) => {
      // The stat is not overhead: 550 from `DELE` on a directory and 550 from
      // `RMD` on a non-empty one are the same reply, and sending the wrong
      // command first would make a missing file and a full directory
      // indistinguishable.
      const stat = await this.#stat(channel, path, signal);

      if (stat.type !== 'directory') {
        await channel.unlink(this.#remote(path), signal);
        return;
      }
      if (options?.recursive === true) {
        await this.#deleteTree(channel, path, signal);
        return;
      }
      await this.#removeDirectory(channel, path, signal);
    }, signal);
  }

  async rename(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    const signal = options?.signal;
    await this.#requirePool().lease(async (channel) => {
      if (options?.overwrite === false) await this.#refuseIfPresent(channel, to, signal);

      try {
        await channel.rename(this.#remote(from), this.#remote(to), signal);
      } catch (cause) {
        // Classified up front rather than narrowed on the raw reply code: a
        // permission-denied RNFR/RNTO answers 550 too, the same reply as "the
        // destination is in the way," and `#exists` below cannot tell those
        // apart — it would find the destination present either way. Getting
        // this wrong is not a wrong error code, it is deleting a destination
        // the caller never asked to touch, so a `PermissionDenied`
        // classification (or anything that is not a plain 550) propagates
        // unchanged, exactly as `#mkdirp` treats it.
        const error = toOmniFsError(cause, from.value);
        if (
          options?.overwrite === false ||
          error.code === 'PermissionDenied' ||
          !isReplyCode(error, 550)
        ) {
          throw error;
        }

        // A 550 here means either "the destination is in the way" or "the
        // source is gone", and only a look can say which. Deleting on the
        // second reading would destroy a file the caller never named.
        if (!(await this.#exists(channel, to, signal))) throw error;

        this.#logger.log(
          'warn',
          'FTP rename replaced the destination in two steps, which is not atomic',
          { from: from.value, to: to.value },
        );
        await channel.unlink(this.#remote(to), signal);
        await channel.rename(this.#remote(from), this.#remote(to), signal);
      }
    }, signal);
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

  async #prepareWrite(
    channel: FtpChannel,
    path: RemotePath,
    options: WriteOptions | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (options?.createParents !== false) await this.#mkdirp(channel, path.parent, signal);
    if (options?.overwrite === false) await this.#refuseIfPresent(channel, path, signal);
  }

  /**
   * FTP has no exclusive create. `STOR` truncates whatever is there, and there
   * is no flag, no `If-None-Match` and no `wx` — so this is check-then-act,
   * with a race window of one round trip. SFTP got this for free from a `wx`
   * open and WebDAV from `If-None-Match`; this provider cannot, and the
   * difference is written down here rather than hidden behind a method that
   * looks identical from the outside.
   */
  async #refuseIfPresent(
    channel: FtpChannel,
    path: RemotePath,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (!(await this.#exists(channel, path, signal))) return;
    throw new OmniFsError({
      code: 'AlreadyExists',
      message: `Already exists: ${path.value}`,
      path: path.value,
      providerId: 'ftp',
    });
  }

  async #exists(
    channel: FtpChannel,
    path: RemotePath,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    try {
      await this.#stat(channel, path, signal);
      return true;
    } catch (error) {
      if (OmniFsError.is(error) && error.code === 'NotFound') return false;
      throw error;
    }
  }

  /**
   * Creates the ancestor chain with absolute `MKD`s.
   *
   * Not `basic-ftp`'s `ensureDir`, which is built on `CWD` and would leave a
   * pooled channel somewhere the next lease does not expect. An existing
   * directory is success: servers answer 550 or 521 for it and disagree about
   * which, so neither can be read as a failure here.
   *
   * A 550 is also how vsftpd and pure-ftpd both answer a permission-denied
   * `MKD` — the exact same reply code as "already exists" — so the raw code
   * alone cannot tell the two apart. `toOmniFsError` has already done that
   * work by the time this catches the error (a `550 Permission denied`
   * reaches here as `code: 'PermissionDenied'`, message-classified before the
   * channel ever threw), so this checks *that* classification first and lets
   * a permission failure propagate as `PermissionDenied` rather than being
   * swallowed as though the directory were simply there already.
   */
  async #mkdirp(
    channel: FtpChannel,
    directory: RemotePath,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    let current = RemotePath.ROOT;
    for (const segment of directory.segments) {
      current = current.join(segment);
      try {
        await channel.mkdir(this.#remote(current), signal);
      } catch (error) {
        if (OmniFsError.is(error) && error.code === 'PermissionDenied') throw error;
        if (!isReplyCode(error, 550, 521)) throw error;
      }
    }
  }

  /**
   * Depth first, because a parent cannot be removed until it is empty. The
   * abort check is between entries rather than around the walk: a tree delete
   * is many round trips, and a cancelled one should stop at the next of them
   * rather than run to completion.
   */
  async #deleteTree(
    channel: FtpChannel,
    directory: RemotePath,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const entries = await channel.list(this.#remote(directory), signal);
    for (const child of entries) {
      const childPath = directory.join(child.name);
      throwIfAborted(signal, childPath.value);
      if (child.type === 'directory') await this.#deleteTree(channel, childPath, signal);
      else await channel.unlink(this.#remote(childPath), signal);
    }
    await channel.rmdir(this.#remote(directory), signal);
  }

  /**
   * `RMD` on a non-empty directory and `RMD` on one this connection is not
   * allowed to touch are the same 550, so the raw code cannot say which
   * happened — only `toOmniFsError`'s message classification can, the same
   * split `#mkdirp` already relies on. A permission failure propagates as
   * `PermissionDenied` without ever reaching the listing probe below: that
   * probe cannot disambiguate either, since a locked directory can hold
   * entries just as easily as an empty one, so letting a permission error
   * fall through to it would report a locked directory as `NotEmpty` instead.
   */
  async #removeDirectory(
    channel: FtpChannel,
    directory: RemotePath,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      await channel.rmdir(this.#remote(directory), signal);
    } catch (cause) {
      const error = toOmniFsError(cause, directory.value);
      if (error.code === 'PermissionDenied' || !isReplyCode(error, 550)) throw error;

      const entries = await channel.list(this.#remote(directory), signal).catch(() => []);
      if (entries.length === 0) throw error;
      throw new OmniFsError({
        code: 'NotEmpty',
        message: `Directory is not empty: ${directory.value}`,
        path: directory.value,
        providerId: 'ftp',
        cause: error,
      });
    }
  }

  /**
   * `exactOptionalPropertyTypes` is why these are conditional spreads rather
   * than two assignments: `FtpTransferOptions.signal` may be absent, and an
   * explicit `undefined` is not the same thing.
   */
  #transferOptions(options: ReadOptions | WriteOptions | undefined): FtpTransferOptions {
    return {
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      ...(options?.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
    };
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
