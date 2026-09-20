import { describe, expect, it, vi } from 'vitest';
import { EntryCache, ManagedFileSystem, NOOP_LOGGER, OmniFsError, RemotePath } from '@omni-fs/core';
import type { DirEntry, ProviderCapabilities } from '@omni-fs/core';
import { MemoryFileSystem } from './memory-file-system.js';

/**
 * `ManagedFileSystem` is the layer that makes every protocol look alike, so the
 * only honest way to test it is to run one set of expectations against a
 * provider that supports everything and again against one that supports almost
 * nothing. The second profile is what actually executes the emulation — rename
 * becomes copy-plus-delete, recursive delete becomes a walk, mkdir becomes a
 * no-op — and a rule that holds in both profiles is a rule a host can rely on
 * without asking which protocol it is talking to.
 *
 * These live here rather than beside the class because they need
 * `MemoryFileSystem`, and `@omni-fs/core` cannot depend on `@omni-fs/testing`
 * without a cycle. That is the same reason `probe.test.ts` hand-rolls a stub.
 */

const CONNECTION = 'c1';

interface Harness {
  readonly inner: MemoryFileSystem;
  readonly cache: EntryCache;
  readonly fs: ManagedFileSystem;
}

function harness(
  capabilities: Partial<ProviderCapabilities> = {},
  options: { readOnly?: boolean } = {},
): Harness {
  const inner = new MemoryFileSystem({ capabilities });
  const cache = new EntryCache();
  const fs = new ManagedFileSystem({
    connectionId: CONNECTION,
    inner,
    cache,
    logger: NOOP_LOGGER,
    ...(options.readOnly === true ? { readOnly: true } : {}),
  });
  return { inner, cache, fs };
}

const p = (value: string): RemotePath => RemotePath.parse(value);
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

async function names(entries: AsyncIterable<DirEntry>): Promise<string[]> {
  const collected: string[] = [];
  for await (const entry of entries) collected.push(entry.name);
  return collected.sort();
}

async function read(fs: ManagedFileSystem, path: string): Promise<string> {
  return new TextDecoder().decode(await fs.readFile(p(path)));
}

/**
 * Asserting on the error code rather than the message: the code is the contract
 * hosts switch on, and a message is free to change.
 */
async function codeOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (OmniFsError.is(error)) return error.code;
    throw error;
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

/**
 * Capability sets rather than protocol names. Every `false` in the second entry
 * selects a different emulation path, which is the only reason it exists.
 */
const PROFILES: ReadonlyArray<{
  readonly name: string;
  readonly capabilities: Partial<ProviderCapabilities>;
}> = [
  { name: 'native capabilities', capabilities: {} },
  {
    name: 'object-store profile',
    capabilities: {
      hasRealDirectories: false,
      canRename: false,
      canCreateDirectory: false,
      canDeleteRecursive: false,
      canCopyServerSide: false,
    },
  },
];

