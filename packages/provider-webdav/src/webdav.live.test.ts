import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER, OmniFsError, RemotePath } from '@omni-fs/core';
import type { ConnectionConfig } from '@omni-fs/core';
import { createClient } from 'webdav';
import { WebdavFileSystem } from './webdav-file-system.js';

const BASE_URL = process.env['OMNI_FS_WEBDAV_URL'] ?? 'http://localhost:8081';
const USERNAME = process.env['OMNI_FS_WEBDAV_USER'] ?? 'omnifs';
const PASSWORD = process.env['OMNI_FS_WEBDAV_PASSWORD'] ?? 'omnifs-dev-secret';

export function connect(password: string = PASSWORD): WebdavFileSystem {
  const config: ConnectionConfig = {
    id: 'live',
    providerId: 'webdav',
    label: 'live',
    settings: { baseUrl: BASE_URL, authType: 'password', username: USERNAME },
  };
  return new WebdavFileSystem({
    config,
    getSecret: async () => ({ password }),
    logger: NOOP_LOGGER,
  });
}

/**
 * Cleanup goes through the raw client on purpose: it must still work when the
 * method under test does not, or a failing `delete` would leave the seeded
 * tree dirty for every task after this one. Name a collection with a trailing
 * slash — the server then removes it and everything under it.
 */
