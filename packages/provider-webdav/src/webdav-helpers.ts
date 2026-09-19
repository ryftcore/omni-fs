import { Writable } from 'node:stream';
import type {
  CreateWriteStreamOptions,
  FileStat as DavStat,
  PutFileContentsOptions,
  WebDAVClient,
} from 'webdav';
import { OmniFsError } from '@omni-fs/core';
import type { FileStat, ReadOptions, RemotePath } from '@omni-fs/core';
import { toOmniFsError } from './errors.js';
import type { WebdavSettings } from './settings.js';

// The functions here are exported so the hermetic suite can reach them without
// a server — the ones that do talk to a server take the client as an argument,
// so a fake stands in for it. They are deliberately not re-exported from
// index.ts: they are this package's internals, not its public API.
//
// They live beside `webdav-file-system.ts` rather than inside it because that
// file had grown to 557 lines of class and module scope together. What moved
// is what was exported from module scope, and only that. `requireUsername`,
// `requireString` and `WEBDAV_CAPABILITIES` stayed behind on purpose: the
// first two are `connect()`'s own failure vocabulary and moving them would
// mean exporting them solely to cross a file boundary, and the third is not a
// helper at all.

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
