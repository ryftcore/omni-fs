import { Readable } from 'node:stream';
import { AuthType, createClient, type FileStat as DavStat, type WebDAVClient } from 'webdav';
import { OmniFsError, collectStream, streamFrom } from '@omni-fs/core';
import type {
  DeleteOptions,
  DirEntry,
  FileStat,
  Logger,
  ProviderCapabilities,
  ProviderContext,
  ReadOptions,
  RemoteFileSystem,
  RemotePath,
  WriteOptions,
} from '@omni-fs/core';
import { toOmniFsError } from './errors.js';
import { readSettings, type WebdavSettings } from './settings.js';
import {
  buildRange,
  collectionPath,
  openWriteStream,
  putWithParents,
  remotePath,
  toFileStat,
  translateReadStream,
} from './webdav-helpers.js';

/**
 * WebDAV, including Nextcloud and ownCloud.
 *
 * The one protocol of the four with both a native server-side copy (`COPY`) and
 * real directories (`MKCOL`), so almost nothing is emulated above it. Unlike S3
 * a directory is a real resource, which makes this the first provider to
 * exercise the `hasRealDirectories: true` half of the conformance suite. It has
 * no ranged-write support, and ETag support is server-dependent — see the
 * `hasVersionTokens` comment on `WEBDAV_CAPABILITIES` at the bottom of this
 * file.
 */
export class WebdavFileSystem implements RemoteFileSystem {
  // WEBDAV_CAPABILITIES is declared at the bottom of this file and re-exported
  // from index.ts. It must not live in index.ts: that file imports this one, so
  // reading it back from there would be a cycle.
  readonly capabilities: ProviderCapabilities = WEBDAV_CAPABILITIES;

  readonly #context: ProviderContext;
  readonly #settings: WebdavSettings;
  readonly #logger: Logger;
  #client: WebDAVClient | undefined;

  constructor(context: ProviderContext) {
    this.#context = context;
    this.#settings = readSettings(context.config.settings);
    this.#logger = context.logger;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#client !== undefined) return;

    const { baseUrl, authType, username } = this.#settings;
    if (authType === 'none') {
      this.#client = createClient(baseUrl);
    } else {
      const secret = await this.#context.getSecret(signal);
      this.#client =
        authType === 'token'
          ? createClient(baseUrl, {
              authType: AuthType.Token,
              token: { access_token: requireString(secret, 'token'), token_type: 'Bearer' },
            })
          : createClient(baseUrl, {
              username: requireUsername(username),
              password: requireString(secret, 'password'),
            });
    }

    this.#logger.log('info', 'WebDAV client created', { baseUrl, authType });
  }

  isAlive(): boolean {
    return this.#client !== undefined;
  }

