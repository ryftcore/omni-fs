import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER, OmniFsError, RemotePath, collectStream, streamFrom } from '@omni-fs/core';
import type { ConnectionConfig } from '@omni-fs/core';
import type { FileStat as DavStat } from 'webdav';
import {
  WebdavFileSystem,
  buildRange,
  collectionPath,
  openWriteStream,
  parentCollection,
  putWithParents,
  remotePath,
  toFileStat,
  translateReadStream,
  translateWriteStream,
} from './webdav-file-system.js';
import type { PutClient, WriteStreamClient } from './webdav-file-system.js';
import { readSettings } from './settings.js';

function settings(raw: Readonly<Record<string, unknown>>) {
  return readSettings({ baseUrl: 'https://dav.example.com', ...raw });
}

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

/** A native `webdav` failure: a plain `Error` carrying the HTTP status. */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
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

describe('buildRange', () => {
  it('is undefined with no offset', () => {
    expect(buildRange(undefined)).toBeUndefined();
    expect(buildRange({})).toBeUndefined();
  });

  it('is an open-ended range when an offset is given without a length', () => {
    expect(buildRange({ offset: 5 })).toEqual({ start: 5 });
  });

  it('is an inclusive closed range when both offset and length are given', () => {
    // Byte 2 for a length of 3 covers bytes 2, 3 and 4 — an inclusive `end`.
    expect(buildRange({ offset: 2, length: 3 })).toEqual({ start: 2, end: 4 });
  });

  it('reports a zero-or-shorter length as an empty read, never an inverted range', () => {
    // The inclusive arithmetic would make this `bytes=5-4`, which a server
    // either rejects with 416 or ignores — sending the whole file back for a
    // request that asked for nothing at all.
    expect(buildRange({ offset: 5, length: 0 })).toBe('empty');
    expect(buildRange({ offset: 5, length: -3 })).toBe('empty');
  });

  it('ignores a length given without an offset, as the whole-file read it is', () => {
    // MemoryFileSystem, the contract's reference, ignores `length` unless
    // `offset` is set; this must not diverge from it.
    expect(buildRange({ length: 0 })).toBeUndefined();
  });
});

describe('parentCollection', () => {
  it('drops the last segment', () => {
    expect(parentCollection('/a/b/c.txt')).toBe('/a/b');
    expect(parentCollection('/a/b/')).toBe('/a');
  });

  it('has nothing to create above a root-level resource', () => {
    // There is no parent to MKCOL for `/c.txt`, and `/` always exists.
    expect(parentCollection('/c.txt')).toBeUndefined();
    expect(parentCollection('/')).toBeUndefined();
    expect(parentCollection('')).toBeUndefined();
  });
});

