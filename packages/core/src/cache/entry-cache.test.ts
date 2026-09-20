import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntryCache } from './entry-cache.js';
import { RemotePath } from '../model/path.js';
import type { DirEntry, FileStat } from '../model/stat.js';

/**
 * The cache's correctness rule is stated in its own header: every mutation must
 * drop the target path *and* the parent's listing, or the tree shows a deleted
 * file until the TTL expires. `ManagedFileSystem` is what applies that rule;
 * these tests pin the primitives it applies it with.
 */

const A = 'connection-a';
const B = 'connection-b';

const p = (value: string): RemotePath => RemotePath.parse(value);

function stat(size = 1): FileStat {
  return { type: 'file', size };
}

function entry(path: string, size = 1): DirEntry {
  const remote = p(path);
  return { type: 'file', size, name: remote.basename, path: remote };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('EntryCache', () => {
  describe('round trips', () => {
    it('returns a stored stat', () => {
      const cache = new EntryCache();
      cache.setStat(A, p('/a/one.txt'), stat(5));

      expect(cache.getStat(A, p('/a/one.txt'))?.size).toBe(5);
    });

    it('returns a stored listing', () => {
      const cache = new EntryCache();
      cache.setListing(A, p('/a'), [entry('/a/one.txt')]);

      expect(cache.getListing(A, p('/a'))?.map((item) => item.name)).toEqual(['one.txt']);
    });

    it('misses for a path that was never stored', () => {
      const cache = new EntryCache();

      expect(cache.getStat(A, p('/nothing'))).toBeUndefined();
      expect(cache.getListing(A, p('/nothing'))).toBeUndefined();
    });

    it('records each listed child as a stat, so opening a listed file is free', () => {
      const cache = new EntryCache();
      cache.setListing(A, p('/a'), [entry('/a/one.txt', 11), entry('/a/two.txt', 22)]);

      expect(cache.getStat(A, p('/a/one.txt'))?.size).toBe(11);
      expect(cache.getStat(A, p('/a/two.txt'))?.size).toBe(22);
    });
  });

  describe('expiry', () => {
    it('stops serving an entry once its TTL has passed', () => {
      vi.useFakeTimers();
      const cache = new EntryCache({ ttlMs: 1_000 });
      cache.setStat(A, p('/a/one.txt'), stat());
      cache.setListing(A, p('/a'), [entry('/a/one.txt')]);

      vi.advanceTimersByTime(999);
      expect(cache.getStat(A, p('/a/one.txt'))).toBeDefined();

      vi.advanceTimersByTime(2);
      expect(cache.getStat(A, p('/a/one.txt'))).toBeUndefined();
      expect(cache.getListing(A, p('/a'))).toBeUndefined();
    });

    it('re-stamps an entry that is written again', () => {
      vi.useFakeTimers();
      const cache = new EntryCache({ ttlMs: 1_000 });
      cache.setStat(A, p('/a/one.txt'), stat(1));

      vi.advanceTimersByTime(900);
      cache.setStat(A, p('/a/one.txt'), stat(2));
      vi.advanceTimersByTime(900);

      expect(cache.getStat(A, p('/a/one.txt'))?.size).toBe(2);
    });
  });

  describe('invalidation', () => {
    it('invalidate drops the path stat and its own listing', () => {
      const cache = new EntryCache();
      cache.setStat(A, p('/a'), stat());
      cache.setListing(A, p('/a'), [entry('/a/one.txt')]);

      cache.invalidate(A, p('/a'));

      expect(cache.getStat(A, p('/a'))).toBeUndefined();
      expect(cache.getListing(A, p('/a'))).toBeUndefined();
    });

    it('invalidateChildren drops the listing but keeps the directory stat', () => {
      const cache = new EntryCache();
      cache.setStat(A, p('/a'), stat());
      cache.setListing(A, p('/a'), [entry('/a/one.txt')]);

      cache.invalidateChildren(A, p('/a'));

      // The directory still exists and its own metadata is unchanged; only its
      // contents are now unknown.
      expect(cache.getStat(A, p('/a'))).toBeDefined();
      expect(cache.getListing(A, p('/a'))).toBeUndefined();
    });

    it('invalidateSubtree drops descendants as well as the path itself', () => {
      const cache = new EntryCache();
      cache.setStat(A, p('/a/tree'), stat());
      cache.setStat(A, p('/a/tree/deep/one.txt'), stat());
      cache.setListing(A, p('/a/tree/deep'), [entry('/a/tree/deep/one.txt')]);

      cache.invalidateSubtree(A, p('/a/tree'));

      expect(cache.getStat(A, p('/a/tree'))).toBeUndefined();
      expect(cache.getStat(A, p('/a/tree/deep/one.txt'))).toBeUndefined();
      expect(cache.getListing(A, p('/a/tree/deep'))).toBeUndefined();
    });

    it('invalidateSubtree spares a sibling whose name merely starts the same', () => {
      const cache = new EntryCache();
      cache.setStat(A, p('/a/tree'), stat());
      cache.setStat(A, p('/a/tree-other'), stat());

      cache.invalidateSubtree(A, p('/a/tree'));

      // A prefix match without the separator would take `/a/tree-other` too.
      expect(cache.getStat(A, p('/a/tree-other'))).toBeDefined();
    });

    it('invalidateSubtree at the root clears the whole connection', () => {
      const cache = new EntryCache();
      cache.setStat(A, p('/a/one.txt'), stat());
      cache.setListing(A, p('/b'), [entry('/b/two.txt')]);

      cache.invalidateSubtree(A, p('/'));

      expect(cache.getStat(A, p('/a/one.txt'))).toBeUndefined();
      expect(cache.getListing(A, p('/b'))).toBeUndefined();
    });

    it('tolerates invalidating a connection it has never seen', () => {
      const cache = new EntryCache();

      expect(() => cache.invalidate(A, p('/a'))).not.toThrow();
      expect(() => cache.invalidateChildren(A, p('/a'))).not.toThrow();
      expect(() => cache.invalidateSubtree(A, p('/a'))).not.toThrow();
    });
  });

  describe('connection isolation', () => {
    it('keeps identical paths on different connections apart', () => {
      const cache = new EntryCache();
      cache.setStat(A, p('/same.txt'), stat(1));
      cache.setStat(B, p('/same.txt'), stat(2));

      expect(cache.getStat(A, p('/same.txt'))?.size).toBe(1);
      expect(cache.getStat(B, p('/same.txt'))?.size).toBe(2);
    });

    it('invalidateConnection drops one connection and leaves the other', () => {
      const cache = new EntryCache();
      cache.setStat(A, p('/same.txt'), stat(1));
      cache.setStat(B, p('/same.txt'), stat(2));

      cache.invalidateConnection(A);

      expect(cache.getStat(A, p('/same.txt'))).toBeUndefined();
      expect(cache.getStat(B, p('/same.txt'))?.size).toBe(2);
    });

    it('clear drops every connection', () => {
      const cache = new EntryCache();
      cache.setStat(A, p('/same.txt'), stat());
      cache.setStat(B, p('/same.txt'), stat());

      cache.clear();

      expect(cache.getStat(A, p('/same.txt'))).toBeUndefined();
      expect(cache.getStat(B, p('/same.txt'))).toBeUndefined();
    });
  });

  describe('eviction', () => {
    it('drops the oldest entry once a connection is full', () => {
      const cache = new EntryCache({ maxEntriesPerConnection: 2 });
      cache.setStat(A, p('/one.txt'), stat());
      cache.setStat(A, p('/two.txt'), stat());

      cache.setStat(A, p('/three.txt'), stat());

      expect(cache.getStat(A, p('/one.txt'))).toBeUndefined();
      expect(cache.getStat(A, p('/two.txt'))).toBeDefined();
      expect(cache.getStat(A, p('/three.txt'))).toBeDefined();
    });

    it('overwriting an existing key does not evict anything', () => {
      const cache = new EntryCache({ maxEntriesPerConnection: 2 });
      cache.setStat(A, p('/one.txt'), stat(1));
      cache.setStat(A, p('/two.txt'), stat(1));

      cache.setStat(A, p('/one.txt'), stat(9));

      expect(cache.getStat(A, p('/one.txt'))?.size).toBe(9);
      expect(cache.getStat(A, p('/two.txt'))).toBeDefined();
    });

    it('caps each connection separately rather than globally', () => {
      const cache = new EntryCache({ maxEntriesPerConnection: 2 });
      cache.setStat(A, p('/one.txt'), stat());
      cache.setStat(A, p('/two.txt'), stat());

      // One busy connection must not evict another's entries.
      cache.setStat(B, p('/one.txt'), stat());
      cache.setStat(B, p('/two.txt'), stat());

      expect(cache.getStat(A, p('/one.txt'))).toBeDefined();
      expect(cache.getStat(A, p('/two.txt'))).toBeDefined();
    });
  });
});
