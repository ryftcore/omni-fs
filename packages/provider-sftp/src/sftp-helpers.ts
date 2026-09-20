import type { FileStat, FileType, RemotePath } from '@omni-fs/core';
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
  const collapsed = `/${value}`.replace(/\/+/g, '/').replace(/\/+$/, '');
  return collapsed === '' ? '/' : collapsed;
}
