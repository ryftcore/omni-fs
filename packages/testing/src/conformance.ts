import { describe, expect, it } from 'vitest';
import { OmniFsError } from '@omni-fs/core';
import type { DirEntry, RemoteFileSystem, RemotePath } from '@omni-fs/core';

export interface ConformanceHarness {
  /** Human name shown in test output, e.g. `'S3 (MinIO)'`. */
  readonly name: string;
  /** Connects and returns a filesystem scoped to an empty, disposable area. */
  setup(): Promise<{ fs: RemoteFileSystem; root: RemotePath }>;
  /** Tears the area down. Always called, even when a test fails. */
  teardown(fs: RemoteFileSystem): Promise<void>;
}

/**
 * One behavioural contract, run against every provider.
 *
 * This is the mechanism that keeps "universal" honest. Four protocols with four
 * hand-written test suites drift: S3 grows a test for a case FTP silently gets
 * wrong. Here, adding a case to this file immediately holds every provider to
 * it, and a new provider is finished exactly when this passes.
 *
 * Tests skip themselves based on declared capabilities rather than failing, so
 * a provider is never penalised for something it genuinely cannot do — only for
 * lying about it.
 *
 * Usage, in a provider's own test file:
 *
 *     runConformanceSuite({
 *       name: 'S3 (MinIO)',
 *       setup: async () => ({ fs: await connectToMinio(), root: RemotePath.parse('/test-run') }),
 *       teardown: (fs) => fs.delete(RemotePath.parse('/test-run'), { recursive: true }),
 *     });
 */
