import { collectStream, OmniFsError, streamFrom } from '@omni-fs/core';
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
  RemotePath,
  WriteOptions,
} from '@omni-fs/core';
import { isFailure, toOmniFsError } from './errors.js';
import { readSettings, type SftpSettings } from './settings.js';
import {
  buildRange,
  joinRemote,
  resolveBase,
  toFileStat,
  toFileType,
  translateReadStream,
} from './sftp-helpers.js';
import {
  SftpSession,
  type OpenSession,
  type SftpConnection,
  type SftpWriteFlags,
} from './sftp-session.js';

/**
 * SFTP over SSH.
 *
 * The closest of the four providers to a real POSIX filesystem: real
 * directories, real rename, real permission bits, and the fewest emulations
 * above it — which makes it the useful control case when a bug might be in
 * `ManagedFileSystem` rather than in a protocol.
 *
 * Two things here are unlike the other providers. Symlinks exist, so `list`
 * resolves them and `stat` falls back to `lstat` for one that dangles. And
 * `canCopyServerSide` is answered per connection, because `copy-data` is an
 * OpenSSH extension the server announces at version exchange — see the
 * `capabilities` getter.
 */
export class SftpFileSystem implements RemoteFileSystem {
  readonly #context: ProviderContext;
  readonly #settings: SftpSettings;
  readonly #logger: Logger;
  readonly #openSession: OpenSession;
  #session: SftpConnection | undefined;
  #base = '/';

  /**
   * `openSession` is the seam the hermetic tests replace. Production never
   * passes it, so `ProviderDefinition.create` stays a one-liner.
   */
  constructor(context: ProviderContext, openSession: OpenSession = SftpSession.open) {
    this.#context = context;
    this.#settings = readSettings(context.config.settings);
    this.#logger = context.logger;
    this.#openSession = openSession;
  }

