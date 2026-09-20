import { OmniFsError, RemotePath } from '@omni-fs/core';
import type {
  DeleteOptions,
  DirEntry,
  FileStat,
  OverwriteOptions,
  ProviderCapabilities,
  ProviderDefinition,
  ReadOptions,
  RemoteFileSystem,
  WriteOptions,
} from '@omni-fs/core';

export interface MemoryFileSystemOptions {
  /** Override any capability to simulate a weaker protocol. */
  readonly capabilities?: Partial<ProviderCapabilities>;
  /** Artificial latency per operation, to exercise concurrency limits. */
  readonly latencyMs?: number;
}

/**
 * A complete, in-memory `RemoteFileSystem`.
 *
 * Two jobs. It lets core and both hosts be tested without a network — the
 * VS Code extension can run its whole tree, save and transfer flow against
 * this. And by overriding capabilities it impersonates any protocol, so the
 * `ManagedFileSystem` emulation paths (rename-as-copy+delete, recursive delete
 * by walk, prefix-only directories) get tested directly rather than only
 * incidentally against a real S3 bucket.
 */
export class MemoryFileSystem implements RemoteFileSystem {
  readonly capabilities: ProviderCapabilities;

  readonly #files = new Map<string, Uint8Array>();
  readonly #directories = new Set<string>(['/']);
  readonly #mtimes = new Map<string, number>();
  readonly #etags = new Map<string, string>();
  readonly #latencyMs: number;
  #revision = 0;
  #connected = false;

  constructor(options: MemoryFileSystemOptions = {}) {
    this.capabilities = {
      canWrite: true,
      canRename: true,
      canCopyServerSide: true,
      canCreateDirectory: true,
      canDeleteRecursive: true,
      canAppend: true,
      canReadRange: true,
      canStreamWrite: true,
      canWatch: false,
      hasRealDirectories: true,
      preservesMTime: true,
      hasVersionTokens: true,
      maxConcurrency: 8,
      listIsPaginated: false,
      ...options.capabilities,
    };
    this.#latencyMs = options.latencyMs ?? 0;
  }

  async connect(): Promise<void> {
    this.#connected = true;
  }

  isAlive(): boolean {
    return this.#connected;
  }

