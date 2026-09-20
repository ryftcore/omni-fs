import type { EntryCache } from '../cache/entry-cache.js';
import { OmniFsError } from '../errors.js';
import type { RemotePath } from '../model/path.js';
import { collectStream } from '../util/streams.js';
import type { ConnectionId } from '../model/connection.js';
import type { DirEntry, FileStat } from '../model/stat.js';
import type { Logger } from '../ports/logger.js';
import type { ProviderCapabilities } from '../capabilities.js';
import type {
  DeleteOptions,
  OverwriteOptions,
  ReadOptions,
  RemoteFileSystem,
  WriteOptions,
} from '../provider.js';

export interface ManagedFileSystemOptions {
  readonly connectionId: ConnectionId;
  readonly inner: RemoteFileSystem;
  readonly cache: EntryCache;
  readonly logger: Logger;
  /** Reject every mutating call before it reaches the network. */
  readonly readOnly?: boolean;
}

/**
 * Wraps a raw provider and hands the hosts a filesystem that is uniform
 * regardless of protocol. It does two jobs:
 *
 *  1. **Caching** — stat and listing results, invalidated precisely on every
 *     mutation rather than by TTL alone.
 *
 *  2. **Capability emulation** — a provider declares what it genuinely supports
 *     and this layer fills the rest: rename on S3 becomes copy+delete,
 *     recursive delete on a protocol without it becomes a depth-first walk,
 *     cross-provider copy becomes a stream.
 *
 * Providers stay honest and small; hosts get one predictable surface. Crucially
 * this is the layer `apps/desktop` will reuse verbatim — the emulation rules
 * are product behaviour, not VS Code behaviour, so they cannot live in the
 * extension.
 */
export class ManagedFileSystem implements RemoteFileSystem, AsyncDisposable {
  readonly #connectionId: ConnectionId;
  readonly #inner: RemoteFileSystem;
  readonly #cache: EntryCache;
  readonly #logger: Logger;
  readonly #readOnly: boolean;

  constructor(options: ManagedFileSystemOptions) {
    this.#connectionId = options.connectionId;
    this.#inner = options.inner;
    this.#cache = options.cache;
    this.#logger = options.logger;
    this.#readOnly = options.readOnly ?? false;
  }

  /**
   * Reported capabilities are what the *caller* can rely on, which is broader
   * than the provider's own: emulated operations are advertised as supported,
   * because from the UI's point of view they work. `canCopyServerSide` stays
   * truthful, since it is a performance fact rather than a feature.
   */
  get capabilities(): ProviderCapabilities {
    const inner = this.#inner.capabilities;
    return {
      ...inner,
      canWrite: inner.canWrite && !this.#readOnly,
      canRename: !this.#readOnly && inner.canWrite,
      canDeleteRecursive: !this.#readOnly && inner.canWrite,
      canCreateDirectory: !this.#readOnly && inner.canWrite,
    };
  }

  connect(signal?: AbortSignal): Promise<void> {
    return this.#inner.connect(signal);
  }

  isAlive(): boolean {
    return this.#inner.isAlive();
  }

  async stat(path: RemotePath, signal?: AbortSignal): Promise<FileStat> {
    const cached = this.#cache.getStat(this.#connectionId, path);
    if (cached !== undefined) return cached;

    const stat = await this.#inner.stat(path, signal);
    this.#cache.setStat(this.#connectionId, path, stat);
    return stat;
  }

  /**
   * Listings are buffered before being cached, so a cancelled or failed
   * enumeration never leaves a half-populated directory in the cache. Callers
   * still receive entries as they stream in.
   */
  async *list(path: RemotePath, signal?: AbortSignal): AsyncIterable<DirEntry> {
    const cached = this.#cache.getListing(this.#connectionId, path);
    if (cached !== undefined) {
      yield* cached;
      return;
    }

    const collected: DirEntry[] = [];
    for await (const entry of this.#inner.list(path, signal)) {
      collected.push(entry);
      yield entry;
    }
    this.#cache.setListing(this.#connectionId, path, collected);
  }

  readFile(path: RemotePath, options?: ReadOptions): Promise<Uint8Array> {
    return this.#inner.readFile(path, options);
  }

