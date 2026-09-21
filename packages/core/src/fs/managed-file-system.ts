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
    if (cached !== undefined) {
      this.#logger.log('trace', 'stat', { path: path.value, cache: 'hit' });
      return this.#stampReadOnly(cached);
    }

    const stat = await this.#timed('stat', { path: path.value, cache: 'miss' }, () =>
      this.#inner.stat(path, signal),
    );
    this.#cache.setStat(this.#connectionId, path, stat);
    return this.#stampReadOnly(stat);
  }

  /**
   * Listings are buffered before being cached, so a cancelled or failed
   * enumeration never leaves a half-populated directory in the cache. Callers
   * still receive entries as they stream in.
   */
  async *list(path: RemotePath, signal?: AbortSignal): AsyncIterable<DirEntry> {
    const cached = this.#cache.getListing(this.#connectionId, path);
    if (cached !== undefined) {
      this.#logger.log('trace', 'list', {
        path: path.value,
        entries: cached.length,
        cache: 'hit',
      });
      yield* cached;
      return;
    }

    // Timed by hand: `#timed` wraps a promise, and this is a generator. The
    // clock includes the caller's own time between entries, which is small for
    // every host today and would only mislead a very slow consumer.
    const started = Date.now();
    const collected: DirEntry[] = [];
    try {
      for await (const entry of this.#inner.list(path, signal)) {
        collected.push(entry);
        yield entry;
      }
    } catch (error) {
      this.#logger.log('debug', 'list failed', {
        path: path.value,
        ...describeFailure(error),
        ms: Date.now() - started,
      });
      throw error;
    }
    this.#cache.setListing(this.#connectionId, path, collected);
    this.#logger.log('debug', 'list', {
      path: path.value,
      entries: collected.length,
      cache: 'miss',
      ms: Date.now() - started,
    });
  }

  readFile(path: RemotePath, options?: ReadOptions): Promise<Uint8Array> {
    return this.#timed(
      'read',
      { path: path.value },
      () => this.#inner.readFile(path, options),
      (data) => ({ bytes: data.byteLength }),
    );
  }

  /** Timed to the stream opening, not to its end: the caller owns the rest. */
  createReadStream(path: RemotePath, options?: ReadOptions): Promise<ReadableStream<Uint8Array>> {
    return this.#timed('open read stream', { path: path.value }, () =>
      this.#inner.createReadStream(path, options),
    );
  }

  async writeFile(path: RemotePath, data: Uint8Array, options?: WriteOptions): Promise<void> {
    this.#assertWritable('write');
    await this.#timed('write', { path: path.value, bytes: data.byteLength }, async () => {
      if (options?.createParents !== false) await this.#ensureParents(path, options?.signal);
      await this.#inner.writeFile(path, data, options);
    });
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
    const createWriteStream = this.#inner.createWriteStream.bind(this.#inner);
    const stream = await this.#timed('open write stream', { path: path.value }, async () => {
      if (options?.createParents !== false) await this.#ensureParents(path, options?.signal);
      return createWriteStream(path, options);
    });
    return this.#invalidateOnClose(stream, path);
  }

  /**
   * Invalidation has to wait for the bytes to land. Dropping the cache entry
   * when the stream *opens* leaves a window in which a stat — a tree refresh
   * during an upload, say — re-caches the pre-write size, and nothing clears it
   * again once the write finishes. Aborts invalidate too: a partial write is
   * still a change.
   */
  #invalidateOnClose(
    stream: WritableStream<Uint8Array>,
    path: RemotePath,
  ): WritableStream<Uint8Array> {
    const writer = stream.getWriter();
    return new WritableStream<Uint8Array>({
      write: async (chunk) => {
        try {
          await writer.write(chunk);
        } catch (error) {
          // A stream that errors never calls its sink's `abort`, so this is the
          // only place a failed write can clear the entry. Bytes may well have
          // landed before it failed.
          this.#afterMutation(path);
          throw error;
        }
      },
      close: async () => {
        await writer.close();
        this.#afterMutation(path);
      },
      abort: async (reason) => {
        await writer.abort(reason);
        this.#afterMutation(path);
      },
    });
  }

  async delete(path: RemotePath, options?: DeleteOptions): Promise<void> {
    this.#assertWritable('delete');

    const recursive = options?.recursive === true;
    const emulated = recursive && !this.#inner.capabilities.canDeleteRecursive;
    await this.#timed('delete', { path: path.value, recursive, emulated }, () =>
      emulated ? this.#deleteRecursiveByWalk(path, options) : this.#inner.delete(path, options),
    );

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

    const createDirectory = this.#inner.createDirectory.bind(this.#inner);
    await this.#timed('mkdir', { path: path.value }, () => createDirectory(path, signal));
    this.#afterMutation(path);
  }

  async rename(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    this.#assertWritable('rename');

    const native =
      this.#inner.rename !== undefined && this.#inner.capabilities.canRename
        ? this.#inner.rename.bind(this.#inner)
        : undefined;
    await this.#timed(
      'rename',
      { from: from.value, to: to.value, emulated: native === undefined },
      async () => {
        if (native !== undefined) {
          await native(from, to, options);
          return;
        }
        // S3 and friends: emulate. Not atomic — if the delete fails the copy
        // stays, which is the safe direction to fail in.
        await this.copy(from, to, options);
        await this.delete(from, {
          recursive: true,
          ...(options?.signal ? { signal: options.signal } : {}),
        });
      },
    );

    this.#cache.invalidateSubtree(this.#connectionId, from);
    this.#cache.invalidateChildren(this.#connectionId, from.parent);
    this.#cache.invalidateChildren(this.#connectionId, to.parent);
  }

  async copy(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    this.#assertWritable('copy');

    if (options?.overwrite === false && (await this.#exists(to, options.signal))) {
      throw OmniFsError.alreadyExists(to.value);
    }

    const serverSide =
      this.#inner.copy !== undefined && this.#inner.capabilities.canCopyServerSide
        ? this.#inner.copy.bind(this.#inner)
        : undefined;
    await this.#timed(
      'copy',
      { from: from.value, to: to.value, serverSide: serverSide !== undefined },
      () =>
        serverSide !== undefined
          ? serverSide(from, to, options)
          : this.#copyByStream(from, to, options),
    );

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

    // Piping holds a read stream and a write stream open at once, which is two
    // operations in flight on one connection. `maxConcurrency` is the
    // provider's own declaration of how many it can carry, and at 1 the second
    // acquire queues behind a stream that cannot drain until it is granted:
    // `provider-ftp` at its default `maxConnections: 1` wedges there forever —
    // no timeout, and VS Code's copy passes no signal to cancel it — taking
    // every later call on that connection down with it. A provider that raises
    // its ceiling gets this path back automatically.
    if (
      this.#inner.createWriteStream !== undefined &&
      this.#inner.capabilities.canStreamWrite &&
      this.#inner.capabilities.maxConcurrency >= 2
    ) {
      const sink = await this.#inner.createWriteStream(
        to,
        options?.signal ? { signal: options.signal } : undefined,
      );
      await source.pipeTo(sink, options?.signal ? { signal: options.signal } : undefined);
      return;
    }

    // Buffer instead. Two different providers land here: one that can neither
    // copy server-side nor stream a write, and — because of the gate above —
    // one whose connection carries a single operation at a time. The cost is
    // stated rather than hidden: this holds the *whole file* in memory before a
    // byte of it is written, so a copy costs its own size in RAM. For the
    // single-channel case that is the price of not deadlocking the connection.
    // The log line is where a large one becomes visible.
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

  /**
   * A connection saved read-only reports every entry read-only, which is what
   * `FileStat.readOnly` already means: "read-only for the current
   * credentials". Refusing the write is only half of the flag — a host turns
   * *this* into a read-only editor, and without it the user types into an
   * ordinary one and discovers the refusal at save time.
   *
   * Applied on the way out rather than before `setStat`, so the cache keeps
   * what the provider actually said. Two things depend on that: a cached stat
   * outlives the wrapper that cached it — the same connection id is re-wrapped
   * with a freshly read flag on the next connect — and `EntryCache.setListing`
   * fills the stat cache from a listing, which never passes through here.
   */
  #stampReadOnly(stat: FileStat): FileStat {
    return this.#readOnly ? { ...stat, readOnly: true } : stat;
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

  /**
   * One `debug` line per operation that reached the provider: what it was,
   * how long it took, and — when it failed — the code a host switches on and
   * whether a retry could help. Failures are rethrown untouched; this only
   * watches. The level is `debug` for both outcomes on purpose: the host
   * already reports a failure the user sees, and this line is its context.
   */
  async #timed<T>(
    operation: string,
    data: Record<string, unknown>,
    body: () => Promise<T>,
    describeResult?: (value: T) => Record<string, unknown>,
  ): Promise<T> {
    const started = Date.now();
    try {
      const value = await body();
      this.#logger.log('debug', operation, {
        ...data,
        ...describeResult?.(value),
        ms: Date.now() - started,
      });
      return value;
    } catch (error) {
      this.#logger.log('debug', `${operation} failed`, {
        ...data,
        ...describeFailure(error),
        ms: Date.now() - started,
      });
      throw error;
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

function describeFailure(error: unknown): Record<string, unknown> {
  return OmniFsError.is(error)
    ? { code: error.code, retryable: error.retryable }
    : { error: error instanceof Error ? error.message : String(error) };
}
