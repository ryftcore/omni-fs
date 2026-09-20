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
import { readSettings, type SftpSettings } from './settings.js';
import { joinRemote, resolveBase, toFileStat, toFileType } from './sftp-helpers.js';
import { SftpSession, type OpenSession, type SftpConnection } from './sftp-session.js';

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
   * `canCopyServerSide` does not exist before the handshake. `copy()` is defined
   * either way and throws `Unsupported` when the extension is absent;
   * `ManagedFileSystem.copy` checks the method *and* this flag before using it
   * (`packages/core/src/fs/managed-file-system.ts:204`), so on a server without
   * the extension core streams the copy exactly as it does today.
   */
  get capabilities(): ProviderCapabilities {
    const session = this.#session;
    if (session === undefined) return SFTP_CAPABILITIES;
    return { ...SFTP_CAPABILITIES, canCopyServerSide: session.extensions.copyData };
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#session?.isAlive() === true) return;

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
      } catch {
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
   * that contain links. A link whose target is gone, or that we may not follow,
   * stays a symlink.
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
            if (translated.code !== 'NotFound' && translated.code !== 'PermissionDenied') {
              throw translated;
            }
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

  // Reading, writing and deleting are not implemented yet. `RemoteFileSystem`
  // requires all four, so they are declared and each says plainly that it does
  // nothing rather than failing in some protocol-flavoured way. `capabilities`
  // above already promises the three operations, so an `Unsupported` from here
  // is a gap in this class, not a claim about the protocol.
  async readFile(_path: RemotePath, _options?: ReadOptions): Promise<Uint8Array> {
    throw OmniFsError.unsupported('reading a file', 'sftp');
  }

  async createReadStream(
    _path: RemotePath,
    _options?: ReadOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    throw OmniFsError.unsupported('reading a file', 'sftp');
  }

  async writeFile(_path: RemotePath, _data: Uint8Array, _options?: WriteOptions): Promise<void> {
    throw OmniFsError.unsupported('writing a file', 'sftp');
  }

  async delete(_path: RemotePath, _options?: DeleteOptions): Promise<void> {
    throw OmniFsError.unsupported('deleting', 'sftp');
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
