import * as vscode from 'vscode';
import { OmniFsError, RemotePath } from '@omni-fs/core';
import type {
  ConfigStore,
  ConnectionManager,
  DirEntry,
  EntryCache,
  Logger,
  RemoteFileSystem,
} from '@omni-fs/core';
import { ManagedFileSystem } from '@omni-fs/core';

export const OMNI_FS_SCHEME = 'omnifs';

/**
 * Maps `omnifs://<connectionId><path>` onto the core filesystem.
 *
 * Registering this is what makes remote files first-class: they open in normal
 * editors, Ctrl+S uploads, the Explorer shows them, and a connection can be
 * added to the workspace as a folder. The alternative — a bespoke tree with
 * download-edit-reupload — is what most FTP extensions do and it is why they
 * feel like a separate application bolted on the side.
 *
 * This class deliberately contains no protocol logic. It is a translator:
 * `vscode.Uri` to `RemotePath`, `OmniFsError` to `vscode.FileSystemError`,
 * core's `DirEntry` to a VS Code tuple. Every behaviour worth testing lives
 * underneath it in `packages/core`.
 */
export class OmniFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  readonly #manager: ConnectionManager;
  readonly #configStore: ConfigStore;
  readonly #cache: EntryCache;
  readonly #logger: Logger;
  readonly #wrapped = new WeakMap<RemoteFileSystem, ManagedFileSystem>();
  readonly #emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

  readonly onDidChangeFile = this.#emitter.event;

  constructor(options: {
    manager: ConnectionManager;
    configStore: ConfigStore;
    cache: EntryCache;
    logger: Logger;
  }) {
    this.#manager = options.manager;
    this.#configStore = options.configStore;
    this.#cache = options.cache;
    this.#logger = options.logger;
  }

  /**
   * VS Code has no server-side change notifications to offer here, and polling
   * a metered bucket in the background is a real cost the user did not ask for.
   * Refresh is explicit instead.
   */
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { fs, path } = await this.#resolve(uri);
    return translate(async () => {
      const stat = await fs.stat(path);
      return {
        type: toFileType(stat.type),
        size: stat.size,
        ctime: stat.ctime ?? 0,
        mtime: stat.mtime ?? 0,
        ...(stat.readOnly === true ? { permissions: vscode.FilePermission.Readonly } : {}),
      };
    }, uri);
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { fs, path } = await this.#resolve(uri);
    return translate(async () => {
      const entries: [string, vscode.FileType][] = [];
      for await (const entry of fs.list(path)) {
        entries.push([entry.name, toFileType(entry.type)]);
      }
      return entries;
    }, uri);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const { fs, path } = await this.#resolve(uri);
    await translate(() => fs.createDirectory(path), uri);
    this.#fire(vscode.FileChangeType.Created, uri);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { fs, path } = await this.#resolve(uri);
    return translate(() => fs.readFile(path), uri);
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const { fs, path } = await this.#resolve(uri);

    // VS Code asks us to fail when the file is missing and `create` is false.
    // Core has no equivalent flag, so the check belongs here.
    if (!options.create) {
      await translate(() => fs.stat(path), uri);
    }

    await translate(() => fs.writeFile(path, content, { overwrite: options.overwrite }), uri);
    this.#fire(options.create ? vscode.FileChangeType.Created : vscode.FileChangeType.Changed, uri);
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const { fs, path } = await this.#resolve(uri);
    await translate(() => fs.delete(path, { recursive: options.recursive }), uri);
    this.#fire(vscode.FileChangeType.Deleted, uri);
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { overwrite: boolean },
  ): Promise<void> {
    const source = await this.#resolve(oldUri);
    const target = parseUri(newUri);

    if (source.connectionId !== target.connectionId) {
      // Cross-connection moves are a copy-then-delete across two providers.
      // Worth doing, but it belongs in the transfer queue with progress and
      // cancellation rather than blocking an editor rename. Until that is
      // wired, refuse clearly rather than half-doing it.
      throw vscode.FileSystemError.NoPermissions(
        'Moving between connections is not supported yet. Use Download and Upload.',
      );
    }

    await translate(
      () => source.fs.rename(source.path, target.path, { overwrite: options.overwrite }),
      oldUri,
    );
    this.#fire(vscode.FileChangeType.Deleted, oldUri);
    this.#fire(vscode.FileChangeType.Created, newUri);
  }

  async copy(
    sourceUri: vscode.Uri,
    targetUri: vscode.Uri,
    options: { overwrite: boolean },
  ): Promise<void> {
    const source = await this.#resolve(sourceUri);
    const target = parseUri(targetUri);

    if (source.connectionId !== target.connectionId) {
      throw vscode.FileSystemError.NoPermissions(
        'Copying between connections is not supported yet. Use Download and Upload.',
      );
    }

    await translate(
      () => source.fs.copy(source.path, target.path, { overwrite: options.overwrite }),
      sourceUri,
    );
    this.#fire(vscode.FileChangeType.Created, targetUri);
  }

  /** Builds the URI for a remote path, for commands that need to open a file. */
  static toUri(connectionId: string, path: RemotePath): vscode.Uri {
    return vscode.Uri.from({ scheme: OMNI_FS_SCHEME, authority: connectionId, path: path.value });
  }

  async #resolve(
    uri: vscode.Uri,
  ): Promise<{ fs: ManagedFileSystem; path: RemotePath; connectionId: string }> {
    const { connectionId, path } = parseUri(uri);
    const raw = await this.#manager.acquire(connectionId).catch((error: unknown) => {
      throw toVsCodeError(error, uri);
    });

    // One ManagedFileSystem per live provider instance, so the cache and the
    // emulation state survive across calls but are dropped when the underlying
    // connection is replaced.
    let managed = this.#wrapped.get(raw);
    if (managed === undefined) {
      // The connection's own read-only flag. `#resolve` has only the id, so
      // this is the one place the config can be reached — and without it the
      // lock shown in the tree does nothing: ManagedFileSystem implements
      // read-only properly and was simply never told.
      //
      // Read when the wrapper is built, which is memoised per live provider
      // instance, so a change to the flag takes effect on the next connect.
      // That is how every other connection setting already behaves.
      const config = await this.#configStore.get(connectionId);
      managed = new ManagedFileSystem({
        connectionId,
        inner: raw,
        cache: this.#cache,
        logger: this.#logger.child(connectionId),
        readOnly: config?.readOnly ?? false,
      });
      this.#wrapped.set(raw, managed);
    }

    return { fs: managed, path, connectionId };
  }

  #fire(type: vscode.FileChangeType, uri: vscode.Uri): void {
    this.#emitter.fire([{ type, uri }]);
  }

  dispose(): void {
    this.#emitter.dispose();
  }
}