  async stat(path: RemotePath, signal?: AbortSignal): Promise<FileStat> {
    const stat = await this.#run(
      (client) =>
        client.stat(this.#remote(path), {
          ...(signal !== undefined ? { signal } : {}),
        }) as Promise<DavStat>,
      path.value,
    );
    return toFileStat(stat);
  }

  async *list(path: RemotePath, signal?: AbortSignal): AsyncIterable<DirEntry> {
    const contents = await this.#run(
      (client) =>
        client.getDirectoryContents(this.#remote(path), {
          ...(signal !== undefined ? { signal } : {}),
        }) as Promise<DavStat[]>,
      path.value,
    );

    // Some servers include the collection itself in its own listing. Compare
    // the server-returned full path rather than the basename, or a child that
    // happens to repeat its parent's name (`/docs/docs`) would be dropped too.
    const self = collectionPath(this.#remote(path));

    for (const entry of contents) {
      if (entry.basename === '' || collectionPath(entry.filename) === self) continue;
      yield { ...toFileStat(entry), name: entry.basename, path: path.join(entry.basename) };
    }
  }

  async readFile(path: RemotePath, options?: ReadOptions): Promise<Uint8Array> {
    try {
      return await collectStream(await this.createReadStream(path, options));
    } catch (error) {
      throw toOmniFsError(error, path.value);
    }
  }

  async createReadStream(
    path: RemotePath,
    options?: ReadOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    const client = this.#requireClient();
    const range = buildRange(options);
    // A read of zero bytes has no `Range` spelling, so it is answered here
    // rather than sent as something the server would read as a different
    // request. See `buildRange`. The `stat` is not a formality: without it a
    // zero-length read of a missing path, or one through an already-aborted
    // signal, would succeed emptily, where MemoryFileSystem — the contract's
    // reference — raises NotFound and Cancelled before it slices anything.
    // Only the bytes are short-circuited, never the question of whether the
    // read was allowed to happen at all.
    if (range === 'empty') {
      await this.stat(path, options?.signal);
      return streamFrom(new Uint8Array(0));
    }

    const stream = client.createReadStream(this.#remote(path), {
      ...(range !== undefined ? { range } : {}),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });

    // The library hands back a Node stream; the contract asks for a web one.
    // `client.createReadStream` returns synchronously, before the HTTP
    // request has even been sent — a 404, a 401 or a dropped connection
    // surfaces later as an error event on the stream, not as a rejection
    // here. `translateReadStream` gives that late error the same
    // `OmniFsError` translation `stat` and `list` get through `#run`.
    const web = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    return translateReadStream(web, path.value);
  }

  async writeFile(path: RemotePath, data: Uint8Array, options?: WriteOptions): Promise<void> {
    if (options?.overwrite === false && (await this.#exists(path, options.signal))) {
      throw OmniFsError.alreadyExists(path.value);
    }

    await this.#run(
      (client) =>
        putWithParents(
          client,
          { remote: this.#remote(path), path: path.value },
          Buffer.from(data),
          {
            overwrite: options?.overwrite !== false,
            contentLength: data.byteLength,
            ...(options?.signal !== undefined ? { signal: options.signal } : {}),
          },
          options?.createParents !== false,
        ),
      path.value,
    );

    options?.onProgress?.(data.byteLength, data.byteLength);
  }

  /**
   * A streamed PUT, for a file too large to hold in memory.
   *
   * Two `WriteOptions` do not apply on this path. `createParents` cannot:
   * the body is already on the wire by the time a 409 comes back, and there is
   * nothing left to resend, so a caller who needs it on a server that does not
   * create the chain itself should `createDirectory` first — which is why the
   * failure is reported as `Conflict` rather than swallowed. `onProgress` is
   * not reported either: the caller is the one feeding the stream, so it
   * already knows how many bytes it has written, and the library exposes no
   * upload progress on this call.
   */
  async createWriteStream(
    path: RemotePath,
    options?: WriteOptions,
  ): Promise<WritableStream<Uint8Array>> {
    const client = this.#requireClient();
    // `overwrite: false` puts `If-None-Match: *` on the request, but a server
    // is free to ignore it — the dev image does — so the guard is what
    // actually makes the option mean something.
    if (options?.overwrite === false && (await this.#exists(path, options.signal))) {
      throw OmniFsError.alreadyExists(path.value);
    }

    return openWriteStream(
      client,
      { remote: this.#remote(path), path: path.value },
      {
        overwrite: options?.overwrite !== false,
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      },
    );
  }

  // Task 8 replaces the member below with a real implementation. It exists
  // because `delete` is non-optional on `RemoteFileSystem`, so the class does
  // not satisfy the contract without it.

  async delete(_path: RemotePath, _options?: DeleteOptions): Promise<void> {
    throw OmniFsError.unsupported('delete', 'webdav');
  }

  /**
   * Check-then-write, which is racy by nature — WebDAV's atomic answer is
   * `If-None-Match: *`, and this server ignores it. Being racy is still far
   * better than not honouring `overwrite: false` at all.
   */
  async #exists(path: RemotePath, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.stat(path, signal);
      return true;
    } catch (error) {
      if (OmniFsError.is(error) && error.code === 'NotFound') return false;
      throw error;
    }
  }

  #remote(path: RemotePath): string {
    return remotePath(this.#settings, path);
  }

  #requireClient(): WebDAVClient {
    if (this.#client === undefined) {
      throw new OmniFsError({
        code: 'ConnectionFailed',
        message: 'WebDAV client is not connected. Call connect() first.',
        providerId: 'webdav',
      });
    }
    return this.#client;
  }

  async #run<T>(body: (client: WebDAVClient) => Promise<T>, path?: string): Promise<T> {
    try {
      return await body(this.#requireClient());
    } catch (error) {
      throw toOmniFsError(error, path);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#client = undefined;
  }
}

/**
 * Password auth needs both halves. Substituting `''` would turn a locally
 * detectable configuration mistake into a server round-trip reported as a 401
 * in the server's words rather than ours — `requireString` already gives the
 * password the precise treatment.
 */
function requireUsername(username: string | undefined): string {
  if (username === undefined) {
    throw new OmniFsError({
      code: 'AuthenticationFailed',
      message: 'Missing username: WebDAV password authentication requires one.',
      providerId: 'webdav',
    });
  }
  return username;
}

function requireString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new OmniFsError({
      code: 'AuthenticationFailed',
      message: `Missing credential field: ${key}`,
      providerId: 'webdav',
    });
  }
  return value;
}

export const WEBDAV_CAPABILITIES: ProviderCapabilities = {
  canWrite: true,
  canRename: true,
  canCopyServerSide: true,
  canCreateDirectory: true,
  canDeleteRecursive: true,
  canAppend: false,
  canReadRange: true,
  canStreamWrite: true,
  canWatch: false,
  hasRealDirectories: true,
  preservesMTime: false,
  // Measured against dgraziotin/nginx-webdav-nononsense: an `ETag` header is
  // present on GET/HEAD, but PROPFIND bodies never include a `getetag`
  // property. The `webdav` client derives both `stat()` and `list()` from
  // PROPFIND, so neither can produce a version token against this server —
  // declared false so the conformance suite skips the `ifMatch` path rather
  // than failing it. Real Nextcloud and sabredav do return `getetag`; see
  // task-4-report.md.
  hasVersionTokens: false,
  maxConcurrency: 6,
  listIsPaginated: false,
};