  async stat(path: RemotePath, signal?: AbortSignal): Promise<FileStat> {
    await this.#tick(signal, 'stat');

    if (this.#files.has(path.value)) {
      const data = this.#files.get(path.value)!;
      return {
        type: 'file',
        size: data.byteLength,
        mtime: this.#mtimes.get(path.value),
        etag: this.#etags.get(path.value),
      };
    }
    if (this.#isDirectory(path)) return { type: 'directory', size: 0 };
    throw OmniFsError.notFound(path.value);
  }

  async *list(path: RemotePath, signal?: AbortSignal): AsyncIterable<DirEntry> {
    await this.#tick(signal, 'list');
    if (!this.#isDirectory(path)) throw OmniFsError.notFound(path.value);

    const prefix = path.isRoot ? '/' : `${path.value}/`;
    const seen = new Set<string>();

    for (const candidate of [...this.#directories, ...this.#files.keys()]) {
      if (candidate === path.value || !candidate.startsWith(prefix)) continue;

      const name = candidate.slice(prefix.length).split('/')[0];
      if (name === undefined || name === '' || seen.has(name)) continue;
      seen.add(name);

      const childPath = path.join(name);
      const file = this.#files.get(childPath.value);
      yield file !== undefined
        ? {
            type: 'file',
            size: file.byteLength,
            mtime: this.#mtimes.get(childPath.value),
            etag: this.#etags.get(childPath.value),
            name,
            path: childPath,
          }
        : { type: 'directory', size: 0, name, path: childPath };
    }
  }

  async readFile(path: RemotePath, options?: ReadOptions): Promise<Uint8Array> {
    await this.#tick(options?.signal, 'readFile');

    const data = this.#files.get(path.value);
    if (data === undefined) {
      throw this.#isDirectory(path)
        ? new OmniFsError({ code: 'IsADirectory', message: `Is a directory: ${path.value}` })
        : OmniFsError.notFound(path.value);
    }

    if (options?.offset === undefined) return data;
    const start = options.offset;
    const end = options.length !== undefined ? start + options.length : data.byteLength;
    return data.slice(start, end);
  }

  async createReadStream(
    path: RemotePath,
    options?: ReadOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    const data = await this.readFile(path, options);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
  }

  async writeFile(path: RemotePath, data: Uint8Array, options?: WriteOptions): Promise<void> {
    await this.#tick(options?.signal, 'writeFile');
    if (!this.capabilities.canWrite) throw OmniFsError.unsupported('write', 'memory');
    if (options?.overwrite === false && this.#files.has(path.value)) {
      throw OmniFsError.alreadyExists(path.value);
    }

    // A token that no longer matches means someone else saved in between. An
    // absent file never matches: there is no version to have held.
    if (options?.ifMatch !== undefined && this.#etags.get(path.value) !== options.ifMatch) {
      throw new OmniFsError({
        code: 'Conflict',
        message: `The file changed on the server since it was read: ${path.value}`,
      });
    }

    // Parents are implied, matching how an object store behaves. A caller that
    // needs real mkdir semantics sets hasRealDirectories and calls it.
    let parent = path.parent;
    while (!parent.isRoot) {
      this.#directories.add(parent.value);
      parent = parent.parent;
    }

    this.#files.set(path.value, data);
    this.#mtimes.set(path.value, Date.now());
    this.#stamp(path.value);
    options?.onProgress?.(data.byteLength, data.byteLength);
  }

  async createWriteStream(
    path: RemotePath,
    options?: WriteOptions,
  ): Promise<WritableStream<Uint8Array>> {
    const chunks: Uint8Array[] = [];
    return new WritableStream<Uint8Array>({
      write: (chunk) => {
        chunks.push(chunk);
      },
      close: async () => {
        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }
        await this.writeFile(path, merged, options);
      },
    });
  }

  async delete(path: RemotePath, options?: DeleteOptions): Promise<void> {
    await this.#tick(options?.signal, 'delete');

    if (this.#files.delete(path.value)) {
      this.#mtimes.delete(path.value);
      this.#etags.delete(path.value);
      return;
    }

    if (!this.#isDirectory(path)) throw OmniFsError.notFound(path.value);

    const prefix = `${path.value}/`;
    const children = [...this.#files.keys(), ...this.#directories].filter((key) =>
      key.startsWith(prefix),
    );

    if (children.length > 0 && options?.recursive !== true) {
      throw new OmniFsError({ code: 'NotEmpty', message: `Directory not empty: ${path.value}` });
    }

    for (const key of children) {
      this.#files.delete(key);
      this.#mtimes.delete(key);
      this.#etags.delete(key);
      this.#directories.delete(key);
    }
    this.#directories.delete(path.value);
  }

  async createDirectory(path: RemotePath, signal?: AbortSignal): Promise<void> {
    await this.#tick(signal, 'createDirectory');
    if (this.#files.has(path.value)) throw OmniFsError.alreadyExists(path.value);
    this.#directories.add(path.value);
  }

  async rename(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    await this.copy(from, to, options);
    await this.delete(from, { recursive: true });
  }

  async copy(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    await this.#tick(options?.signal, 'copy');
    if (options?.overwrite === false && this.#files.has(to.value)) {
      throw OmniFsError.alreadyExists(to.value);
    }

    const data = this.#files.get(from.value);
    if (data !== undefined) {
      await this.writeFile(to, data);
      return;
    }

    if (!this.#isDirectory(from)) throw OmniFsError.notFound(from.value);

    this.#directories.add(to.value);
    const prefix = `${from.value}/`;
    for (const [key, value] of [...this.#files]) {
      if (!key.startsWith(prefix)) continue;
      await this.writeFile(RemotePath.parse(`${to.value}/${key.slice(prefix.length)}`), value);
    }
  }

  /** Test helper: seed content without going through the write path. */
  seed(files: Readonly<Record<string, string>>): void {
    for (const [path, content] of Object.entries(files)) {
      const remote = RemotePath.parse(path);
      this.#files.set(remote.value, new TextEncoder().encode(content));
      this.#mtimes.set(remote.value, Date.now());
      this.#stamp(remote.value);
      let parent = remote.parent;
      while (!parent.isRoot) {
        this.#directories.add(parent.value);
        parent = parent.parent;
      }
    }
  }

  /**
   * A fresh opaque version token. Monotonic across the whole filesystem rather
   * than per path, so a token stale at one path can never come back around.
   */
  #stamp(path: string): void {
    this.#revision += 1;
    this.#etags.set(path, `"${this.#revision}"`);
  }

  #isDirectory(path: RemotePath): boolean {
    if (path.isRoot || this.#directories.has(path.value)) return true;
    // On a prefix-only filesystem a directory exists iff something lives under it.
    const prefix = `${path.value}/`;
    for (const key of this.#files.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  async #tick(signal: AbortSignal | undefined, operation: string): Promise<void> {
    if (signal?.aborted) throw OmniFsError.cancelled(operation);
    if (this.#latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#latencyMs));
      if (signal?.aborted) throw OmniFsError.cancelled(operation);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#connected = false;
  }
}

/** Registerable definition, so hosts can be exercised end to end offline. */
export const memoryProvider: ProviderDefinition = {
  id: 'memory',
  displayName: 'In-memory (testing)',
  schemes: ['memory'],
  settingsSchema: { fields: [] },
  secretSchema: { fields: [] },
  defaultCapabilities: new MemoryFileSystem().capabilities,
  create: () => new MemoryFileSystem(),
};