describe('putWithParents', () => {
  /**
   * `outcomes[n]` is what the n-th PUT does: an `Error` to throw, `false` for
   * the refusal the library reports by returning rather than throwing, and
   * anything else for a plain success.
   */
  function fakeClient(outcomes: readonly (Error | false | undefined)[]) {
    const puts: { path: string; body: string }[] = [];
    const directories: { path: string; recursive: boolean | undefined; signal: unknown }[] = [];
    let attempt = 0;
    const client: PutClient = {
      async putFileContents(path: string, data: unknown) {
        const outcome = outcomes[attempt++];
        if (outcome instanceof Error) throw outcome;
        if (outcome === false) return false;
        puts.push({ path, body: String(data) });
        return true;
      },
      async createDirectory(path: string, options?: { recursive?: boolean; signal?: AbortSignal }) {
        directories.push({ path, recursive: options?.recursive, signal: options?.signal });
      },
    };
    return { client, puts, directories };
  }

  const body = Buffer.from('payload');
  const target = { remote: '/docs/new.txt', path: '/docs/new.txt' };
  const deepTarget = { remote: '/deep/tree/new.txt', path: '/deep/tree/new.txt' };
  const rootTarget = { remote: '/new.txt', path: '/new.txt' };

  it('writes once when the PUT succeeds, creating nothing', async () => {
    const { client, puts, directories } = fakeClient([]);
    await putWithParents(client, target, body, {}, true);
    expect(puts).toEqual([{ path: '/docs/new.txt', body: 'payload' }]);
    expect(directories).toEqual([]);
  });

  it('reports a PUT the server refused as AlreadyExists, not as a success', async () => {
    // `putFileContents` answers `false` rather than throwing when the server
    // honours `If-None-Match: *` and rejects a create-only PUT with 412. Taking
    // that for success would report a write that never happened, leaving
    // someone else's bytes on the server.
    const { client, puts } = fakeClient([false]);
    await expect(
      putWithParents(client, target, body, { overwrite: false }, true),
    ).rejects.toSatisfy(
      (error: unknown) =>
        OmniFsError.is(error) && error.code === 'AlreadyExists' && error.path === '/docs/new.txt',
    );
    expect(puts).toEqual([]);
  });

  it('names the caller-facing path, not the prefixed remote one, when it refuses', async () => {
    const { client } = fakeClient([false]);
    await expect(
      putWithParents(
        client,
        { remote: '/Documents/new.txt', path: '/new.txt' },
        body,
        { overwrite: false },
        true,
      ),
    ).rejects.toSatisfy((error: unknown) => OmniFsError.is(error) && error.path === '/new.txt');
  });

  it('checks the retried PUT too', async () => {
    // The repair path has its own PUT, and it answers the same way.
    const { client, directories } = fakeClient([httpError(409, 'Invalid response: 409'), false]);
    await expect(
      putWithParents(client, deepTarget, body, { overwrite: false }, true),
    ).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AlreadyExists',
    );
    expect(directories).toHaveLength(1);
  });

  it('creates the parent chain and retries once after a 409', async () => {
    // A standards-compliant server (Nextcloud, sabredav) answers 409 Conflict
    // for a PUT into a collection that does not exist. The dev image does not
    // — it has `create_full_put_path on` — so this is the only cover there is.
    const { client, puts, directories } = fakeClient([httpError(409, 'Invalid response: 409')]);
    const signal = new AbortController().signal;
    await putWithParents(client, deepTarget, body, { signal }, true);
    // The repair is a network call of its own, so it has to carry the caller's
    // signal too.
    expect(directories).toEqual([{ path: '/deep/tree', recursive: true, signal }]);
    expect(puts).toEqual([{ path: '/deep/tree/new.txt', body: 'payload' }]);
  });

  it('does not repair when the caller asked for no parents', async () => {
    const { client, directories } = fakeClient([httpError(409, 'Invalid response: 409')]);
    await expect(putWithParents(client, deepTarget, body, {}, false)).rejects.toThrow(
      'Invalid response: 409',
    );
    expect(directories).toEqual([]);
  });

  it('retries exactly once: a second conflict propagates', async () => {
    const failures = [httpError(409, 'first'), httpError(409, 'second')];
    const { client, directories } = fakeClient(failures);
    await expect(putWithParents(client, deepTarget, body, {}, true)).rejects.toThrow('second');
    expect(directories).toHaveLength(1);
  });

  it('leaves any other failure alone', async () => {
    // A 403 is not a missing parent; MKCOL-ing over it would hide the real
    // problem behind a second, more confusing failure.
    const { client, directories } = fakeClient([httpError(403, 'Invalid response: 403')]);
    await expect(putWithParents(client, target, body, {}, true)).rejects.toThrow(
      'Invalid response: 403',
    );
    expect(directories).toEqual([]);
  });

  it('has no parent to repair at the root, so the conflict stands', async () => {
    const { client, directories } = fakeClient([httpError(409, 'Invalid response: 409')]);
    await expect(putWithParents(client, rootTarget, body, {}, true)).rejects.toThrow(
      'Invalid response: 409',
    );
    expect(directories).toEqual([]);
  });
});