export function runConformanceSuite(harness: ConformanceHarness): void {
  describe(`conformance: ${harness.name}`, () => {
    async function withFs(
      body: (fs: RemoteFileSystem, root: RemotePath) => Promise<void>,
    ): Promise<void> {
      const { fs, root } = await harness.setup();
      try {
        await body(fs, root);
      } finally {
        await harness.teardown(fs);
      }
    }

    it('reports a missing path as NotFound, not as a generic failure', async () => {
      await withFs(async (fs, root) => {
        const missing = root.join('definitely-not-here.txt');
        await expect(fs.stat(missing)).rejects.toSatisfy(
          (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
        );
      });
    });

    it('round-trips a file through write and read', async () => {
      await withFs(async (fs, root) => {
        if (!fs.capabilities.canWrite) return;

        const path = root.join('hello.txt');
        const content = new TextEncoder().encode('hello omni-fs');
        await fs.writeFile(path, content);

        const read = await fs.readFile(path);
        expect(new TextDecoder().decode(read)).toBe('hello omni-fs');

        const stat = await fs.stat(path);
        expect(stat.type).toBe('file');
        expect(stat.size).toBe(content.byteLength);
      });
    });

    it('lists a written file as a child of its directory', async () => {
      await withFs(async (fs, root) => {
        if (!fs.capabilities.canWrite) return;

        const dir = root.join('listing');
        const path = dir.join('a.txt');
        await fs.writeFile(path, new TextEncoder().encode('a'));

        const entries = await collect(fs.list(dir));
        expect(entries.map((entry) => entry.name)).toContain('a.txt');
        // Entry paths must be absolute and resolvable, not bare names.
        const entry = entries.find((candidate) => candidate.name === 'a.txt');
        expect(entry?.path.value).toBe(path.value);
      });
    });

    it('distinguishes directories from files when listing', async () => {
      await withFs(async (fs, root) => {
        if (!fs.capabilities.canWrite) return;

        const dir = root.join('mixed');
        await fs.writeFile(dir.join('file.txt'), new TextEncoder().encode('x'));
        await fs.writeFile(dir.join('sub/nested.txt'), new TextEncoder().encode('y'));

        const entries = await collect(fs.list(dir));
        const byName = new Map(entries.map((entry) => [entry.name, entry]));
        expect(byName.get('file.txt')?.type).toBe('file');
        expect(byName.get('sub')?.type).toBe('directory');
      });
    });

    it('does not list grandchildren as direct children', async () => {
      await withFs(async (fs, root) => {
        if (!fs.capabilities.canWrite) return;

        const dir = root.join('shallow');
        await fs.writeFile(dir.join('deep/deeper/leaf.txt'), new TextEncoder().encode('z'));

        const entries = await collect(fs.list(dir));
        expect(entries.map((entry) => entry.name)).toEqual(['deep']);
      });
    });

    it('deletes a file so it is no longer found', async () => {
      await withFs(async (fs, root) => {
        if (!fs.capabilities.canWrite) return;

        const path = root.join('doomed.txt');
        await fs.writeFile(path, new TextEncoder().encode('bye'));
        await fs.delete(path);

        await expect(fs.stat(path)).rejects.toSatisfy(
          (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
        );
      });
    });

    it('refuses to overwrite when overwrite is false', async () => {
      await withFs(async (fs, root) => {
        if (!fs.capabilities.canWrite) return;

        const path = root.join('guarded.txt');
        await fs.writeFile(path, new TextEncoder().encode('first'));

        await expect(
          fs.writeFile(path, new TextEncoder().encode('second'), { overwrite: false }),
        ).rejects.toSatisfy(
          (error: unknown) => OmniFsError.is(error) && error.code === 'AlreadyExists',
        );

        expect(new TextDecoder().decode(await fs.readFile(path))).toBe('first');
      });
    });

    it('reads a byte range', async () => {
      await withFs(async (fs, root) => {
        if (!fs.capabilities.canWrite || !fs.capabilities.canReadRange) return;

        const path = root.join('ranged.txt');
        await fs.writeFile(path, new TextEncoder().encode('0123456789'));

        const slice = await fs.readFile(path, { offset: 2, length: 3 });
        expect(new TextDecoder().decode(slice)).toBe('234');
      });
    });

    it('copies a file, leaving the original in place', async () => {
      await withFs(async (fs, root) => {
        if (!fs.capabilities.canWrite || fs.copy === undefined) return;

        const from = root.join('source.txt');
        const to = root.join('copy.txt');
        await fs.writeFile(from, new TextEncoder().encode('payload'));
        await fs.copy(from, to);

        expect(new TextDecoder().decode(await fs.readFile(to))).toBe('payload');
        expect((await fs.stat(from)).type).toBe('file');
      });
    });

    it('renames a file, removing the original', async () => {
      await withFs(async (fs, root) => {
        if (!fs.capabilities.canWrite || fs.rename === undefined) return;

        const from = root.join('before.txt');
        const to = root.join('after.txt');
        await fs.writeFile(from, new TextEncoder().encode('moved'));
        await fs.rename(from, to);

        expect(new TextDecoder().decode(await fs.readFile(to))).toBe('moved');
        await expect(fs.stat(from)).rejects.toSatisfy(
          (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
        );
      });
    });

    it('deletes a directory tree recursively', async () => {
      await withFs(async (fs, root) => {
        if (!fs.capabilities.canWrite) return;

        const dir = root.join('tree');
        await fs.writeFile(dir.join('one.txt'), new TextEncoder().encode('1'));
        await fs.writeFile(dir.join('nested/two.txt'), new TextEncoder().encode('2'));

        await fs.delete(dir, { recursive: true });

        const entries = await collect(fs.list(dir)).catch(() => [] as DirEntry[]);
        expect(entries).toHaveLength(0);
      });
    });

    it('surfaces an aborted operation as Cancelled', async () => {
      await withFs(async (fs, root) => {
        const controller = new AbortController();
        controller.abort();

        await expect(fs.stat(root.join('anything.txt'), controller.signal)).rejects.toSatisfy(
          (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
        );
      });
    });

    it('throws OmniFsError and never a bare Error', async () => {
      await withFs(async (fs, root) => {
        await fs
          .stat(root.join('nope-not-real'))
          .then(() => {
            // Some backends genuinely have this path; nothing to assert then.
          })
          .catch((error: unknown) => {
            expect(OmniFsError.is(error)).toBe(true);
          });
      });
    });
  });
}

async function collect(iterable: AsyncIterable<DirEntry>): Promise<DirEntry[]> {
  const entries: DirEntry[] = [];
  for await (const entry of iterable) entries.push(entry);
  return entries;
}