  createReadStream(path: RemotePath, options?: ReadOptions): Promise<ReadableStream<Uint8Array>> {
    return this.#inner.createReadStream(path, options);
  }

  async writeFile(path: RemotePath, data: Uint8Array, options?: WriteOptions): Promise<void> {
    this.#assertWritable('write');
    if (options?.createParents !== false) await this.#ensureParents(path, options?.signal);

    await this.#inner.writeFile(path, data, options);
    this.#afterMutation(path);
  }

  async createWriteStream(
    path: RemotePath,
    options?: WriteOptions,
  ): Promise<WritableStream<Uint8Array>> {
    this.#assertWritable('write');
    if (this.#inner.createWriteStream === undefined) {
      throw OmniFsError.unsupported('streaming writes');
    }
    if (options?.createParents !== false) await this.#ensureParents(path, options?.signal);

    const stream = await this.#inner.createWriteStream(path, options);
    this.#afterMutation(path);
    return stream;
  }

  async delete(path: RemotePath, options?: DeleteOptions): Promise<void> {
    this.#assertWritable('delete');

    if (options?.recursive === true && !this.#inner.capabilities.canDeleteRecursive) {
      await this.#deleteRecursiveByWalk(path, options);
    } else {
      await this.#inner.delete(path, options);
    }

    this.#cache.invalidateSubtree(this.#connectionId, path);
    this.#cache.invalidateChildren(this.#connectionId, path.parent);
  }