  /**
   * Static until connected, then truthful about this server.
   *
   * `copy-data` is announced per connection, so the honest answer for
   * `canCopyServerSide` does not exist before the handshake: the static set
   * says no, and this getter says what the connected server actually offers.
   * `ManagedFileSystem.copy` reads the flag at call time
   * (`packages/core/src/fs/managed-file-system.ts:204`), so both answers are
   * correct in turn and core streams the copy on a server without the
   * extension, exactly as it does today.
   */
  get capabilities(): ProviderCapabilities {
    const session = this.#session;
    if (session === undefined) return SFTP_CAPABILITIES;
    return { ...SFTP_CAPABILITIES, canCopyServerSide: session.extensions.copyData };
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#session?.isAlive() === true) return;

    // A session that is no longer alive may still hold a socket: it is marked
    // dead on `error` as well as on `close`. Let it go before opening another,
    // or a reconnect leaks the old connection for the life of the process.
    // `close()` on a dead session takes its already-closed branch and returns
    // without waiting, so this costs nothing on the common path.
    const previous = this.#session;
    this.#session = undefined;
    await previous?.close();

    const secret = await this.#context.getSecret(signal);
    const session = await this.#openSession({
      settings: this.#settings,
      secret,
      logger: this.#logger,
      ...(signal !== undefined ? { signal } : {}),
    });

    try {
      this.#base = resolveBase(this.#settings.rootPrefix, await session.realpath('.', signal));
    } catch (error) {
      await session.close();
      throw toOmniFsError(error, this.#settings.rootPrefix);
    }

    this.#session = session;
    this.#logger.log('info', 'SFTP connected', {
      host: this.#settings.host,
      base: this.#base,
    });
  }

  isAlive(): boolean {
    return this.#session?.isAlive() ?? false;
  }

  async stat(path: RemotePath, signal?: AbortSignal): Promise<FileStat> {
    const session = this.#requireSession();
    const remote = this.#remote(path);

    try {
      return toFileStat(await session.stat(remote, signal));
    } catch (error) {
      const translated = toOmniFsError(error, path.value);
      if (translated.code !== 'NotFound') throw translated;

      // `SSH_FXP_STAT` follows links, so a link whose target is gone reads as
      // absent — while `list` has just drawn it as a symlink. One `lstat` keeps
      // the two agreeing, and a path that genuinely is not there fails both.
      try {
        return toFileStat(await session.lstat(remote, signal));
      } catch (retry) {
        // A retry that failed because the connection went away says nothing
        // about whether the path exists, and the original `NotFound` must not
        // be reported for it: in the VS Code host `FileNotFound` is what drives
        // create-on-save, so a dropped socket would be read as an invitation to
        // write the file.
        const retryError = toOmniFsError(retry, path.value);
        if (isConnectionFailure(retryError)) throw retryError;
        throw translated;
      }
    }
  }

  /**
   * `readdir` reports a symlink as a symlink, because its attributes are
   * `lstat`-shaped. Each link therefore gets one follow-up `stat`, so a link to
   * a directory opens as a directory and a link to a file opens in the editor —
   * which is how the same file already behaves over S3 and WebDAV. The
   * follow-ups run `maxConcurrency` at a time and are only paid on directories
   * that contain links. A link that cannot be followed stays a symlink; only a
   * failure of the connection itself stops the listing.
   */
  async *list(path: RemotePath, signal?: AbortSignal): AsyncIterable<DirEntry> {
    const session = this.#requireSession();
    const entries = (
      await this.#run(() => session.readdir(this.#remote(path), signal), path)
    ).filter((entry) => entry.filename !== '.' && entry.filename !== '..');

    const links = entries.filter((entry) => toFileType(entry.attrs.mode) === 'symlink');
    const resolved = new Map<string, FileStat>();

    for (let i = 0; i < links.length; i += SFTP_CAPABILITIES.maxConcurrency) {
      const batch = links.slice(i, i + SFTP_CAPABILITIES.maxConcurrency);
      await Promise.all(
        batch.map(async (entry) => {
          const target = path.join(entry.filename);
          try {
            resolved.set(
              entry.filename,
              toFileStat(await session.stat(this.#remote(target), signal)),
            );
          } catch (error) {
            const translated = toOmniFsError(error, target.value);
            // A link we cannot follow is still a link: fall back to its own
            // attributes rather than failing the listing. Only a failure of the
            // connection itself propagates, because then the rest of the
            // listing is unreliable too. A symlink loop arrives here as
            // `Unknown`, since OpenSSH answers status 4 for it.
            if (isConnectionFailure(translated)) throw translated;
          }
        }),
      );
    }

    for (const entry of entries) {
      const child = path.join(entry.filename);
      const stat = resolved.get(entry.filename) ?? toFileStat(entry.attrs);
      yield { ...stat, name: entry.filename, path: child };
    }
  }

  /**
   * `onProgress` is not reported, as in `provider-webdav`: the bytes arrive
   * through a stream this method immediately collects, and a caller who wants
   * progress can read the stream itself.
   */
  async readFile(path: RemotePath, options?: ReadOptions): Promise<Uint8Array> {
    try {
      return await collectStream(await this.createReadStream(path, options));
    } catch (error) {
      throw toOmniFsError(error, path.value);
    }
  }

  async createReadStream(
    path: RemotePath,
    options?: ReadOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    const session = this.#requireSession();
    const range = buildRange(options);

    // A read of zero bytes has no range spelling, so it is answered here rather
    // than sent as something the server would read as a different request. The
    // `stat` is not a formality: without it a zero-length read of a missing path,
    // or one through an already-aborted signal, would succeed emptily, where
    // `MemoryFileSystem` — the contract's reference — raises `NotFound` and
    // `Cancelled` first.
    if (range === 'empty') {
      await this.stat(path, options?.signal);
      return streamFrom(new Uint8Array(0));
    }

    const stream = await this.#run(
      () =>
        session.openReadStream(this.#remote(path), {
          ...(range ?? {}),
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        }),
      path,
    );

    return translateReadStream(stream, path.value);
  }

  /**
   * `overwrite: false` is `wx`, so the exclusion is the server's. Unlike
   * `provider-webdav`, which has to check first and race, nothing here can slip
   * between the check and the write — there is no check.
   */
  async writeFile(path: RemotePath, data: Uint8Array, options?: WriteOptions): Promise<void> {
    const session = this.#requireSession();
    const flags = writeFlags(options);

    await this.#withParents(path, flags, options, (remote) =>
      session.writeAll(remote, data, flags, options?.signal),
    );

    options?.onProgress?.(data.byteLength, data.byteLength);
  }

  /**
   * A streamed write, for a file too large to hold in memory.
   *
   * `createParents` works here where it cannot on WebDAV's streamed PUT: the
   * handle is opened before the first byte, so a missing parent is known while
   * there is still something to retry. `onProgress` is not reported — the caller
   * is the one feeding the stream, so it already knows how much it has written.
   */
  async createWriteStream(
    path: RemotePath,
    options?: WriteOptions,
  ): Promise<WritableStream<Uint8Array>> {
    const session = this.#requireSession();
    const flags = writeFlags(options);

    return this.#withParents(path, flags, options, (remote) =>
      session.openWriteStream(remote, flags, options?.signal),
    );
  }

  /**
   * `SSH_FXP_MKDIR` one level at a time, shallowest first, because a server
   * answers "no such file" for a missing parent and there is no recursive form.
   *
   * An existing directory is not an error: that matches `MemoryFileSystem`, the
   * contract's reference, where creating one twice is a no-op. Status 4 is the
   * only answer a server gives for "something is already here", and it does not
   * say what, so one `stat` decides between the no-op and `AlreadyExists`.
   */
  async createDirectory(path: RemotePath, signal?: AbortSignal): Promise<void> {
    const session = this.#requireSession();

    const chain: RemotePath[] = [];
    for (let current = path; !current.isRoot; current = current.parent) chain.unshift(current);

    for (const directory of chain) {
      try {
        await session.mkdir(this.#remote(directory), signal);
      } catch (error) {
        if (!isFailure(error)) throw toOmniFsError(error, directory.value);
        if ((await this.stat(directory, signal)).type !== 'directory') {
          // Built inline: `OmniFsError.alreadyExists` drops `providerId`, and
          // everything this package raises names the provider it came from.
          throw new OmniFsError({
            code: 'AlreadyExists',
            message: `Already exists: ${directory.value}`,
            path: directory.value,
            providerId: 'sftp',
            cause: error,
          });
        }
      }
    }
  }

  /**
   * Runs a write, and on a missing parent builds the chain and runs it once more.
   *
   * One retry, not a loop: the second failure is the server telling us something
   * other than the parent was wrong, and retrying past that would turn a real
   * error into a hang.
   */
  async #withParents<T>(
    path: RemotePath,
    flags: SftpWriteFlags,
    options: WriteOptions | undefined,
    body: (remote: string) => Promise<T>,
  ): Promise<T> {
    const remote = this.#remote(path);

    try {
      return await body(remote);
    } catch (error) {
      const failure = this.#writeError(error, path, flags);
      if (failure.code !== 'NotFound' || options?.createParents === false) throw failure;

      await this.createDirectory(path.parent, options?.signal);
      try {
        return await body(remote);
      } catch (retry) {
        throw this.#writeError(retry, path, flags);
      }
    }
  }

  /**
   * Names a failed write. An exclusive open answers status 4 when the path is
   * already taken, and only this call site knows the open was exclusive — the
   * same narrowing `provider-webdav` does for 405 on `MKCOL`.
   */
  #writeError(error: unknown, path: RemotePath, flags: SftpWriteFlags): OmniFsError {
    if (flags !== 'wx' || !isFailure(error)) return toOmniFsError(error, path.value);

    // Built inline: `OmniFsError.alreadyExists` drops `providerId`.
    return new OmniFsError({
      code: 'AlreadyExists',
      message: `Already exists: ${path.value}`,
      path: path.value,
      providerId: 'sftp',
      cause: error,
    });
  }

  /**
   * `unlink` for anything that is not a directory, `rmdir` for an empty one, and
   * a walk when the caller asked for recursion.
   *
   * The type comes from `lstat`, not `stat`: a symlink — even one pointing at a
   * directory — is unlinked, which is what `rm` does and the only answer that
   * cannot destroy something outside the tree.
   *
   * A non-recursive delete of a non-empty directory is status 4 from `rmdir`,
   * narrowed here to `NotEmpty`. Without that narrowing a caller who asked to
   * remove an empty directory could not tell "not empty" from any other refusal.
   */
  async delete(path: RemotePath, options?: DeleteOptions): Promise<void> {
    const session = this.#requireSession();
    const signal = options?.signal;
    const attrs = await this.#run(() => session.lstat(this.#remote(path), signal), path);

    if (toFileType(attrs.mode) !== 'directory') {
      await this.#run(() => session.unlink(this.#remote(path), signal), path);
      return;
    }

    if (options?.recursive === true) {
      await this.#deleteTree(session, path, signal);
      return;
    }

    try {
      await session.rmdir(this.#remote(path), signal);
    } catch (error) {
      if (!isFailure(error)) throw toOmniFsError(error, path.value);
      throw new OmniFsError({
        code: 'NotEmpty',
        message: `Directory is not empty: ${path.value}`,
        path: path.value,
        providerId: 'sftp',
        cause: error,
      });
    }
  }

  /**
   * Depth-first, children before their parent, because `SSH_FXP_RMDIR` only
   * removes an empty directory.
   *
   * `readdir` deliberately, not `list`: `list` resolves symlinks, and a recursive
   * delete that followed one would delete the link's *target* — a file outside
   * the tree the caller asked to remove.
   */
  async #deleteTree(
    session: SftpConnection,
    path: RemotePath,
    signal?: AbortSignal,
  ): Promise<void> {
    const entries = (
      await this.#run(() => session.readdir(this.#remote(path), signal), path)
    ).filter((entry) => entry.filename !== '.' && entry.filename !== '..');

    for (const entry of entries) {
      const child = path.join(entry.filename);
      if (toFileType(entry.attrs.mode) === 'directory') {
        await this.#deleteTree(session, child, signal);
      } else {
        await this.#run(() => session.unlink(this.#remote(child), signal), child);
      }
    }

    await this.#run(() => session.rmdir(this.#remote(path), signal), path);
  }

  /**
   * A real server-side rename: no read-back, no re-upload.
   *
   * With `overwrite: false`, plain `SSH_FXP_RENAME` is exactly right — it fails
   * when the destination exists, and status 4 then means `AlreadyExists`.
   * Overwriting needs `posix-rename@openssh.com`, which replaces atomically. On a
   * server without it the destination has to be unlinked first, which is a race
   * — a reader in between sees nothing at `to` — so it is logged as the
   * non-atomic fallback it is rather than presented as a rename.
   */
  async rename(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    const session = this.#requireSession();
    const signal = options?.signal;

    if (options?.overwrite === false) {
      try {
        await session.rename(this.#remote(from), this.#remote(to), signal);
      } catch (error) {
        if (!isFailure(error)) throw toOmniFsError(error, from.value);
        throw this.#occupiedError(to, error);
      }
      return;
    }

    if (session.extensions.posixRename) {
      await this.#run(
        () => session.posixRename(this.#remote(from), this.#remote(to), signal),
        from,
      );
      return;
    }

    try {
      await session.rename(this.#remote(from), this.#remote(to), signal);
    } catch (error) {
      if (!isFailure(error)) throw toOmniFsError(error, from.value);
      this.#logger.log(
        'warn',
        'Replacing a rename destination without posix-rename, which is not atomic',
        { from: from.value, to: to.value },
      );
      await this.#run(() => session.unlink(this.#remote(to), signal), to);
      await this.#run(() => session.rename(this.#remote(from), this.#remote(to), signal), from);
    }
  }

  /**
   * `copy-data`, the server-side copy the `canCopyServerSide` getter promises
   * when the server announced the extension. The session raises `Unsupported`
   * when it did not, and `ManagedFileSystem` streams the copy instead because it
   * checks the same flag before calling this.
   */
  async copy(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    const session = this.#requireSession();
    const flags: SftpWriteFlags = options?.overwrite === false ? 'wx' : 'w';

    try {
      await session.copyData(this.#remote(from), this.#remote(to), flags, options?.signal);
    } catch (error) {
      if (flags === 'wx' && isFailure(error)) throw this.#occupiedError(to, error);
      throw toOmniFsError(error, from.value);
    }
  }

  /**
   * Status 4 on a destination the caller asked us not to replace.
   *
   * Constructed here rather than through `OmniFsError.alreadyExists`, which
   * drops `providerId` — everything this package raises names the provider it
   * came from, as `#writeError` and `createDirectory` already do.
   */
  #occupiedError(to: RemotePath, cause: unknown): OmniFsError {
    return new OmniFsError({
      code: 'AlreadyExists',
      message: `Already exists: ${to.value}`,
      path: to.value,
      providerId: 'sftp',
      cause,
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    await session?.close();
  }

  #remote(path: RemotePath): string {
    return joinRemote(this.#base, path);
  }

  #requireSession(): SftpConnection {
    const session = this.#session;
    if (session === undefined) {
      throw new OmniFsError({
        code: 'ConnectionFailed',
        message: 'SFTP session is not connected. Call connect() first.',
        providerId: 'sftp',
      });
    }
    return session;
  }

  async #run<T>(body: () => Promise<T>, path: RemotePath): Promise<T> {
    try {
      return await body();
    } catch (error) {
      throw toOmniFsError(error, path.value);
    }
  }
}

