import { Readable } from 'node:stream';
import { AuthType, createClient, type FileStat as DavStat, type WebDAVClient } from 'webdav';
import { OmniFsError, collectStream } from '@omni-fs/core';
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

  // Tasks 7-8 replace the two members below with real implementations. They
  // exist because `writeFile` and `delete` are non-optional on
  // `RemoteFileSystem`, so the class does not satisfy the contract without
  // them.

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
    const range = buildRange(options);
    const stream = this.#requireClient().createReadStream(this.#remote(path), {
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

  async writeFile(_path: RemotePath, _data: Uint8Array, _options?: WriteOptions): Promise<void> {
    throw OmniFsError.unsupported('writeFile', 'webdav');
  }

  async delete(_path: RemotePath, _options?: DeleteOptions): Promise<void> {
    throw OmniFsError.unsupported('delete', 'webdav');
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

// The three functions below are pure and are exported so the hermetic suite can
// reach them without a server. They are deliberately not re-exported from
// index.ts: they are this package's internals, not its public API.

/**
 * Applies the connection's root prefix, so a connection can be scoped to a
 * subfolder of the server URL.
 */
export function remotePath(settings: WebdavSettings, path: RemotePath): string {
  const root = settings.rootPrefix;
  return root === '' ? path.value : `/${root}${path.value === '/' ? '' : path.value}`;
}

export function toFileStat(stat: DavStat): FileStat {
  // A server may omit `getlastmodified` even though the client's type says
  // otherwise; `Date.parse` then yields NaN, which must not reach core. The
  // same guard covers a date the server sent but we cannot parse.
  const mtime = Date.parse(stat.lastmod);
  return {
    type: stat.type === 'directory' ? 'directory' : 'file',
    size: stat.size,
    mtime: Number.isNaN(mtime) ? undefined : mtime,
    etag: stat.etag ?? undefined,
    raw: { mime: stat.mime },
  };
}

/** `/a/b/` and `/a/b` name the same collection; the root stays `/`. */
export function collectionPath(value: string): string {
  const trimmed = value.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** Translates `ReadOptions` into the `webdav` client's inclusive byte range. */
export function buildRange(
  options: ReadOptions | undefined,
): { start: number; end?: number } | undefined {
  if (options?.offset === undefined) return undefined;
  const start = options.offset;
  return options.length === undefined ? { start } : { start, end: start + options.length - 1 };
}

/**
 * Wraps a stream so an error arriving after `createReadStream` has already
 * returned is still translated. `client.createReadStream` hands back its
 * stream before the HTTP request runs, so a 404/401/dropped connection
 * surfaces as an error event on the stream rather than a rejected promise —
 * nothing upstream gets a chance to call `toOmniFsError` on it otherwise.
 */
export function translateReadStream(
  source: ReadableStream<Uint8Array>,
  path: string,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        throw toOmniFsError(error, path);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
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