  async createDirectory(path: RemotePath, signal?: AbortSignal): Promise<void> {
    this.#assertWritable('create directory');

    // On an object store a directory is only a key prefix: there is nothing to
    // create, and the folder appears as soon as it holds an object. Succeeding
    // silently keeps "New Folder" working the same way in every host.
    if (!this.#inner.capabilities.hasRealDirectories) {
      this.#logger.log('debug', 'Skipping mkdir on a prefix-only provider', {
        path: path.value,
      });
      return;
    }

    if (this.#inner.createDirectory === undefined) {
      throw OmniFsError.unsupported('creating directories');
    }

    await this.#inner.createDirectory(path, signal);
    this.#afterMutation(path);
  }

  async rename(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    this.#assertWritable('rename');

    if (this.#inner.rename !== undefined && this.#inner.capabilities.canRename) {
      await this.#inner.rename(from, to, options);
    } else {
      // S3 and friends: emulate. Not atomic — if the delete fails the copy
      // stays, which is the safe direction to fail in.
      await this.copy(from, to, options);
      await this.delete(from, {
        recursive: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    }

    this.#cache.invalidateSubtree(this.#connectionId, from);
    this.#cache.invalidateChildren(this.#connectionId, from.parent);
    this.#cache.invalidateChildren(this.#connectionId, to.parent);
  }

  async copy(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    this.#assertWritable('copy');

    if (options?.overwrite === false && (await this.#exists(to, options.signal))) {
      throw OmniFsError.alreadyExists(to.value);
    }

    if (this.#inner.copy !== undefined && this.#inner.capabilities.canCopyServerSide) {
      await this.#inner.copy(from, to, options);
    } else {
      await this.#copyByStream(from, to, options);
    }

    this.#afterMutation(to);
  }

  watch(
    path: RemotePath,
    listener: Parameters<NonNullable<RemoteFileSystem['watch']>>[1],
    options?: Parameters<NonNullable<RemoteFileSystem['watch']>>[2],
  ): Disposable {
    if (this.#inner.watch !== undefined && this.#inner.capabilities.canWatch) {
      return this.#inner.watch(path, listener, options);
    }
    // No server-side notifications. The host decides whether polling is worth
    // it — core will not silently issue background list calls against someone's
    // metered S3 bucket.
    return { [Symbol.dispose]: () => {} };
  }

  async #copyByStream(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    // A directory has no stream to read. This layer advertises `canRename` on
    // providers that cannot rename, and renaming a folder is an ordinary thing
    // to do in a file tree, so the emulated copy has to handle one.
    const stat = await this.#inner.stat(from, options?.signal);
    if (stat.type === 'directory') {
      await this.#copyDirectory(from, to, options);
      return;
    }

    const source = await this.#inner.createReadStream(
      from,
      options?.signal ? { signal: options.signal } : undefined,
    );

    if (this.#inner.createWriteStream !== undefined && this.#inner.capabilities.canStreamWrite) {
      const sink = await this.#inner.createWriteStream(
        to,
        options?.signal ? { signal: options.signal } : undefined,
      );
      await source.pipeTo(sink, options?.signal ? { signal: options.signal } : undefined);
      return;
    }

    // Last resort: buffer. Only reached on a provider that can neither copy
    // server-side nor stream a write, which should be rare and is worth a log
    // line when it happens to a large file.
    const buffered = await collectStream(source);
    this.#logger.log('debug', 'Buffering copy in memory', {
      from: from.value,
      to: to.value,
      bytes: buffered.byteLength,
    });
    await this.#inner.writeFile(to, buffered, {
      ...(options?.signal ? { signal: options.signal } : {}),
      contentLength: buffered.byteLength,
    });
  }

  /**
   * Copies a directory child by child, for providers that cannot copy
   * server-side. On a prefix-only store there is no directory entry to create —
   * the prefix reappears at the target as soon as the first child lands.
   */
  async #copyDirectory(
    from: RemotePath,
    to: RemotePath,
    options?: OverwriteOptions,
  ): Promise<void> {
    if (this.#inner.capabilities.hasRealDirectories && this.#inner.createDirectory !== undefined) {
      try {
        await this.#inner.createDirectory(to, options?.signal);
      } catch (error) {
        if (!(OmniFsError.is(error) && error.code === 'AlreadyExists')) throw error;
      }
    }

    // Buffered before recursing, for the same reason as the recursive delete:
    // a protocol with one control channel cannot copy a file while a listing is
    // still open on it.
    const children: DirEntry[] = [];
    for await (const entry of this.#inner.list(from, options?.signal)) children.push(entry);

    for (const child of children) {
      await this.#copyByStream(child.path, to.join(child.name), options);
    }
  }

  /** Depth-first delete for providers without a recursive delete call. */
  async #deleteRecursiveByWalk(path: RemotePath, options?: DeleteOptions): Promise<void> {
    const stat = await this.#inner.stat(path, options?.signal);
    if (stat.type !== 'directory') {
      await this.#inner.delete(path, options);
      return;
    }

    const children: DirEntry[] = [];
    for await (const entry of this.#inner.list(path, options?.signal)) children.push(entry);

    for (const child of children) {
      await this.#deleteRecursiveByWalk(child.path, options);
    }

    // Prefix-only providers have no directory entry left to remove once the
    // last child is gone.
    if (this.#inner.capabilities.hasRealDirectories) {
      await this.#inner.delete(path, options);
    }
  }

  /**
   * Walks up creating missing directories. Skipped entirely on prefix-only
   * providers, where parents are implied.
   */
  async #ensureParents(path: RemotePath, signal?: AbortSignal): Promise<void> {
    if (!this.#inner.capabilities.hasRealDirectories) return;
    if (this.#inner.createDirectory === undefined) return;

    const missing: RemotePath[] = [];
    let current = path.parent;

    while (!current.isRoot) {
      if (await this.#exists(current, signal)) break;
      missing.push(current);
      current = current.parent;
    }

    for (const dir of missing.reverse()) {
      try {
        await this.#inner.createDirectory(dir, signal);
      } catch (error) {
        // A racing writer may have created it between our check and our call.
        if (OmniFsError.is(error) && error.code === 'AlreadyExists') continue;
        throw error;
      }
      this.#cache.invalidateChildren(this.#connectionId, dir.parent);
    }
  }

  async #exists(path: RemotePath, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.stat(path, signal);
      return true;
    } catch (error) {
      if (OmniFsError.is(error) && error.code === 'NotFound') return false;
      throw error;
    }
  }

  #assertWritable(operation: string): void {
    if (this.#readOnly) {
      throw new OmniFsError({
        code: 'PermissionDenied',
        message: `This connection is marked read-only; cannot ${operation}.`,
      });
    }
    if (!this.#inner.capabilities.canWrite) {
      throw OmniFsError.unsupported(operation);
    }
  }

  #afterMutation(path: RemotePath): void {
    this.#cache.invalidate(this.#connectionId, path);
    this.#cache.invalidateChildren(this.#connectionId, path.parent);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#cache.invalidateConnection(this.#connectionId);
    await this.#inner[Symbol.asyncDispose]();
  }
}