describe('translateWriteStream', () => {
  function sink(): { chunks: Uint8Array[]; target: WritableStream<Uint8Array> } {
    const chunks: Uint8Array[] = [];
    const target = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    });
    return { chunks, target };
  }

  it('passes chunks through and only closes once the upload is acknowledged', async () => {
    const { chunks, target } = sink();
    let acknowledge!: () => void;
    const uploaded = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });

    const writer = translateWriteStream(target, '/out.txt', uploaded).getWriter();
    await writer.write(new TextEncoder().encode('one|'));
    await writer.write(new TextEncoder().encode('two'));

    let closed = false;
    const closing = writer.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The PUT is still in flight: reporting success here is what loses data.
    expect(closed).toBe(false);

    acknowledge();
    await closing;
    expect(closed).toBe(true);
    expect(chunks.map((chunk) => new TextDecoder().decode(chunk)).join('')).toBe('one|two');
  });

  it('translates a failure that only surfaces when the upload settles', async () => {
    // Measured against the live server: with a bare `Writable.toWeb` wrapper
    // both write() and close() resolve against a 401 and the bytes vanish.
    const { target } = sink();
    const uploaded = Promise.reject(httpError(401, 'Invalid response: 401 Unauthorized'));

    const writer = translateWriteStream(target, '/out.txt', uploaded).getWriter();
    await writer.write(new TextEncoder().encode('never lands'));
    await expect(writer.close()).rejects.toSatisfy(
      (error: unknown) =>
        OmniFsError.is(error) && error.code === 'AuthenticationFailed' && error.path === '/out.txt',
    );
  });

  it('translates an error raised while a chunk is being written', async () => {
    const target = new WritableStream<Uint8Array>({
      write() {
        throw httpError(507, 'Invalid response: 507 Insufficient Storage');
      },
    });

    const writer = translateWriteStream(target, '/out.txt', Promise.resolve()).getWriter();
    await expect(writer.write(new TextEncoder().encode('too big'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'QuotaExceeded',
    );
  });
});

describe('openWriteStream', () => {
  /**
   * Stands in for `client.createWriteStream`, which returns the request body as
   * a `PassThrough` and reports the server's answer separately — through the
   * callback it was handed, or by emitting `error` on that same stream. The
   * `resume()` is the HTTP request reading the body: without a consumer the
   * stream never reaches `close`, and nothing would settle.
   */
  function fakeClient() {
    const opened: { stream: PassThrough; acknowledge: () => void }[] = [];
    const client = {
      createWriteStream(_filename: string, _options?: unknown, callback?: unknown) {
        const stream = new PassThrough();
        stream.resume();
        opened.push({
          stream,
          acknowledge: () => {
            if (typeof callback === 'function') callback({} as never);
          },
        });
        return stream;
      },
    } as unknown as WriteStreamClient;
    return { client, opened };
  }

  const target = { remote: '/out.txt', path: '/out.txt' };

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it('closes once the server has acknowledged the body', async () => {
    const { client, opened } = fakeClient();
    const writer = openWriteStream(client, target, {}).getWriter();
    await writer.write(new TextEncoder().encode('body'));

    const closing = writer.close();
    await delay(20);
    opened[0]?.acknowledge();
    await expect(closing).resolves.toBeUndefined();
  });

  it('fails close() when the server rejects the upload after the body is sent', async () => {
    // This is the normal shape of a WebDAV failure: the server answers once it
    // has the whole body, so the error lands *after* the node stream finished
    // and the web writer settled its own close. The delay puts it firmly there,
    // so the only thing that can still report it is the `error` listener
    // `openWriteStream` attaches — without it, close() waits forever.
    const { client, opened } = fakeClient();
    const writer = openWriteStream(client, target, {}).getWriter();
    await writer.write(new TextEncoder().encode('body'));

    const closing = writer.close();
    await delay(20);
    opened[0]?.stream.emit('error', httpError(507, 'Invalid response: 507'));
    await expect(closing).rejects.toSatisfy(
      (error: unknown) =>
        OmniFsError.is(error) && error.code === 'QuotaExceeded' && error.path === '/out.txt',
    );
  });
});

describe('translateReadStream', () => {
  it('passes chunks through untouched', async () => {
    const source = streamFrom(new TextEncoder().encode('hello'));
    const bytes = await collectStream(translateReadStream(source, '/hello.txt'));
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  it('translates a late error event on the source into an OmniFsError', async () => {
    // Mirrors what the `webdav` client actually does on a 404: the stream is
    // handed back before the request runs, and the failure only arrives as
    // an error on the stream — never as a rejected promise beforehand.
    const notFound = new Error('Invalid response: 404 Not Found') as Error & { status: number };
    notFound.status = 404;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(notFound);
      },
    });

    const reader = translateReadStream(source, '/missing.txt').getReader();
    await expect(reader.read()).rejects.toSatisfy(
      (error: unknown) =>
        OmniFsError.is(error) && error.code === 'NotFound' && error.path === '/missing.txt',
    );
  });
});

describe('WebdavFileSystem.connect', () => {
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