async function remove(path: string): Promise<void> {
  const client = createClient(BASE_URL, { username: USERNAME, password: PASSWORD });
  await client.deleteFile(path).catch(() => undefined);
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('WebdavFileSystem against a live server', () => {
  it('connects and stats the root as a directory', async () => {
    const fs = connect();
    try {
      await fs.connect();
      // Local state only — `connect()` does no I/O. The `stat` below is what
      // actually proves the server is reachable and the credentials work.
      expect(fs.isAlive()).toBe(true);
      expect((await fs.stat(RemotePath.ROOT)).type).toBe('directory');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('lists the seeded tree, distinguishing files from directories', async () => {
    const fs = connect();
    try {
      await fs.connect();
      const entries = [];
      for await (const entry of fs.list(RemotePath.ROOT)) entries.push(entry);
      const byName = new Map(entries.map((entry) => [entry.name, entry]));
      expect(byName.get('readme.txt')?.type).toBe('file');
      expect(byName.get('docs')?.type).toBe('directory');
      // Entry paths must be absolute and resolvable, not bare names.
      expect(byName.get('readme.txt')?.path.value).toBe('/readme.txt');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('reports a missing path as NotFound', async () => {
    const fs = connect();
    try {
      await fs.connect();
      await expect(fs.stat(RemotePath.parse('/definitely-not-here.txt'))).rejects.toSatisfy(
        (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
      );
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('reads a whole file', async () => {
    const fs = connect();
    await fs.connect();
    try {
      const bytes = await fs.readFile(RemotePath.parse('/readme.txt'));
      expect(new TextDecoder().decode(bytes)).toContain('omni-fs test file');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('reads a byte range', async () => {
    const fs = connect();
    await fs.connect();
    try {
      // The seeded readme.txt is exactly "omni-fs test file\n".
      const slice = await fs.readFile(RemotePath.parse('/readme.txt'), { offset: 0, length: 7 });
      expect(new TextDecoder().decode(slice)).toBe('omni-fs');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('rejects readFile for a missing path with a translated NotFound', async () => {
    const fs = connect();
    await fs.connect();
    try {
      await expect(fs.readFile(RemotePath.parse('/definitely-not-here.txt'))).rejects.toSatisfy(
        (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
      );
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('errors the stream from createReadStream with a translated NotFound', async () => {
    const fs = connect();
    await fs.connect();
    try {
      const stream = await fs.createReadStream(RemotePath.parse('/definitely-not-here.txt'));
      const reader = stream.getReader();
      await expect(reader.read()).rejects.toSatisfy(
        (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
      );
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('reads no bytes for a zero-length range, but still checks the path exists', async () => {
    const fs = connect();
    try {
      await fs.connect();
      const empty = await fs.readFile(RemotePath.parse('/readme.txt'), { offset: 3, length: 0 });
      expect(empty.byteLength).toBe(0);

      // A range with no Range spelling is answered without one — but existence
      // is still the server's to decide, or a read of a missing path would
      // come back as an empty success. MemoryFileSystem raises NotFound here.
      await expect(
        fs.readFile(RemotePath.parse('/definitely-not-here.txt'), { offset: 0, length: 0 }),
      ).rejects.toSatisfy((error: unknown) => OmniFsError.is(error) && error.code === 'NotFound');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('reports a zero-length read through an aborted signal as Cancelled', async () => {
    const fs = connect();
    try {
      await fs.connect();
      await expect(
        fs.readFile(RemotePath.parse('/readme.txt'), {
          offset: 0,
          length: 0,
          signal: AbortSignal.abort(),
        }),
      ).rejects.toSatisfy((error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('reports a read cancelled by its signal as Cancelled', async () => {
    const fs = connect();
    try {
      await fs.connect();
      // An already-aborted signal is the deterministic version of a cancelled
      // transfer: the client rejects with an AbortError, which must not reach
      // a caller as anything other than OmniFsError/Cancelled.
      await expect(
        fs.readFile(RemotePath.parse('/readme.txt'), { signal: AbortSignal.abort() }),
      ).rejects.toSatisfy((error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('round-trips a write and refuses to overwrite when told not to', async () => {
    const fs = connect();
    const path = RemotePath.parse('/write-probe.txt');
    try {
      await fs.connect();
      await fs.writeFile(path, encode('first'));
      expect(decode(await fs.readFile(path))).toBe('first');

      await expect(fs.writeFile(path, encode('second'), { overwrite: false })).rejects.toSatisfy(
        (error: unknown) => OmniFsError.is(error) && error.code === 'AlreadyExists',
      );
      // The guard has to stop the PUT, not just report it: this server ignores
      // `If-None-Match: *`, so a write that reached it would have landed.
      expect(decode(await fs.readFile(path))).toBe('first');
    } finally {
      await remove('/write-probe.txt');
      await fs[Symbol.asyncDispose]();
    }
  });

  it('writes into a collection that does not exist yet', async () => {
    const fs = connect();
    const path = RemotePath.parse('/write-parents-probe/deep/nested.txt');
    try {
      await fs.connect();
      await fs.writeFile(path, encode('nested'));
      expect(decode(await fs.readFile(path))).toBe('nested');
    } finally {
      await remove('/write-parents-probe/');
      await fs[Symbol.asyncDispose]();
    }
  });

  it('streams a write whose bytes are all on the server once the writer closes', async () => {
    const fs = connect();
    const path = RemotePath.parse('/write-stream-probe.txt');
    try {
      await fs.connect();
      const writer = (await fs.createWriteStream(path)).getWriter();
      await writer.write(encode('chunk-one|'));
      await writer.write(encode('chunk-two'));
      await writer.close();
      // Read back straight after close(): the PUT must have completed, not
      // merely been queued.
      expect(decode(await fs.readFile(path))).toBe('chunk-one|chunk-two');
    } finally {
      await remove('/write-stream-probe.txt');
      await fs[Symbol.asyncDispose]();
    }
  });

  it('fails a write stream the server rejected instead of reporting success', async () => {
    // Measured: a bare `Writable.toWeb` wrapper resolves both write() and
    // close() against a 401 — the bytes are dropped and the caller is told the
    // write worked. close() must wait for the server's answer and translate it.
    const fs = connect('definitely-the-wrong-password');
    const path = RemotePath.parse('/write-stream-unauthorised.txt');
    try {
      await fs.connect();
      const writer = (await fs.createWriteStream(path)).getWriter();
      await writer.write(encode('never lands')).catch(() => undefined);
      await expect(writer.close()).rejects.toSatisfy(
        (error: unknown) => OmniFsError.is(error) && error.code === 'AuthenticationFailed',
      );
    } finally {
      await remove('/write-stream-unauthorised.txt');
      await fs[Symbol.asyncDispose]();
    }
  });

  it('refuses a streamed overwrite when told not to', async () => {
    const fs = connect();
    const path = RemotePath.parse('/write-stream-guard.txt');
    try {
      await fs.connect();
      await fs.writeFile(path, encode('first'));
      await expect(fs.createWriteStream(path, { overwrite: false })).rejects.toSatisfy(
        (error: unknown) => OmniFsError.is(error) && error.code === 'AlreadyExists',
      );
      expect(decode(await fs.readFile(path))).toBe('first');
    } finally {
      await remove('/write-stream-guard.txt');
      await fs[Symbol.asyncDispose]();
    }
  });

  it('creates a directory, copies, renames and deletes recursively', async () => {
    const fs = connect();
    const dir = RemotePath.parse('/tree-probe');
    try {
      await fs.connect();
      await fs.createDirectory?.(dir);
      expect((await fs.stat(dir)).type).toBe('directory');

      // Both of these are `recursive: true` and nothing else. A plain MKCOL
      // answers 405 for the repeat and 409 for the missing intermediate, so
      // simplifying the option away fails here rather than quietly changing
      // what createDirectory means.
      await expect(fs.createDirectory?.(dir)).resolves.toBeUndefined();
      await fs.createDirectory?.(dir.join('nested', 'deep'));
      expect((await fs.stat(dir.join('nested'))).type).toBe('directory');
      expect((await fs.stat(dir.join('nested', 'deep'))).type).toBe('directory');

      const source = dir.join('source.txt');
      await fs.writeFile(source, encode('payload'));

      await fs.copy?.(source, dir.join('copy.txt'));
      expect(decode(await fs.readFile(dir.join('copy.txt')))).toBe('payload');
      // COPY leaves the source where it is; MOVE is the one that does not.
      expect((await fs.stat(source)).type).toBe('file');

      await fs.rename?.(source, dir.join('moved.txt'));
      expect(decode(await fs.readFile(dir.join('moved.txt')))).toBe('payload');
      await expect(fs.stat(source)).rejects.toSatisfy(
        (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
      );

      // Measured: this server takes a non-empty collection out in a single
      // DELETE, which is what `canDeleteRecursive: true` promises.
      await fs.delete(dir, { recursive: true });
      await expect(fs.stat(dir)).rejects.toSatisfy(
        (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
      );
    } finally {
      await remove('/tree-probe/');
      await fs[Symbol.asyncDispose]();
    }
  });

  it('refuses a non-recursive delete of a directory with children, but not of an empty one', async () => {
    const fs = connect();
    const dir = RemotePath.parse('/delete-probe');
    const child = dir.join('child.txt');
    try {
      await fs.connect();
      await fs.writeFile(child, encode('child'));

      // A WebDAV DELETE on a collection always takes its children with it —
      // `Depth: infinity` is the only value the method allows — so nothing but
      // this provider can refuse a non-recursive delete, and getting it wrong
      // destroys a tree the caller only asked to remove if it was empty.
      await expect(fs.delete(dir)).rejects.toSatisfy(
        (error: unknown) => OmniFsError.is(error) && error.code === 'NotEmpty',
      );
      expect(decode(await fs.readFile(child))).toBe('child');

      await fs.delete(child);
      await fs.delete(dir);
      await expect(fs.stat(dir)).rejects.toSatisfy(
        (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
      );
    } finally {
      await remove('/delete-probe/');
      await fs[Symbol.asyncDispose]();
    }
  });

  it('refuses to overwrite an existing destination on copy and on rename', async () => {
    const fs = connect();
    const dir = RemotePath.parse('/overwrite-probe');
    const source = dir.join('source.txt');
    const destination = dir.join('destination.txt');
    try {
      await fs.connect();
      await fs.writeFile(source, encode('source'));
      await fs.writeFile(destination, encode('destination'));

      // `Overwrite: F` is honoured here, unlike the `If-None-Match: *` that
      // `writeFile` sends, so the server itself refuses with 412. The shared
      // mapping reads a 412 as `Conflict` — right for a failed `If-Match`, and
      // wrong here, where `overwrite: false` says it means the destination is
      // already there.
      await expect(fs.copy?.(source, destination, { overwrite: false })).rejects.toSatisfy(
        (error: unknown) => OmniFsError.is(error) && error.code === 'AlreadyExists',
      );
      await expect(fs.rename?.(source, destination, { overwrite: false })).rejects.toSatisfy(
        (error: unknown) => OmniFsError.is(error) && error.code === 'AlreadyExists',
      );
      expect(decode(await fs.readFile(destination))).toBe('destination');
      // A refused MOVE must not have taken the source with it either.
      expect(decode(await fs.readFile(source))).toBe('source');

      // Overwriting is still what happens when nothing says otherwise.
      await fs.copy?.(source, destination);
      expect(decode(await fs.readFile(destination))).toBe('source');
    } finally {
      await remove('/overwrite-probe/');
      await fs[Symbol.asyncDispose]();
    }
  });

  it('reports each of the four mutations cancelled by its signal as Cancelled', async () => {
    // All four reach the network, so `provider.ts` requires them to carry the
    // caller's signal that far. An already-aborted one is the deterministic
    // proof that they do — and the probe tree is untouched afterwards, which
    // is what a dropped signal would break.
    const fs = connect();
    const dir = RemotePath.parse('/signal-probe');
    const source = dir.join('source.txt');
    const cancelled = (error: unknown): boolean =>
      OmniFsError.is(error) && error.code === 'Cancelled';
    try {
      await fs.connect();
      await fs.writeFile(source, encode('source'));

      await expect(fs.createDirectory?.(dir.join('nested'), AbortSignal.abort())).rejects.toSatisfy(
        cancelled,
      );
      // `recursive` on purpose: without it the emptiness check would cancel
      // the call before DELETE was ever sent, proving nothing about deleteFile.
      await expect(
        fs.delete(source, { recursive: true, signal: AbortSignal.abort() }),
      ).rejects.toSatisfy(cancelled);
      await expect(
        fs.copy?.(source, dir.join('copied.txt'), { signal: AbortSignal.abort() }),
      ).rejects.toSatisfy(cancelled);
      await expect(
        fs.rename?.(source, dir.join('moved.txt'), { signal: AbortSignal.abort() }),
      ).rejects.toSatisfy(cancelled);

      expect(decode(await fs.readFile(source))).toBe('source');
      for await (const entry of fs.list(dir)) expect(entry.name).toBe('source.txt');
    } finally {
      await remove('/signal-probe/');
      await fs[Symbol.asyncDispose]();
    }
  });

  it('leaves the seeded root exactly as it found it', async () => {
    // Runs last on purpose. Every test above removes what it wrote, on the
    // failure path too; later tasks assert on this tree.
    const fs = connect();
    try {
      await fs.connect();
      const names: string[] = [];
      for await (const entry of fs.list(RemotePath.ROOT)) names.push(entry.name);
      expect(names.sort()).toEqual(['data', 'docs', 'readme.txt']);
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });
});
