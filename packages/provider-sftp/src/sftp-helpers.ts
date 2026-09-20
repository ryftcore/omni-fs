import { trimTrailingSlashes } from '@omni-fs/core';
import type { FileStat, FileType, ReadOptions, RemotePath } from '@omni-fs/core';
import { toOmniFsError } from './errors.js';
import type { SftpAttrs } from './sftp-session.js';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

/**
 * POSIX mode bits to the shared vocabulary.
 *
 * The bits are read rather than `Stats.isDirectory()` and friends, because this
 * runs against a plain attributes object in the hermetic tests as well as
 * against the library's class.
 */
export function toFileType(mode: number): FileType {
  switch (mode & S_IFMT) {
    case S_IFDIR:
      return 'directory';
    case S_IFREG:
      return 'file';
    case S_IFLNK:
      return 'symlink';
    default:
      return 'unknown';
  }
}

/**
 * `mtime` is seconds in SFTP and millis in `FileStat`. `etag` is left unset:
 * SFTP has no version token, which is what `hasVersionTokens: false` declares.
 * `size` is passed through even for a directory, as `provider-webdav` does.
 */
export function toFileStat(attrs: SftpAttrs): FileStat {
  return {
    type: toFileType(attrs.mode),
    size: attrs.size,
    mtime: attrs.mtime * 1000,
    mode: attrs.mode,
    raw: { uid: attrs.uid, gid: attrs.gid },
  };
}

/**
 * Where this connection starts on the server.
 *
 * An empty prefix is the login directory, an absolute one is itself, and a
 * relative one sits below the login directory. The login directory comes from
 * `realpath('.')` at connect, which is the only way to learn it.
 */
export function resolveBase(rootPrefix: string, loginDirectory: string): string {
  if (rootPrefix.startsWith('/')) return normalise(rootPrefix);
  if (rootPrefix === '') return normalise(loginDirectory);
  return normalise(`${loginDirectory}/${rootPrefix}`);
}

/** `RemotePath` is already absolute and normalised, so this is concatenation. */
export function joinRemote(base: string, path: RemotePath): string {
  if (path.isRoot) return base;
  return base === '/' ? path.value : `${base}${path.value}`;
}

function normalise(value: string): string {
  const collapsed = trimTrailingSlashes(`/${value}`.replace(/\/+/g, '/'));
  return collapsed === '' ? '/' : collapsed;
}

/**
 * `ReadOptions` to an `ssh2` byte range, whose `end` is inclusive.
 *
 * `'empty'` means the caller asked for no bytes at all: `{ offset: 5, length: 0 }`
 * would otherwise become `start: 5, end: 4`, which reads as an inverted range.
 * The same shape, and the same reason, as `provider-webdav`'s `buildRange`.
 */
export function buildRange(
  options: ReadOptions | undefined,
): { start: number; end?: number } | 'empty' | undefined {
  if (options?.offset === undefined) return undefined;
  const start = options.offset;
  if (options.length === undefined) return { start };
  return options.length <= 0 ? 'empty' : { start, end: start + options.length - 1 };
}

/**
 * Gives a read stream's late failures the same translation the request-shaped
 * calls get. `createReadStream` returns before the request is answered, so a
 * missing file or a dropped connection arrives as an error on the stream rather
 * than as a rejection from the call that made it.
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
