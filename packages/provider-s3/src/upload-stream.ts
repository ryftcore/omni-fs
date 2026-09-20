import { toOmniFsError } from './errors.js';

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
 */
export function openUploadStream(
  upload: UploadLike,
  body: WritableStream<Uint8Array>,
  path: string,
): WritableStream<Uint8Array> {
  // Start the upload now: lib-storage pulls the body, so nothing the caller
  // writes moves until `done()` is in flight.
  const uploaded = upload.done();
  // A caller that abandons the stream never awaits `uploaded`; keep its
  // rejection handled so a failed upload cannot crash the process.
  void uploaded.catch(() => undefined);

  const writer = body.getWriter();
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      try {
        await writer.write(chunk);
      } catch (error) {
        // A failure early enough to destroy the body lands here rather than on
        // `uploaded`, and must still reach the caller in the shared vocabulary.
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
