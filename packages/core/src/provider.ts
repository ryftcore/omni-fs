import type { ProviderCapabilities } from './capabilities.js';
import type { ConnectionConfig, ConnectionSecret, ProviderId } from './model/connection.js';
import type { DirEntry, FileStat } from './model/stat.js';
import type { RemotePath } from './model/path.js';
import type { Logger } from './ports/logger.js';

/**
 * The contract every protocol implements, and the only thing the hosts know
 * about. `apps/vscode` and (later) `apps/desktop` are written against this
 * interface, never against `@omni-fs/provider-s3` and friends — which is why
 * the desktop app gets all four protocols for free.
 *
 * Design rules for implementers:
 *  - Throw `OmniFsError` and nothing else. Translate native errors at this line.
 *  - Accept an `AbortSignal` on anything that touches the network.
 *  - Never cache. Caching is core's job, above this interface, so it behaves
 *    identically for every protocol.
 *  - Declare honestly in `capabilities`. Do not emulate an operation you cannot
 *    do atomically without saying so.
 */
export interface RemoteFileSystem extends AsyncDisposable {
  readonly capabilities: ProviderCapabilities;

  /** Establishes the session. Must be idempotent. */
  connect(signal?: AbortSignal): Promise<void>;

  /** Cheap liveness check used to decide whether to reconnect before an op. */
  isAlive(): boolean;

  stat(path: RemotePath, signal?: AbortSignal): Promise<FileStat>;

  /**
   * Lists direct children. Async-iterable rather than array-returning so a
   * bucket with a million keys streams into the tree instead of blocking on a
   * full enumeration.
   */
  list(path: RemotePath, signal?: AbortSignal): AsyncIterable<DirEntry>;

  readFile(path: RemotePath, options?: ReadOptions): Promise<Uint8Array>;

  createReadStream(path: RemotePath, options?: ReadOptions): Promise<ReadableStream<Uint8Array>>;

  writeFile(path: RemotePath, data: Uint8Array, options?: WriteOptions): Promise<void>;

  /** Only when `capabilities.canStreamWrite`. */
  createWriteStream?(path: RemotePath, options?: WriteOptions): Promise<WritableStream<Uint8Array>>;

  delete(path: RemotePath, options?: DeleteOptions): Promise<void>;

  /** Only when `capabilities.canCreateDirectory`. */
  createDirectory?(path: RemotePath, signal?: AbortSignal): Promise<void>;

  /** Only when `capabilities.canRename`. Core emulates it otherwise. */
  rename?(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void>;

  /** Only when `capabilities.canCopyServerSide`. Core streams it otherwise. */
  copy?(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void>;

  /** Only when `capabilities.canWatch`. Core polls otherwise. */
  watch?(path: RemotePath, listener: WatchListener, options?: WatchOptions): Disposable;
}

export interface ReadOptions {
  readonly signal?: AbortSignal | undefined;
  /** Inclusive byte offset. Requires `capabilities.canReadRange`. */
  readonly offset?: number | undefined;
  /** Byte count from `offset`. Requires `capabilities.canReadRange`. */
  readonly length?: number | undefined;
  readonly onProgress?: ((transferred: number, total?: number) => void) | undefined;
}

export interface WriteOptions {
  readonly signal?: AbortSignal | undefined;
  /** Fail instead of replacing an existing file. Default `true` (overwrite). */
  readonly overwrite?: boolean | undefined;
  /** Create missing parent directories. Default `true`. */
  readonly createParents?: boolean | undefined;
  /**
   * Only write if the remote still matches this etag. Requires
   * `capabilities.hasVersionTokens`; raises `Conflict` on mismatch. This is how
   * "someone else saved over your edit" is caught rather than silently lost.
   */
  readonly ifMatch?: string | undefined;
  /** Total byte length when known. Lets providers pick multipart strategy. */
  readonly contentLength?: number | undefined;
  readonly contentType?: string | undefined;
  readonly onProgress?: ((transferred: number, total?: number) => void) | undefined;
}

export interface DeleteOptions {
  readonly signal?: AbortSignal | undefined;
  readonly recursive?: boolean | undefined;
}

export interface OverwriteOptions {
  readonly signal?: AbortSignal | undefined;
  readonly overwrite?: boolean | undefined;
}

export interface WatchOptions {
  readonly recursive?: boolean | undefined;
  readonly excludes?: readonly string[] | undefined;
}

export type FileChangeType = 'created' | 'changed' | 'deleted';

export interface FileChangeEvent {
  readonly type: FileChangeType;
  readonly path: RemotePath;
}

export type WatchListener = (events: readonly FileChangeEvent[]) => void;

/**
 * What a provider package exports. Registering a definition is the *only* way
 * core learns a protocol exists — there is no switch statement on provider id
 * anywhere in core, so a fifth protocol is a new package and one registration
 * call, with no edits to existing code.
 */
export interface ProviderDefinition {
  readonly id: ProviderId;
  /** Shown in the "new connection" picker. */
  readonly displayName: string;
  /** URI scheme(s) this provider claims, e.g. `['s3']`. */
  readonly schemes: readonly string[];
  /** Declarative form description; hosts render it natively. */
  readonly settingsSchema: SettingsSchema;
  /** Which secret fields this provider expects, for the credential prompt. */
  readonly secretSchema: SettingsSchema;
  /** Capabilities before a connection exists, for UI that runs pre-connect. */
  readonly defaultCapabilities: ProviderCapabilities;

  create(context: ProviderContext): RemoteFileSystem;
}

export interface ProviderContext {
  readonly config: ConnectionConfig;
  /** Resolved lazily so credentials are fetched at connect time, not at list time. */
  readonly getSecret: (signal?: AbortSignal) => Promise<ConnectionSecret>;
  readonly logger: Logger;
}

/**
 * A tiny declarative form schema. Deliberately not JSON Schema: hosts must
 * render this as a native VS Code webview form today and a React form in the
 * desktop app tomorrow, and a small closed vocabulary is far easier to render
 * twice than a general-purpose one.
 */
export interface SettingsSchema {
  readonly fields: readonly SettingsField[];
}

export type SettingsField =
  | {
      kind: 'text';
      key: string;
      label: string;
      required?: boolean;
      placeholder?: string;
      help?: string;
    }
  | { kind: 'password'; key: string; label: string; required?: boolean; help?: string }
  | {
      kind: 'number';
      key: string;
      label: string;
      required?: boolean;
      default?: number;
      min?: number;
      max?: number;
    }
  | { kind: 'boolean'; key: string; label: string; default?: boolean; help?: string }
  | {
      kind: 'select';
      key: string;
      label: string;
      required?: boolean;
      options: readonly { value: string; label: string }[];
      default?: string;
    }
  | { kind: 'file'; key: string; label: string; required?: boolean; help?: string };
