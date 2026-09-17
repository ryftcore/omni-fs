import { RemotePath } from '@omni-fs/core';
import { runConformanceSuite } from './conformance.js';
import { MemoryFileSystem } from './memory-file-system.js';

/**
 * The conformance suite proving itself against the reference implementation.
 *
 * Run twice: once as a full-featured POSIX-like filesystem, and once with
 * capabilities pinned down to mimic an object store. The second run is what
 * catches a suite that accidentally assumes real directories exist.
 */
runConformanceSuite({
  name: 'MemoryFileSystem (full capabilities)',
  setup: async () => {
    const fs = new MemoryFileSystem();
    await fs.connect();
    return { fs, root: RemotePath.parse('/conformance') };
  },
  teardown: async (fs) => {
    await fs[Symbol.asyncDispose]();
  },
});

runConformanceSuite({
  name: 'MemoryFileSystem (object-store profile)',
  setup: async () => {
    const fs = new MemoryFileSystem({
      capabilities: {
        hasRealDirectories: false,
        canRename: false,
        canCreateDirectory: false,
        maxConcurrency: 16,
      },
    });
    await fs.connect();
    return { fs, root: RemotePath.parse('/conformance') };
  },
  teardown: async (fs) => {
    await fs[Symbol.asyncDispose]();
  },
});