function parseUri(uri: vscode.Uri): { connectionId: string; path: RemotePath } {
  if (uri.authority === '') {
    throw vscode.FileSystemError.FileNotFound(
      `Malformed omnifs URI (no connection): ${uri.toString()}`,
    );
  }
  return { connectionId: uri.authority, path: RemotePath.parse(uri.path) };
}

function toFileType(type: DirEntry['type']): vscode.FileType {
  switch (type) {
    case 'file':
      return vscode.FileType.File;
    case 'directory':
      return vscode.FileType.Directory;
    case 'symlink':
      return vscode.FileType.SymbolicLink;
    default:
      return vscode.FileType.Unknown;
  }
}

/** Runs a core call and rethrows its failure in VS Code's vocabulary. */
async function translate<T>(body: () => Promise<T>, uri: vscode.Uri): Promise<T> {
  try {
    return await body();
  } catch (error) {
    throw toVsCodeError(error, uri);
  }
}

/**
 * The inverse of each provider's error mapping. VS Code behaves very
 * differently per error kind — `FileNotFound` triggers a create-on-save flow,
 * `NoPermissions` shows a read-only editor — so getting this mapping right is
 * the difference between a remote file feeling native and feeling broken.
 */
function toVsCodeError(error: unknown, uri: vscode.Uri): Error {
  if (!OmniFsError.is(error)) return error instanceof Error ? error : new Error(String(error));

  switch (error.code) {
    case 'NotFound':
      return vscode.FileSystemError.FileNotFound(uri);
    case 'AlreadyExists':
      return vscode.FileSystemError.FileExists(uri);
    case 'NotADirectory':
      return vscode.FileSystemError.FileNotADirectory(uri);
    case 'IsADirectory':
      return vscode.FileSystemError.FileIsADirectory(uri);
    case 'PermissionDenied':
    case 'AuthenticationFailed':
      return vscode.FileSystemError.NoPermissions(`${error.message} (${uri.toString()})`);
    case 'Unsupported':
      return vscode.FileSystemError.NoPermissions(error.message);
    default:
      return vscode.FileSystemError.Unavailable(`${error.code}: ${error.message}`);
  }
}