for (const profile of PROFILES) {
  describe(`ManagedFileSystem (${profile.name})`, () => {
    const make = (options: { readOnly?: boolean } = {}): Harness =>
      harness(profile.capabilities, options);

    describe('caching', () => {
      it('serves a repeated stat without a second round trip', async () => {
        const { inner, fs } = make();
        inner.seed({ '/a/one.txt': 'hello' });
        const spy = vi.spyOn(inner, 'stat');

        const first = await fs.stat(p('/a/one.txt'));
        const second = await fs.stat(p('/a/one.txt'));

        expect(second).toEqual(first);
        expect(spy).toHaveBeenCalledTimes(1);
      });

      it('serves a repeated listing without a second round trip', async () => {
        const { inner, fs } = make();
        inner.seed({ '/a/one.txt': '1', '/a/two.txt': '2' });
        const spy = vi.spyOn(inner, 'list');

        expect(await names(fs.list(p('/a')))).toEqual(['one.txt', 'two.txt']);
        expect(await names(fs.list(p('/a')))).toEqual(['one.txt', 'two.txt']);
        expect(spy).toHaveBeenCalledTimes(1);
      });

      it('does not cache a listing the caller abandoned part way', async () => {
        const { inner, fs } = make();
        inner.seed({ '/a/one.txt': '1', '/a/two.txt': '2' });
        const spy = vi.spyOn(inner, 'list');

        // Caching a partial enumeration would hide half a directory until the
        // TTL expired, which is worse than not caching it at all.
        const iterator = fs.list(p('/a'))[Symbol.asyncIterator]();
        await iterator.next();
        await iterator.return?.(undefined);

        expect(await names(fs.list(p('/a')))).toEqual(['one.txt', 'two.txt']);
        expect(spy).toHaveBeenCalledTimes(2);
      });

      it('shows a written file in its parent listing immediately', async () => {
        const { inner, fs } = make();
        inner.seed({ '/a/one.txt': '1' });
        expect(await names(fs.list(p('/a')))).toEqual(['one.txt']);

        await fs.writeFile(p('/a/two.txt'), bytes('2'));

        expect(await names(fs.list(p('/a')))).toEqual(['one.txt', 'two.txt']);
      });

      it('drops a deleted file from its parent listing immediately', async () => {
        const { inner, fs } = make();
        inner.seed({ '/a/one.txt': '1', '/a/two.txt': '2' });
        expect(await names(fs.list(p('/a')))).toEqual(['one.txt', 'two.txt']);

        await fs.delete(p('/a/two.txt'));

        expect(await names(fs.list(p('/a')))).toEqual(['one.txt']);
      });

      it('reflects an overwrite in a subsequent stat', async () => {
        const { inner, fs } = make();
        inner.seed({ '/a/one.txt': 'short' });
        expect((await fs.stat(p('/a/one.txt'))).size).toBe(5);

        await fs.writeFile(p('/a/one.txt'), bytes('much longer content'));

        expect((await fs.stat(p('/a/one.txt'))).size).toBe(19);
      });
    });

    describe('writes', () => {
      it('creates missing parents on the way to a nested file', async () => {
        const { fs } = make();

        await fs.writeFile(p('/deep/nested/one.txt'), bytes('x'));

        expect(await read(fs, '/deep/nested/one.txt')).toBe('x');
        expect((await fs.stat(p('/deep/nested'))).type).toBe('directory');
      });
    });

    describe('rename', () => {
      it('moves a file and leaves nothing behind', async () => {
        const { inner, fs } = make();
        inner.seed({ '/a/one.txt': 'content' });

        await fs.rename(p('/a/one.txt'), p('/a/two.txt'));

        expect(await read(fs, '/a/two.txt')).toBe('content');
        expect(await codeOf(fs.stat(p('/a/one.txt')))).toBe('NotFound');
      });

      it('moves a directory and everything under it', async () => {
        const { inner, fs } = make();
        inner.seed({ '/a/src/one.txt': '1', '/a/src/deep/two.txt': '2' });

        await fs.rename(p('/a/src'), p('/a/dst'));

        expect(await read(fs, '/a/dst/one.txt')).toBe('1');
        expect(await read(fs, '/a/dst/deep/two.txt')).toBe('2');
        expect(await codeOf(fs.stat(p('/a/src/one.txt')))).toBe('NotFound');
      });

      it('updates both parent listings', async () => {
        const { inner, fs } = make();
        inner.seed({ '/from/one.txt': '1', '/to/keep.txt': 'k' });
        expect(await names(fs.list(p('/from')))).toEqual(['one.txt']);
        expect(await names(fs.list(p('/to')))).toEqual(['keep.txt']);

        await fs.rename(p('/from/one.txt'), p('/to/one.txt'));

        expect(await names(fs.list(p('/to')))).toEqual(['keep.txt', 'one.txt']);
        expect(await names(fs.list(p('/from')))).toEqual([]);
      });
    });

    describe('copy', () => {
      it('duplicates a file, leaving the source in place', async () => {
        const { inner, fs } = make();
        inner.seed({ '/a/one.txt': 'content' });

        await fs.copy(p('/a/one.txt'), p('/a/two.txt'));

        expect(await read(fs, '/a/one.txt')).toBe('content');
        expect(await read(fs, '/a/two.txt')).toBe('content');
      });

      it('refuses to clobber an existing target when overwrite is false', async () => {
        const { inner, fs } = make();
        inner.seed({ '/a/one.txt': 'source', '/a/two.txt': 'target' });

        expect(await codeOf(fs.copy(p('/a/one.txt'), p('/a/two.txt'), { overwrite: false }))).toBe(
          'AlreadyExists',
        );
        expect(await read(fs, '/a/two.txt')).toBe('target');
      });
    });

    describe('delete', () => {
      it('removes a populated directory recursively', async () => {
        const { inner, fs } = make();
        inner.seed({ '/a/tree/one.txt': '1', '/a/tree/deep/two.txt': '2' });

        await fs.delete(p('/a/tree'), { recursive: true });

        expect(await codeOf(fs.stat(p('/a/tree/one.txt')))).toBe('NotFound');
        expect(await codeOf(fs.stat(p('/a/tree/deep/two.txt')))).toBe('NotFound');
      });

      it('drops the whole subtree from the cache, not just the root', async () => {
        const { inner, fs } = make();
        inner.seed({ '/a/tree/one.txt': '1' });
        // Warm the cache for a descendant so a subtree-wide invalidation is the
        // only thing that can make the next stat correct.
        expect((await fs.stat(p('/a/tree/one.txt'))).type).toBe('file');

        await fs.delete(p('/a/tree'), { recursive: true });

        expect(await codeOf(fs.stat(p('/a/tree/one.txt')))).toBe('NotFound');
      });
    });

    describe('read-only connections', () => {
      it('refuses every mutating operation before it reaches the provider', async () => {
        const { inner, fs } = make({ readOnly: true });
        inner.seed({ '/a/one.txt': '1' });
        const writeSpy = vi.spyOn(inner, 'writeFile');
        const deleteSpy = vi.spyOn(inner, 'delete');

        const attempts: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
          ['writeFile', () => fs.writeFile(p('/a/two.txt'), bytes('2'))],
          ['createWriteStream', () => fs.createWriteStream(p('/a/two.txt'))],
          ['delete', () => fs.delete(p('/a/one.txt'))],
          ['createDirectory', () => fs.createDirectory(p('/b'))],
          ['rename', () => fs.rename(p('/a/one.txt'), p('/a/two.txt'))],
          ['copy', () => fs.copy(p('/a/one.txt'), p('/a/two.txt'))],
        ];

        for (const [name, attempt] of attempts) {
          expect(await codeOf(attempt()), name).toBe('PermissionDenied');
        }

        expect(writeSpy).not.toHaveBeenCalled();
        expect(deleteSpy).not.toHaveBeenCalled();
      });

      it('still allows reads', async () => {
        const { inner, fs } = make({ readOnly: true });
        inner.seed({ '/a/one.txt': 'content' });

        expect(await read(fs, '/a/one.txt')).toBe('content');
        expect(await names(fs.list(p('/a')))).toEqual(['one.txt']);
      });

      it('reports the mutating capabilities as unavailable', async () => {
        const { fs } = make({ readOnly: true });

        expect(fs.capabilities.canWrite).toBe(false);
        expect(fs.capabilities.canRename).toBe(false);
        expect(fs.capabilities.canCreateDirectory).toBe(false);
        expect(fs.capabilities.canDeleteRecursive).toBe(false);
      });
    });

    describe('capabilities', () => {
      it('advertises emulated operations as supported', async () => {
        const { fs } = make();

        // The caller is told what it can rely on, not how it is delivered.
        expect(fs.capabilities.canRename).toBe(true);
        expect(fs.capabilities.canCreateDirectory).toBe(true);
        expect(fs.capabilities.canDeleteRecursive).toBe(true);
      });

      it('leaves canCopyServerSide truthful, because it is a cost not a feature', async () => {
        const { inner, fs } = make();

        expect(fs.capabilities.canCopyServerSide).toBe(inner.capabilities.canCopyServerSide);
      });
    });

    it('drops the connection cache and disposes the provider', async () => {
      const { inner, cache, fs } = make();
      inner.seed({ '/a/one.txt': '1' });
      await fs.stat(p('/a/one.txt'));
      expect(cache.getStat(CONNECTION, p('/a/one.txt'))).toBeDefined();

      await fs[Symbol.asyncDispose]();

      expect(cache.getStat(CONNECTION, p('/a/one.txt'))).toBeUndefined();
      expect(inner.isAlive()).toBe(false);
    });
  });
}

