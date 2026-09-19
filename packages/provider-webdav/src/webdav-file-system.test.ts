import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER, OmniFsError, RemotePath } from '@omni-fs/core';
import type { ConnectionConfig } from '@omni-fs/core';
import type { FileStat as DavStat } from 'webdav';
import { WebdavFileSystem, collectionPath, remotePath, toFileStat } from './webdav-file-system.js';
import { readSettings } from './settings.js';

function settings(raw: Readonly<Record<string, unknown>>) {
  return readSettings({ baseUrl: 'https://dav.example.com', ...raw });
}

function davStat(overrides: Partial<DavStat> = {}): DavStat {
  return {
    filename: '/readme.txt',
    basename: 'readme.txt',
    lastmod: 'Sat, 19 Sep 2026 16:34:56 GMT',
    size: 18,
    type: 'file',
    etag: null,
    ...overrides,
  };
}

describe('remotePath', () => {
  const noPrefix = settings({});
  const prefixed = settings({ rootPrefix: 'Documents' });

  it('passes a path through unchanged when no root prefix is configured', () => {
    expect(remotePath(noPrefix, RemotePath.ROOT)).toBe('/');
    expect(remotePath(noPrefix, RemotePath.parse('/docs/guide.md'))).toBe('/docs/guide.md');
  });

  it('maps the connection root onto the prefix without a trailing slash', () => {
    // `/Documents/` would make the self-entry guard in list() disagree with the
    // paths the server returns.
    expect(remotePath(prefixed, RemotePath.ROOT)).toBe('/Documents');
  });

  it('joins a child beneath the prefix', () => {
    expect(remotePath(prefixed, RemotePath.parse('/docs/guide.md'))).toBe(
      '/Documents/docs/guide.md',
    );
  });

  it('is unaffected by slashes around the configured prefix', () => {
    // readSettings strips them, so every spelling reaches the same remote path.
    expect(remotePath(settings({ rootPrefix: '/Documents/' }), RemotePath.parse('/a'))).toBe(
      '/Documents/a',
    );
  });
});

describe('toFileStat', () => {
  it('reports a file with its size, mtime and mime', () => {
    expect(toFileStat(davStat({ mime: 'text/plain' }))).toEqual({
      type: 'file',
      size: 18,
      mtime: Date.parse('Sat, 19 Sep 2026 16:34:56 GMT'),
      etag: undefined,
      raw: { mime: 'text/plain' },
    });
  });

  it('reports a collection as a directory', () => {
    const stat = toFileStat(davStat({ filename: '/docs', basename: 'docs', type: 'directory' }));
    expect(stat.type).toBe('directory');
  });

  it('normalises a null etag to undefined', () => {
    // This server sends `etag: null`, not `undefined` — core expects the latter.
    expect(toFileStat(davStat({ etag: null })).etag).toBeUndefined();
    expect(toFileStat(davStat({ etag: '"abc123"' })).etag).toBe('"abc123"');
  });

  it('omits mtime when the server sent no last-modified date', () => {
    // `lastmod` is typed as a string, but it comes from a PROPFIND property the
    // server is free to leave out. NaN must not reach core.
    const stat = toFileStat(davStat({ lastmod: undefined as unknown as string }));
    expect(stat.mtime).toBeUndefined();
  });

  it('omits mtime when the last-modified date cannot be parsed', () => {
    expect(toFileStat(davStat({ lastmod: 'not a date' })).mtime).toBeUndefined();
  });
});

describe('collectionPath', () => {
  it('treats a trailing slash as the same collection', () => {
    expect(collectionPath('/docs/')).toBe(collectionPath('/docs'));
  });

  it('keeps the root as a single slash', () => {
    expect(collectionPath('/')).toBe('/');
    expect(collectionPath('')).toBe('/');
  });

  it('does not conflate a child with its like-named parent', () => {
    // The guard this backs must not drop `/docs/docs` from a listing of `/docs`.
    expect(collectionPath('/docs/docs')).not.toBe(collectionPath('/docs/'));
  });
});

describe('WebdavFileSystem.connect', () => {
  function build(raw: Readonly<Record<string, unknown>>): WebdavFileSystem {
    const config: ConnectionConfig = {
      id: 'unit',
      providerId: 'webdav',
      label: 'unit',
      settings: { baseUrl: 'https://dav.example.com', ...raw },
    };
    return new WebdavFileSystem({
      config,
      getSecret: async () => ({ password: 'secret', token: 'bearer-token' }),
      logger: NOOP_LOGGER,
    });
  }

  it('rejects password auth with no username instead of deferring to a 401', async () => {
    const fs = build({ authType: 'password' });
    await expect(fs.connect()).rejects.toSatisfy(
      (error: unknown) =>
        OmniFsError.is(error) &&
        error.code === 'AuthenticationFailed' &&
        error.message.includes('username'),
    );
    expect(fs.isAlive()).toBe(false);
  });

  it('does not require a username for token or anonymous auth', async () => {
    // Neither sends one, so demanding it would lock out valid configurations.
    for (const authType of ['token', 'none']) {
      const fs = build({ authType });
      await fs.connect();
      expect(fs.isAlive()).toBe(true);
      await fs[Symbol.asyncDispose]();
    }
  });

  it('is idempotent', async () => {
    const fs = build({ authType: 'password', username: 'omnifs' });
    await fs.connect();
    await fs.connect();
    expect(fs.isAlive()).toBe(true);
    await fs[Symbol.asyncDispose]();
    expect(fs.isAlive()).toBe(false);
  });
});
