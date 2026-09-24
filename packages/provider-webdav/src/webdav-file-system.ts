import { Readable } from 'node:stream';
import { AuthType, createClient, type FileStat as DavStat, type WebDAVClient } from 'webdav';
import { OmniFsError, collectStream, streamFrom } from '@omni-fs/core';
import type {
  DeleteOptions,
  DirEntry,
  FileStat,
  Logger,
  OverwriteOptions,
  ProviderCapabilities,
  ProviderContext,
  ReadOptions,
  RemoteFileSystem,
  RemotePath,
  WriteOptions,
} from '@omni-fs/core';
import { isMethodNotAllowed, isPreconditionFailed, toOmniFsError } from './errors.js';
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
 * real directories (`MKCOL`), so almost nothing is emulated above it. Unlike
 * S3, where a directory is a prefix inferred from the keys under it, here it is
 * a resource the server creates, lists and deletes — this is the first provider
 * for which `hasRealDirectories: true` is the truth rather than a claim about
 * emulation. The conformance suite does not gate on that flag, and must not:
 * its directory cases run for every provider, which is what lets
 * `MemoryFileSystem` be run against them twice, once full-featured and once
 * pinned to an object-store profile. It has no ranged-write support, and ETag
 * support is server-dependent — see the `hasVersionTokens` comment on
 * `WEBDAV_CAPABILITIES` at the bottom of this file.
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
    // Those two are all it settles: the `type` it also returns is not
    // inspected, so a zero-length read of a directory still answers with no
    // bytes where the reference raises IsADirectory. That gap is recorded for
    // a later plan, not closed here.
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
    //
    // Since 5.11 the library types that stream as its platform-neutral
    // `ReadableLike`; the Node build still returns a `PassThrough`, and the
    // extension bundles the Node build, so narrowing it back is safe.
    const web = Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>;
    return translateReadStream(web, path.value);
  }

  /**
   * `WriteOptions.contentType` is dropped, here and on `createWriteStream`.
   * `putFileContents` hardcodes `Content-Type: application/octet-stream`
   * (`putFileContents.js`) and `createWriteStream` sends no content type
   * at all, so every file this provider writes is announced the same way.
   *
   * Reachable, but not for free: `WebDAVMethodOptions.headers` is merged last
   * in `prepareRequestOptions`, so a header passed there does override the
   * hardcoded one — the cost is threading it through `putWithParents` and
   * `openWriteStream`, and deciding what a streamed write with no declared
   * length should say. Nothing in core sets `contentType` today, so that buys
   * nothing yet. Recorded rather than silently accepted.
   */
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
    // actually makes the option mean something. On a server that honours it,
    // losing the race against this check comes back as a 412 instead, and
    // `openWriteStream` narrows that to `AlreadyExists` so a stream reports
    // the condition the same way `writeFile`, `copy` and `rename` do.
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

  // Known gap, shared by `delete`, `rename` and `copy` below: none of the three
  // looks at a 207 Multi-Status. RFC 4918 §9.6.1 says a 207 from DELETE always
  // means at least one member failed — successfully deleted members MUST NOT
  // appear in the body — and §9.8.5 and §9.9.4 allow the same for COPY and
  // MOVE, which both act at `Depth: infinity`. The `webdav` client's
  // `deleteFile`, `copyFile` and `moveFile` all discard the response, so a
  // partial failure reads here as a clean success.
  //
  // The fix is 207 *detection*, not parsing: `client.customRequest` performs
  // the same `joinURL`/`encodePath`/`handleResponseCode` and hands back the
  // raw `Response`, so `if (response.status === 207) throw …` is the whole of
  // it, and a fake client stands in for it in the hermetic suite exactly as
  // `PutClient` does. It is deferred rather than half-done because closing
  // only `delete` would leave the identical hazard in the other two while
  // making it look handled. `conformance.ts`'s recursive-delete case would
  // catch the DELETE half the first time the suite meets a server answering
  // 207.

  /**
   * `DELETE`, which on a collection is recursive whether the caller wanted it
   * or not: `Depth: infinity` is the only value the method allows (RFC 4918
   * §9.6.1), so `recursive: false` means nothing on the wire. Refusing a
   * non-empty directory is therefore this provider's job — skip it and a
   * caller who asked to remove an empty directory silently loses a tree.
   *
   * That check is check-then-act, and unlike the write guards below this one
   * can destroy data: a child written between `#firstChild` and the DELETE
   * goes with the collection. There is no atomic non-recursive DELETE in the
   * protocol to close the window with, so it is inherent rather than an
   * oversight — but it is the one race in this class that loses bytes.
   */
  async delete(path: RemotePath, options?: DeleteOptions): Promise<void> {
    const signal = options?.signal;

    if (options?.recursive !== true && (await this.stat(path, signal)).type === 'directory') {
      if ((await this.#firstChild(path, signal)) !== undefined) {
        throw new OmniFsError({
          code: 'NotEmpty',
          message: `Directory is not empty: ${path.value}`,
          path: path.value,
          providerId: 'webdav',
        });
      }
    }

    await this.#run(
      (client) =>
        client.deleteFile(this.#remote(path), {
          ...(signal !== undefined ? { signal } : {}),
        }),
      path.value,
    );
  }

  /**
   * `MKCOL`, building any missing ancestors on the way down.
   *
   * `recursive` PROPFINDs the chain and only creates what is absent, so an
   * ancestor that is already there is not an error and neither is the target
   * itself — which matches `MemoryFileSystem`, the contract's reference, where
   * creating an existing directory is a no-op. Plain `MKCOL` would answer 405
   * for that and 409 for a missing parent, disagreeing with the reference on
   * both. The live suite pins both behaviours, so simplifying this to a plain
   * `MKCOL` fails rather than silently changing what the method means.
   *
   * The 405 narrowing is the same move `#transferError` makes for 412: only
   * this call site knows the method was `MKCOL`, which is the one method whose
   * 405 means "something is already there" rather than "the server does not
   * allow that here" — so `errors.ts` cannot classify it and this does. With
   * `recursive: true` the chain is PROPFINDed first, so the only way to reach
   * it is a racing creator between the PROPFIND and the `MKCOL`. It is
   * reported rather than swallowed as a no-op: a server that refuses `MKCOL`
   * outright answers the same 405, and turning that into a silent success
   * would be the very defect this provider was audited for twice.
   *
   * Known gap: when a *file* already sits at `path`, the library's recursive
   * walk throws a bare `Error('Path includes a file: …')` carrying no HTTP
   * status, so `toOmniFsError` can only classify it `Unknown` where the
   * reference raises `AlreadyExists`. The single handle on it is that English
   * message from a library internal, and branching on it would be worse than
   * the gap.
   */
  async createDirectory(path: RemotePath, signal?: AbortSignal): Promise<void> {
    try {
      await this.#requireClient().createDirectory(this.#remote(path), {
        recursive: true,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      throw isMethodNotAllowed(error)
        ? OmniFsError.alreadyExists(path.value, error)
        : toOmniFsError(error, path.value);
    }
  }

  /**
   * `MOVE`, which is a real server-side rename — no read-back, no re-upload,
   * and atomic as far as the caller is concerned.
   */
  async rename(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    const signal = options?.signal;
    try {
      await this.#requireClient().moveFile(this.#remote(from), this.#remote(to), {
        overwrite: options?.overwrite !== false,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      throw this.#transferError(error, from, to, options);
    }
  }

  /** `COPY`, the server-side copy `canCopyServerSide: true` promises. */
  async copy(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    const signal = options?.signal;
    try {
      await this.#requireClient().copyFile(this.#remote(from), this.#remote(to), {
        overwrite: options?.overwrite !== false,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      throw this.#transferError(error, from, to, options);
    }
  }

  /**
   * Names a failed `COPY` or `MOVE`. Both go through `toOmniFsError` like
   * everything else, except for the one status whose meaning only the caller's
   * options fix: with `overwrite: false` the request carried `Overwrite: F`,
   * and the 412 that comes back names the destination, not a lost `If-Match`.
   *
   * Every other failure is named with the source, which is what the caller
   * asked about and right for the common 404. It is wrong for exactly one
   * case: a 409 from COPY or MOVE means the *destination's* parent collection
   * is missing (RFC 4918 §9.8.5, §9.9.4), so the error points at the wrong end
   * of the operation. `OmniFsError` carries one path, the server's own words
   * are in the message, and guessing per status would be its own trap — so
   * this is recorded rather than papered over.
   */
  #transferError(
    error: unknown,
    from: RemotePath,
    to: RemotePath,
    options: OverwriteOptions | undefined,
  ): OmniFsError {
    return options?.overwrite === false && isPreconditionFailed(error)
      ? OmniFsError.alreadyExists(to.value, error)
      : toOmniFsError(error, from.value);
  }

  /**
   * The first child of a collection, or nothing when it has none.
   *
   * The iterator is taken by hand and released rather than drained, which is
   * the question actually being asked. It saves nothing on the wire *here*:
   * this provider's `list` awaits the whole PROPFIND before it yields its
   * first entry, so that entry is already paid for. `RemoteFileSystem.list` is
   * an async iterable for the providers where it does stream — S3's paginated
   * listing — and reading it that way costs nothing either way.
   */
  async #firstChild(path: RemotePath, signal?: AbortSignal): Promise<DirEntry | undefined> {
    const children = this.list(path, signal)[Symbol.asyncIterator]();
    try {
      const first = await children.next();
      return first.done === true ? undefined : first.value;
    } finally {
      await children.return?.();
    }
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
  // PROPFIND, so neither can produce a version token against this server, and
  // false is simply what is true of it. The shared suite now gates its two
  // `ifMatch` cases on this flag, so declaring it false is what skips them —
  // honestly, since without a token from `stat()` there is nothing to hold.
  // Real Nextcloud and sabredav do return `getetag` in PROPFIND, so a provider
  // that detects one should flip this and inherit both cases — which is the
  // argument for reading it per connection rather than hard-coding it here.
  hasVersionTokens: false,
  maxConcurrency: 6,
  listIsPaginated: false,
};
