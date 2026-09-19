import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER, OmniFsError, RemotePath } from '@omni-fs/core';
import type { ConnectionConfig } from '@omni-fs/core';
import { WebdavFileSystem } from './webdav-file-system.js';

const BASE_URL = process.env['OMNI_FS_WEBDAV_URL'] ?? 'http://localhost:8081';
const USERNAME = process.env['OMNI_FS_WEBDAV_USER'] ?? 'omnifs';
const PASSWORD = process.env['OMNI_FS_WEBDAV_PASSWORD'] ?? 'omnifs-dev-secret';

export function connect(): WebdavFileSystem {
  const config: ConnectionConfig = {
    id: 'live',
    providerId: 'webdav',
    label: 'live',
    settings: { baseUrl: BASE_URL, authType: 'password', username: USERNAME },
  };
  return new WebdavFileSystem({
    config,
    getSecret: async () => ({ password: PASSWORD }),
    logger: NOOP_LOGGER,
  });
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
});
