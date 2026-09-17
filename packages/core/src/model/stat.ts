import type { RemotePath } from './path.js';

export type FileType = 'file' | 'directory' | 'symlink' | 'unknown';

/**
 * What every provider can say about an entry. Deliberately small: anything a
 * single protocol knows and the others do not goes in `raw`, not in a new
 * optional field on this type.
 */
export interface FileStat {
  readonly type: FileType;
  /** Size in bytes. `0` for directories, which several protocols cannot size. */
  readonly size: number;
  /** Last modified, epoch millis. `undefined` when the protocol omits it. */
  readonly mtime?: number | undefined;
  /** Creation time, epoch millis. Rare outside of object stores. */
  readonly ctime?: number | undefined;
  /** POSIX mode bits, when the protocol carries them (SFTP, some FTP servers). */
  readonly mode?: number | undefined;
  /** Opaque version/ETag token. Used for conflict detection on write. */
  readonly etag?: string | undefined;
  /** True when the entry is known to be read-only for the current credentials. */
  readonly readOnly?: boolean | undefined;
  /**
   * Protocol-specific extras (S3 storage class, SFTP uid/gid, WebDAV props).
   * Consumers must treat this as untyped and optional — it is for display and
   * provider-internal round-tripping only, never for control flow in core.
   */
  readonly raw?: Readonly<Record<string, unknown>> | undefined;
}

/** A `FileStat` plus its location. What `list()` yields. */
export interface DirEntry extends FileStat {
  readonly name: string;
  readonly path: RemotePath;
}

export function isDirectory(stat: FileStat): boolean {
  return stat.type === 'directory';
}

export function isFile(stat: FileStat): boolean {
  return stat.type === 'file';
}
