import type { ReadOptions, RemotePath } from '@omni-fs/core';
import type { S3Settings } from './settings.js';

/**
 * The pure translation between one path shape and a flat keyspace.
 *
 * Kept out of `S3FileSystem` so it can be read and tested without a bucket:
 * every function here is total, synchronous and free of the SDK. The same
 * split exists in `provider-webdav` and `provider-sftp`.
 */

/**
 * The object key for a path, scoped by the connection's root prefix.
 *
 * At the bucket root this is `''` for an unscoped connection and the prefix
 * itself — with its trailing slash — for a scoped one. Callers that cannot
 * mean an object guard the root before asking; the one that reaches here with
 * it wants that trailing-slash key, because a directory placeholder is
 * precisely what it is trying to delete.
 */
export function keyFor(settings: S3Settings, path: RemotePath): string {
  const root = settings.rootPrefix;
  const key = path.toKey();
  return root === '' ? key : `${root}/${key}`;
}

/**
 * The listing prefix for a path, scoped by the connection's root prefix.
 *
 * Always ends in a slash below the root, which is what keeps a listing of
 * `/a/tree` from also matching `/a/tree-other`.
 */
export function prefixFor(settings: S3Settings, path: RemotePath): string {
  const root = settings.rootPrefix;
  const prefix = path.toPrefix();
  return root === '' ? prefix : `${root}/${prefix}`;
}

/**
 * The `CopySource` header value: bucket and key, URI-encoded.
 *
 * The slashes separating key segments have to survive encoding. A `%2F` there
 * addresses a single object whose name contains slashes, which is a different
 * object — usually one that does not exist.
 */
export function copySource(bucket: string, key: string): string {
  return `${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
}

/** Strips leading and trailing slashes, leaving the separators between segments. */
export function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

/**
 * The `Range` header for a read, or `'empty'` when the caller asked for no
 * bytes at all.
 *
 * `'empty'` exists because there is no Range spelling for zero bytes. The
 * arithmetic alone produces `bytes=5--1`, which S3 answers with 416 or — worse
 * — ignores, sending the whole object back to a caller that wanted nothing.
 * The caller answers `'empty'` itself, and must still prove the object exists
 * while doing so, or a zero-length read of a missing path succeeds emptily
 * where `MemoryFileSystem`, the contract's reference, raises `NotFound`.
 *
 * A `length` with no `offset` is ignored, which is also what the reference
 * does: no offset means the whole file.
 */
export function buildRange(
  options: ReadOptions | undefined,
): { readonly header: string } | 'empty' | undefined {
  if (options?.offset === undefined) return undefined;
  const start = options.offset;
  if (options.length === undefined) return { header: `bytes=${String(start)}-` };
  if (options.length <= 0) return 'empty';
  return { header: `bytes=${String(start)}-${String(start + options.length - 1)}` };
}