/**
 * The cases above assert that behaviour is identical across profiles. These
 * assert that the *route* differs — that the emulation is genuinely running on
 * the object-store profile rather than the provider quietly doing the work.
 */
describe('ManagedFileSystem emulation routing', () => {
  const OBJECT_STORE = PROFILES[1]!.capabilities;

  it('uses the native rename when the provider declares one', async () => {
    const { inner, fs } = harness();
    inner.seed({ '/a/one.txt': '1' });
    const renameSpy = vi.spyOn(inner, 'rename');

    await fs.rename(p('/a/one.txt'), p('/a/two.txt'));

    // Only that the native call was used. How the provider implements it
    // internally is its own business — MemoryFileSystem happens to copy and
    // delete, and asserting otherwise would test the double, not this class.
    expect(renameSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to copy-and-delete when the provider cannot rename', async () => {
    const { inner, fs } = harness(OBJECT_STORE);
    inner.seed({ '/a/one.txt': '1' });
    const renameSpy = vi.spyOn(inner, 'rename');
    const deleteSpy = vi.spyOn(inner, 'delete');

    await fs.rename(p('/a/one.txt'), p('/a/two.txt'));

    expect(renameSpy).not.toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalled();
  });

  it('skips mkdir entirely on a prefix-only provider', async () => {
    const { inner, fs } = harness(OBJECT_STORE);
    const spy = vi.spyOn(inner, 'createDirectory');

    await fs.createDirectory(p('/a/b/c'));

    // Nothing to create: the prefix appears as soon as an object lives under it.
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not walk parents on a prefix-only provider', async () => {
    const { inner, fs } = harness(OBJECT_STORE);
    const spy = vi.spyOn(inner, 'createDirectory');

    await fs.writeFile(p('/deep/nested/one.txt'), bytes('x'));

    expect(spy).not.toHaveBeenCalled();
  });

  it('deletes recursively by walking when the provider cannot', async () => {
    const { inner, fs } = harness(OBJECT_STORE);
    inner.seed({ '/a/tree/one.txt': '1', '/a/tree/deep/two.txt': '2' });
    const spy = vi.spyOn(inner, 'delete');

    await fs.delete(p('/a/tree'), { recursive: true });

    // One call per leaf, rather than a single recursive call the provider
    // cannot honour.
    expect(spy.mock.calls.length).toBeGreaterThan(1);
  });

  it('copies by streaming when the provider cannot copy server-side', async () => {
    const { inner, fs } = harness(OBJECT_STORE);
    inner.seed({ '/a/one.txt': 'content' });
    const copySpy = vi.spyOn(inner, 'copy');
    const streamSpy = vi.spyOn(inner, 'createReadStream');

    await fs.copy(p('/a/one.txt'), p('/a/two.txt'));

    expect(copySpy).not.toHaveBeenCalled();
    expect(streamSpy).toHaveBeenCalledTimes(1);
    expect(await read(fs, '/a/two.txt')).toBe('content');
  });

  it('buffers a copy when the provider can neither copy nor stream a write', async () => {
    const { inner, fs } = harness({ ...OBJECT_STORE, canStreamWrite: false });
    inner.seed({ '/a/one.txt': 'content' });
    const writeSpy = vi.spyOn(inner, 'writeFile');

    await fs.copy(p('/a/one.txt'), p('/a/two.txt'));

    expect(await read(fs, '/a/two.txt')).toBe('content');
    // The last resort: the whole file through memory, with its length declared.
    expect(writeSpy).toHaveBeenCalledWith(
      p('/a/two.txt'),
      expect.anything(),
      expect.objectContaining({ contentLength: 7 }),
    );
  });

  it('returns an inert watcher when the provider cannot watch', async () => {
    const { fs } = harness();

    const subscription = fs.watch(p('/a'), () => {});

    // Core will not silently poll a metered bucket to fake notifications.
    expect(() => subscription[Symbol.dispose]()).not.toThrow();
  });
});

describe('ManagedFileSystem.createWriteStream', () => {
  it('invalidates the cached stat once the stream closes, not when it opens', async () => {
    const { inner, fs } = harness();
    inner.seed({ '/a/one.txt': 'short' });
    expect((await fs.stat(p('/a/one.txt'))).size).toBe(5);

    const stream = await fs.createWriteStream(p('/a/one.txt'));
    // A stat here is what a tree refresh during an upload does. Invalidating
    // only at open time lets this re-cache the pre-write size, and nothing
    // clears it again once the bytes actually land.
    await fs.stat(p('/a/one.txt'));

    const writer = stream.getWriter();
    await writer.write(bytes('much longer content'));
    await writer.close();

    expect((await fs.stat(p('/a/one.txt'))).size).toBe(19);
  });
});