/**
 * Whether a failure is the connection's rather than the path's.
 *
 * These three codes say nothing about the resource that was asked for, so they
 * must never be tolerated in place of an answer about it: whatever the caller
 * would have concluded from a soft failure is unreliable once the connection is
 * the thing that broke.
 */
function isConnectionFailure(error: OmniFsError): boolean {
  return (
    error.code === 'ConnectionFailed' || error.code === 'Cancelled' || error.code === 'Timeout'
  );
}

function writeFlags(options: WriteOptions | undefined): SftpWriteFlags {
  return options?.overwrite === false ? 'wx' : 'w';
}

export const SFTP_CAPABILITIES: ProviderCapabilities = {
  canWrite: true,
  canRename: true,
  // False in the static set only. `SSH_FXP_RENAME` always exists, but a
  // server-side copy needs the `copy-data` extension, which is announced per
  // connection — the `capabilities` getter above answers it truthfully once the
  // handshake has happened.
  canCopyServerSide: false,
  canCreateDirectory: true,
  // The protocol has no recursive remove, so `delete` walks the tree itself.
  // `provider-s3` already settles what this flag means: it declares true and
  // enumerates-then-deletes from the client (`s3-file-system.ts:301`). Its only
  // reader asks whether the provider handles recursion
  // (`managed-file-system.ts:146`), so declaring true keeps one walk in the
  // system instead of two.
  canDeleteRecursive: true,
  canAppend: true,
  canReadRange: true,
  canStreamWrite: true,
  canWatch: false,
  hasRealDirectories: true,
  // Nothing in `WriteOptions` carries a client-supplied mtime, so there is no
  // mtime to preserve. `setstat`/`futimes` could keep one the day the contract
  // grows one; until then this matches what S3 and WebDAV declare, and the
  // skeleton's `true` was a claim about the protocol rather than about us.
  preservesMTime: false,
  // SFTP has no etag. A token synthesised from mtime and size would make
  // `ifMatch` look atomic when it would really be a racy re-stat, so the two
  // `ifMatch` conformance cases skip instead.
  hasVersionTokens: false,
  // One SSH connection multiplexes channels comfortably.
  maxConcurrency: 4,
  listIsPaginated: false,
};
