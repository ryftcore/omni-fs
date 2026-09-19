import { Readable, Writable } from 'node:stream';
import {
  AuthType,
  createClient,
  type CreateWriteStreamOptions,
  type FileStat as DavStat,
  type PutFileContentsOptions,
  type WebDAVClient,
} from 'webdav';
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

// The functions below are exported so the hermetic suite can reach them
// without a server — the ones that do talk to a server take the client as an
// argument, so a fake stands in for it. They are deliberately not re-exported
// from index.ts: they are this package's internals, not its public API.

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

/**
 * Translates `ReadOptions` into the `webdav` client's inclusive byte range.
 *
 * `'empty'` means the caller asked for no bytes at all. The inclusive
 * arithmetic would turn `{ offset: 5, length: 0 }` into `bytes=5-4`, an
 * inverted range a server answers with 416 or, worse, ignores — sending the
 * whole file back for a request that wanted nothing. There is no Range header
 * for zero bytes, so the read is answered without one.
 */
export function buildRange(
  options: ReadOptions | undefined,
): { start: number; end?: number } | 'empty' | undefined {
  if (options?.offset === undefined) return undefined;
  const start = options.offset;
  if (options.length === undefined) return { start };
  return options.length <= 0 ? 'empty' : { start, end: start + options.length - 1 };
}

/** The collection a resource lives in, or nothing when that is the root. */
export function parentCollection(remote: string): string | undefined {
  const trimmed = remote.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  return cut <= 0 ? undefined : trimmed.slice(0, cut);
}

/** The slice of the client `putWithParents` drives. */
export type PutClient = Pick<WebDAVClient, 'putFileContents' | 'createDirectory'>;

/**
 * PUT, creating the parent collection if that is what was missing.
 *
 * `WriteOptions.createParents` defaults to true, and a standards-compliant
 * server (Nextcloud, sabredav) answers 409 Conflict for a PUT into a
 * collection that does not exist. The dev image does not — it runs with
 * `create_full_put_path on` and builds the chain itself — so repairing on the
 * conflict rather than MKCOL-ing ahead of every write costs nothing on the
 * servers that need no repair, and is correct on the ones that do.
 *
 * Exactly one retry: a second conflict is not a missing parent.
 *
 * `target` carries both paths because they differ under a `rootPrefix`:
 * `remote` is what the request is sent to, `path` is what an error names, so
 * a caller is told about the path it asked for.
 */
export async function putWithParents(
  client: PutClient,
  target: { readonly remote: string; readonly path: string },
  data: Buffer,
  options: PutFileContentsOptions,
  createParents: boolean,
): Promise<void> {
  const { remote, path } = target;
  let written: boolean;

  try {
    written = await client.putFileContents(remote, data, options);
  } catch (error) {
    const parent = parentCollection(remote);
    if (!createParents || parent === undefined || toOmniFsError(error).code !== 'Conflict') {
      throw error;
    }
    // `recursive` PROPFINDs its way down and only creates what is absent, so
    // an ancestor that does exist is not an error.
    await client.createDirectory(parent, {
      recursive: true,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    written = await client.putFileContents(remote, data, options);
  }

  // Both PUTs answer the same way, so both are checked here.
  requireWritten(written, path);
}

/**
 * `putFileContents` answers `false` instead of throwing when the server
 * rejects a create-only PUT with 412 — see `putFileContents.js`, which
 * swallows that one status. Discarding the boolean would report a write that
 * never happened as a success, with someone else's bytes left on the server:
 * on Nextcloud or sabredav, which do honour the `If-None-Match: *` that
 * `overwrite: false` sends, that is the outcome of losing the race against
 * `#exists`. `AlreadyExists` is also the truer code for it than the `Conflict`
 * a thrown 412 maps to.
 */
function requireWritten(written: boolean, path: string): void {
  if (!written) throw OmniFsError.alreadyExists(path);
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

/** The slice of the client `openWriteStream` drives. */
export type WriteStreamClient = Pick<WebDAVClient, 'createWriteStream'>;

/**
 * Starts the PUT and hands back the web stream its body is written to.
 *
 * The client sends the request immediately and returns the body stream, so the
 * server's answer arrives on the success callback or as an `error` event on
 * that stream — never as a rejection here. Both are wired into `uploaded`,
 * which `translateWriteStream` waits for: the node stream finishes when the
 * last chunk is *queued*, and a writer that reported success there would lose
 * every byte of a rejected upload.
 *
 * The `error` listener is not belt-and-braces. A failure that lands before the
 * body is closed also reaches the caller through the errored web writer, but
 * one that lands *after* — the usual case, since the server answers when it
 * has the whole body — would otherwise leave `uploaded` unsettled and hang
 * `close()` forever.
 */
export function openWriteStream(
  client: WriteStreamClient,
  target: { readonly remote: string; readonly path: string },
  options: CreateWriteStreamOptions,
): WritableStream<Uint8Array> {
  let acknowledge!: () => void;
  let fail!: (error: unknown) => void;
  const uploaded = new Promise<void>((resolve, reject) => {
    acknowledge = resolve;
    fail = reject;
  });

  const stream = client.createWriteStream(target.remote, options, () => {
    acknowledge();
  });
  stream.on('error', fail);

  const web = Writable.toWeb(stream) as WritableStream<Uint8Array>;
  return translateWriteStream(web, target.path, uploaded);
}

/**
 * The write-side pair of `translateReadStream`, with one extra job.
 *
 * Translation first: a 401, a 507 or a dropped connection reaches the caller
 * as a raw `Error` otherwise, which `provider.ts` forbids. Then the part that
 * is only true on the write side — `uploaded` settles when the server has
 * answered the PUT, and `close()` waits for it. Measured against the dev
 * server, a plain `Writable.toWeb` wrapper resolves both `write()` and
 * `close()` for an upload the server rejected with 401: the bytes are gone and
 * the caller is told the write succeeded. Waiting for the answer is what makes
 * a closed writer mean the file is on the server.
 *
 * That wait is deliberately unbounded: a server that takes the whole body and
 * then never answers hangs `close()`, where the naive version wrongly resolved.
 * Hanging is the better failure — it is visible, and it is the caller's
 * `AbortSignal` (passed through to the request in `createWriteStream`) that
 * ends it. Do not add a timeout here that resolves the close.
 */
export function translateWriteStream(
  target: WritableStream<Uint8Array>,
  path: string,
  uploaded: Promise<void>,
): WritableStream<Uint8Array> {
  // A caller that abandons the stream never awaits `uploaded`; keep its
  // rejection handled so a failed upload cannot crash the process.
  void uploaded.catch(() => undefined);

  const writer = target.getWriter();
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      try {
        await writer.write(chunk);
      } catch (error) {
        throw toOmniFsError(error, path);
      }
    },
    async close() {
      try {
        await writer.close();
        await uploaded;
      } catch (error) {
        throw toOmniFsError(error, path);
      }
    },
    abort(reason) {
      return writer.abort(reason);
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
