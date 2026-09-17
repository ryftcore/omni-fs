import type { DirEntry, FileStat } from '../model/stat.js';
import type { RemotePath } from '../model/path.js';

/**
 * TTL cache for stat results and directory listings.
 *
 * Caching lives here rather than inside each provider so all four protocols
 * behave identically and a staleness bug is fixed once. It also keeps providers
 * as thin, obvious translation layers — easy to review, easy to contribute to.
 *
 * Correctness rule: every mutation must invalidate the target path *and* the
 * parent's listing, or the tree shows a deleted file until the TTL expires.
 * `CachedFileSystem` does this for you; do not hand-roll around it.
 *
 * Entries are nested per connection rather than kept in one map under a
 * composite string key, so disconnecting a connection drops its whole cache in
 * O(1) and no separator character can collide with a remote path.
 */
export interface EntryCacheOptions {
  readonly ttlMs?: number;
  /** Ceiling per connection, not global. Keeps one huge bucket from evicting others. */
  readonly maxEntriesPerConnection?: number;
}

interface CacheRecord<T> {
  readonly value: T;
  readonly expiresAt: number;
}

interface ConnectionCache {
  readonly stats: Map<string, CacheRecord<FileStat>>;
  readonly listings: Map<string, CacheRecord<readonly DirEntry[]>>;
}

export class EntryCache {
  readonly #byConnection = new Map<string, ConnectionCache>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;

  constructor(options: EntryCacheOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 15_000;
    this.#maxEntries = options.maxEntriesPerConnection ?? 5_000;
  }

  getStat(connectionId: string, path: RemotePath): FileStat | undefined {
    return read(this.#byConnection.get(connectionId)?.stats, path.value);
  }

  setStat(connectionId: string, path: RemotePath, stat: FileStat): void {
    write(this.#for(connectionId).stats, path.value, stat, this.#ttlMs, this.#maxEntries);
  }

  getListing(connectionId: string, path: RemotePath): readonly DirEntry[] | undefined {
    return read(this.#byConnection.get(connectionId)?.listings, path.value);
  }

  setListing(connectionId: string, path: RemotePath, entries: readonly DirEntry[]): void {
    const cache = this.#for(connectionId);
    write(cache.listings, path.value, entries, this.#ttlMs, this.#maxEntries);
    // A fresh listing already carries every child's stat — record them so that
    // expanding a folder and then opening a file in it costs one round trip.
    for (const entry of entries) {
      write(cache.stats, entry.path.value, entry, this.#ttlMs, this.#maxEntries);
    }
  }

  /** Drops this path's stat and, if it is a directory, its listing. */
  invalidate(connectionId: string, path: RemotePath): void {
    const cache = this.#byConnection.get(connectionId);
    if (cache === undefined) return;
    cache.stats.delete(path.value);
    cache.listings.delete(path.value);
  }

  /** Drops a directory's listing without discarding its own stat. */
  invalidateChildren(connectionId: string, path: RemotePath): void {
    this.#byConnection.get(connectionId)?.listings.delete(path.value);
  }

  /** Drops this path and everything beneath it. Use after a recursive delete. */
  invalidateSubtree(connectionId: string, path: RemotePath): void {
    const cache = this.#byConnection.get(connectionId);
    if (cache === undefined) return;

    for (const map of [cache.stats, cache.listings]) {
      for (const key of [...map.keys()]) {
        if (key === path.value || key.startsWith(path.isRoot ? '/' : `${path.value}/`)) {
          map.delete(key);
        }
      }
    }
  }

  invalidateConnection(connectionId: string): void {
    this.#byConnection.delete(connectionId);
  }

  clear(): void {
    this.#byConnection.clear();
  }

  #for(connectionId: string): ConnectionCache {
    let cache = this.#byConnection.get(connectionId);
    if (cache === undefined) {
      cache = { stats: new Map(), listings: new Map() };
      this.#byConnection.set(connectionId, cache);
    }
    return cache;
  }
}

function read<T>(map: Map<string, CacheRecord<T>> | undefined, key: string): T | undefined {
  const record = map?.get(key);
  if (record === undefined) return undefined;
  if (record.expiresAt <= Date.now()) {
    map?.delete(key);
    return undefined;
  }
  return record.value;
}

function write<T>(
  map: Map<string, CacheRecord<T>>,
  key: string,
  value: T,
  ttlMs: number,
  maxEntries: number,
): void {
  // Crude but adequate eviction: drop the oldest insertion when full. `Map`
  // preserves insertion order, so the first key is the oldest.
  if (map.size >= maxEntries && !map.has(key)) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
}
