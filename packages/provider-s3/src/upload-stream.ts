import { OmniFsError } from '@omni-fs/core';
import type { WriteOptions } from '@omni-fs/core';
import { isPreconditionFailed, toOmniFsError } from './errors.js';

/** The slice of lib-storage's `Upload` that `openUploadStream` drives. */
export interface UploadLike {
  done(): Promise<unknown>;
  abort(): Promise<void>;
}

/**
 * Wraps a started multipart upload so a closed writer means the object is on
 * the server.
 *
 * `Upload` takes the body as a stream and answers on `done()`, long after the
 * caller's last `write()` has been *queued*. A wrapper that hands back the raw
 * body stream therefore resolves `close()` for an upload S3 went on to reject
 * with 403 — the bytes are gone and the caller is told the write succeeded.
 * Waiting for `done()` in `close()` is what makes a closed writer mean
 * something. The same defect shipped in the WebDAV provider and is fixed there
 * the same way; see `openWriteStream` in `packages/provider-webdav`.
 *
 * The wait is deliberately unbounded: a server that takes the whole body and
 * then never answers hangs `close()`, where the naive version wrongly resolved.
 * Hanging is the better failure — it is visible, and the caller's `AbortSignal`
 * (wired to `upload.abort()` by the provider) is what ends it. Do not add a
 * timeout here that resolves the close.
 *
 * `createOnly` carries the caller's `overwrite: false` this far down because a
 * 412 cannot be read without it: the same status answers a refused
 * `If-None-Match: *` and a lost `If-Match`. Only the option says which one was
 * asked for, and it is the difference between reporting `AlreadyExists` like
 * `writeFile` does and reporting `Conflict` for a quite different event.
 */
export function openUploadStream(
  upload: UploadLike,
  body: WritableStream<Uint8Array>,
  path: string,
  createOnly: boolean,
): WritableStream<Uint8Array> {
  // Start the upload now: lib-storage pulls the body, so nothing the caller
  // writes moves until `done()` is in flight.
  const uploaded = upload.done();
  // A caller that abandons the stream never awaits `uploaded`; keep its
  // rejection handled so a failed upload cannot crash the process.
  void uploaded.catch(() => undefined);

  const translate = (error: unknown): OmniFsError =>
    createOnly && isPreconditionFailed(error)
      ? OmniFsError.alreadyExists(path, error)
      : toOmniFsError(error, path);

  const writer = body.getWriter();
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      try {
        await writer.write(chunk);
      } catch (error) {
        // A failure early enough to destroy the body lands here rather than on
        // `uploaded`, and must still reach the caller in the shared vocabulary.
        throw translate(error);
      }
    },
    async close() {
      try {
        await writer.close();
        await uploaded;
      } catch (error) {
        throw translate(error);
      }
    },
    abort(reason) {
      return writer.abort(reason);
    },
  });
}

/**
 * The conditional headers that make S3 itself refuse a write rather than
 * clobber what is there.
 *
 * `Upload` spreads these into `PutObjectCommand` on the single-part path and
 * into `CompleteMultipartUploadCommand` on the multipart one — both accept
 * them — so a streamed write gets the same guarantee as `writeFile`, and gets
 * it atomically on the server rather than through a read-then-write race.
 * `CreateMultipartUploadCommand` takes neither and ignores them, which is
 * harmless: the condition is evaluated when the upload completes.
 *
 * A store that ignores the headers degrades to overwriting. That is the same
 * caveat the WebDAV provider carries for `If-None-Match`, and it is the reason
 * a server's behaviour here is worth measuring rather than assuming.
 */
export function writeConditions(options: WriteOptions | undefined): {
  IfNoneMatch?: string;
  IfMatch?: string;
} {
  return {
    ...(options?.overwrite === false ? { IfNoneMatch: '*' } : {}),
    ...(options?.ifMatch !== undefined ? { IfMatch: options.ifMatch } : {}),
  };
}
