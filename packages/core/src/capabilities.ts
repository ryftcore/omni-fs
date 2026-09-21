/**
 * Protocols differ more than a single interface can hide, and pretending
 * otherwise is how universal file clients get bad.
 *
 * S3 has no directories, no rename, and no append. FTP has no server-side copy.
 * WebDAV has no partial write. Rather than have callers `try` an operation and
 * interpret the failure, every provider declares up front what it can do, and
 * the UI adapts: greyed-out menu items instead of errors after the fact.
 */
export interface ProviderCapabilities {
  /** Any mutation at all. False for a read-only credential or archive. */
  readonly canWrite: boolean;
  /** Native rename/move. S3 must emulate it as copy+delete. */
  readonly canRename: boolean;
  /** Server-side copy without streaming bytes through the client. */
  readonly canCopyServerSide: boolean;
  /** Explicit directory creation. Meaningless on pure object stores. */
  readonly canCreateDirectory: boolean;
  /**
   * Whether the provider handles `recursive: true` on `delete` itself, rather
   * than leaving `ManagedFileSystem` to walk the tree and delete leaf by leaf.
   *
   * It is not a promise of one server call, and never was: `provider-s3`
   * enumerates the prefix and deletes in batches, and `provider-sftp` walks with
   * `readdir` and `unlink`, because neither protocol has a recursive remove. What
   * true promises is that asking this provider to delete a tree works — which is
   * the only thing its one reader asks (`fs/managed-file-system.ts`).
   */
  readonly canDeleteRecursive: boolean;
  /** Appending to an existing file. FTP `APPE`, SFTP open-append. */
  readonly canAppend: boolean;
  /** Byte-range reads, needed for resumable download and large-file preview. */
  readonly canReadRange: boolean;
  /** Streaming write without knowing the total length in advance. */
  readonly canStreamWrite: boolean;
  /** Server-side change notification. Almost never true; polling is the fallback. */
  readonly canWatch: boolean;
  /**
   * Whether directories exist as real entities. `false` on S3, where a
   * "directory" is only a shared key prefix and vanishes when it empties.
   * Drives whether the UI offers "New Folder" and whether empty dirs persist.
   */
  readonly hasRealDirectories: boolean;
  /** Whether a written file keeps a client-supplied mtime. */
  readonly preservesMTime: boolean;
  /** Whether stat/list return an etag usable for conflict detection. */
  readonly hasVersionTokens: boolean;
  /**
   * Safe number of in-flight operations this connection can carry. S3 is happy
   * with 16+ over one HTTPS client.
   *
   * FTP carries one command per control connection, so `provider-ftp` answers
   * with the size of its channel pool — a per-connection setting, which also
   * falls when a server refuses another login. That makes this the first
   * capability whose value is neither a constant nor a property of the server,
   * and it is safe because `TransferQueue` reads it at call time rather than
   * caching it at connect.
   */
  readonly maxConcurrency: number;
  /** Whether `list()` is naturally paginated and may be expensive. */
  readonly listIsPaginated: boolean;
}

/**
 * The floor. Spread this and override, so adding a new capability to the
 * interface does not break every existing provider — it just defaults to "no".
 */
export const MINIMAL_CAPABILITIES: ProviderCapabilities = {
  canWrite: false,
  canRename: false,
  canCopyServerSide: false,
  canCreateDirectory: false,
  canDeleteRecursive: false,
  canAppend: false,
  canReadRange: false,
  canStreamWrite: false,
  canWatch: false,
  hasRealDirectories: true,
  preservesMTime: false,
  hasVersionTokens: false,
  maxConcurrency: 1,
  listIsPaginated: false,
};
