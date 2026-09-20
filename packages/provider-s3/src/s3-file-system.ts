import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  type ServerSideEncryption,
  type StorageClass,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { OmniFsError, collectStream, streamFrom } from '@omni-fs/core';
import type {
  DeleteOptions,
  DirEntry,
  FileStat,
  Logger,
  OverwriteOptions,
  ProviderCapabilities,
  ProviderContext,
  ReadOptions,
  RemoteFileSystem,
  WriteOptions,
  RemotePath,
} from '@omni-fs/core';
import { toOmniFsError } from './errors.js';
import { buildRange, copySource, keyFor, prefixFor, trimSlashes } from './s3-helpers.js';
import { readSettings, type S3Settings } from './settings.js';
import { openUploadStream, writeConditions } from './upload-stream.js';

/**
 * S3 and anything that speaks its API: MinIO, Cloudflare R2, Backblaze B2,
 * DigitalOcean Spaces, Ceph.
 *
 * The interesting part of this provider is that **S3 has no directories**. A
 * "folder" is only a set of keys sharing a prefix, so:
 *
 *  - `list()` uses `Delimiter: '/'` and reports `CommonPrefixes` as directories.
 *  - `stat()` on a path that is not an object falls back to a one-key list to
 *    decide whether it is a prefix that exists.
 *  - There is no `createDirectory` and no `rename`; `ManagedFileSystem`
 *    emulates rename as server-side copy + delete.
 *
 * Declaring `hasRealDirectories: false` is what tells the rest of the system to
 * expect all of that, rather than every caller special-casing S3.
 */
/**
 * Construction options. The only member is a test seam.
 *
 * `connect()` builds its own `S3Client` from the connection's settings and
 * credentials, which is what production wants and what leaves the class
 * unreachable from a test — every branch below would need a bucket. Injecting
 * the construction is the narrowest way to open it. Nothing in the product
 * passes this; `provider-webdav` opens the same kind of seam with its
 * `PutClient` and `WriteStreamClient` types.
 */
export interface S3FileSystemOptions {
  readonly createClient?: ((config: S3ClientConfig) => S3Client) | undefined;
}

export class S3FileSystem implements RemoteFileSystem {
  readonly capabilities: ProviderCapabilities = {
    canWrite: true,
    canRename: false,
    canCopyServerSide: true,
    canCreateDirectory: false,
    canDeleteRecursive: true,
    canAppend: false,
    canReadRange: true,
    canStreamWrite: true,
    canWatch: false,
    hasRealDirectories: false,
    preservesMTime: false,
    hasVersionTokens: true,
    maxConcurrency: 16,
    listIsPaginated: true,
  };

  readonly #context: ProviderContext;
  readonly #settings: S3Settings;
  readonly #logger: Logger;
  readonly #createClient: (config: S3ClientConfig) => S3Client;
  #client: S3Client | undefined;

  constructor(context: ProviderContext, options: S3FileSystemOptions = {}) {
    this.#context = context;
    this.#settings = readSettings(context.config.settings);
    this.#logger = context.logger;
    this.#createClient = options.createClient ?? ((config) => new S3Client(config));
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#client !== undefined) return;

    const secret = await this.#context.getSecret(signal);
    const accessKeyId = requireString(secret, 'accessKeyId');
    const secretAccessKey = requireString(secret, 'secretAccessKey');
    const sessionToken = optionalString(secret, 'sessionToken');

    this.#client = this.#createClient({
      region: this.#settings.region,
      ...(this.#settings.endpoint !== undefined ? { endpoint: this.#settings.endpoint } : {}),
      forcePathStyle: this.#settings.forcePathStyle,
      credentials: {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken !== undefined ? { sessionToken } : {}),
      },
    });

    this.#logger.log('info', 'S3 client created', {
      bucket: this.#settings.bucket,
      endpoint: this.#settings.endpoint ?? 'aws',
      region: this.#settings.region,
    });
  }

  isAlive(): boolean {
    return this.#client !== undefined;
  }

  async stat(path: RemotePath, signal?: AbortSignal): Promise<FileStat> {
    if (path.isRoot) return DIRECTORY_STAT;

    const key = this.#key(path);

    try {
      const head = await this.#run(
        (client) =>
          client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }), opts(signal)),
        path.value,
      );
      return {
        type: 'file',
        size: head.ContentLength ?? 0,
        mtime: head.LastModified?.getTime(),
        etag: head.ETag,
        raw: { storageClass: head.StorageClass, contentType: head.ContentType },
      };
    } catch (error) {
      const translated = toOmniFsError(error, path.value);
      if (translated.code !== 'NotFound') throw translated;
    }

    // Not an object. It may still be a prefix with children, i.e. a folder.
    // A single key is enough to answer that.
    const probe = await this.#run(
      (client) =>
        client.send(
          new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: `${key}/`, MaxKeys: 1 }),
          opts(signal),
        ),
      path.value,
    );

    if ((probe.KeyCount ?? 0) > 0) return DIRECTORY_STAT;
    throw OmniFsError.notFound(path.value);
  }

  async *list(path: RemotePath, signal?: AbortSignal): AsyncIterable<DirEntry> {
    const prefix = this.#prefix(path);
    let continuationToken: string | undefined;

    do {
      const token = continuationToken;
      const page = await this.#run(
        (client) =>
          client.send(
            new ListObjectsV2Command({
              Bucket: this.#bucket,
              Prefix: prefix,
              Delimiter: '/',
              ...(token !== undefined ? { ContinuationToken: token } : {}),
            }),
            opts(signal),
          ),
        path.value,
      );

      // CommonPrefixes are the "subdirectories" at this level.
      for (const common of page.CommonPrefixes ?? []) {
        if (common.Prefix === undefined) continue;
        const name = trimSlashes(common.Prefix.slice(prefix.length));
        if (name === '') continue;
        yield { ...DIRECTORY_STAT, name, path: path.join(name) };
      }

      for (const object of page.Contents ?? []) {
        if (object.Key === undefined) continue;
        const name = object.Key.slice(prefix.length);
        // A key equal to the prefix, or ending in a slash, is a directory
        // placeholder some tools create. It is this folder, not a child of it.
        if (name === '' || name.endsWith('/')) continue;
        yield {
          type: 'file',
          size: object.Size ?? 0,
          mtime: object.LastModified?.getTime(),
          etag: object.ETag,
          name,
          path: path.join(name),
          raw: { storageClass: object.StorageClass },
        };
      }

      continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
  }

  async readFile(path: RemotePath, options?: ReadOptions): Promise<Uint8Array> {
    const stream = await this.createReadStream(path, options);
    return collectStream(stream);
  }

  async createReadStream(
    path: RemotePath,
    options?: ReadOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    const range = buildRange(options);

    // A read of zero bytes has no Range spelling, so it is answered here rather
    // than sent as the inverted `bytes=5--1` the arithmetic alone produces —
    // which S3 answers with 416, or ignores, returning the whole object to a
    // caller that wanted nothing. The `stat` is not a formality: without it a
    // zero-length read of a missing path, or one through an already-aborted
    // signal, would succeed emptily, where `MemoryFileSystem` — the contract's
    // reference — raises `NotFound` and `Cancelled` first. It settles only
    // those two: the `type` it also returns is not inspected, so a zero-length
    // read of a prefix still answers with no bytes where the reference raises
    // `IsADirectory`. `provider-webdav` carries the same gap, recorded there
    // and not closed here.
    if (range === 'empty') {
      await this.stat(path, options?.signal);
      return streamFrom(new Uint8Array(0));
    }

    const response = await this.#run(
      (client) =>
        client.send(
          new GetObjectCommand({
            Bucket: this.#bucket,
            Key: this.#key(path),
            ...(range !== undefined ? { Range: range.header } : {}),
          }),
          opts(options?.signal),
        ),
      path.value,
    );

    const body = response.Body;
    if (body === undefined) throw OmniFsError.notFound(path.value);

    // The SDK hands back a web ReadableStream on Node 18+, which is exactly
    // what the core contract asks for.
    return body.transformToWebStream() as ReadableStream<Uint8Array>;
  }

  async writeFile(path: RemotePath, data: Uint8Array, options?: WriteOptions): Promise<void> {
    if (options?.overwrite === false && (await this.#exists(path, options.signal))) {
      throw OmniFsError.alreadyExists(path.value);
    }

    await this.#run(
      (client) =>
        client.send(
          new PutObjectCommand({
            Bucket: this.#bucket,
            Key: this.#key(path),
            Body: data,
            ContentLength: data.byteLength,
            ...(options?.contentType !== undefined ? { ContentType: options.contentType } : {}),
            ...(options?.ifMatch !== undefined ? { IfMatch: options.ifMatch } : {}),
            ...this.#storageOptions(),
          }),
          opts(options?.signal),
        ),
      path.value,
    );

    options?.onProgress?.(data.byteLength, data.byteLength);
  }

  /**
   * Multipart upload via `lib-storage`, so a large file neither buffers in
   * memory nor needs its length known in advance.
   */
  async createWriteStream(
    path: RemotePath,
    options?: WriteOptions,
  ): Promise<WritableStream<Uint8Array>> {
    const client = this.#requireClient();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();

    const upload = new Upload({
      client,
      params: {
        Bucket: this.#bucket,
        Key: this.#key(path),
        // lib-storage wants a Node stream or a buffer, not a web stream.
        Body: Readable.fromWeb(readable),
        ...(options?.contentType !== undefined ? { ContentType: options.contentType } : {}),
        ...writeConditions(options),
        ...this.#storageOptions(),
      },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
    });

    if (options?.onProgress !== undefined) {
      upload.on('httpUploadProgress', (progress) => {
        options.onProgress?.(progress.loaded ?? 0, progress.total);
      });
    }

    options?.signal?.addEventListener('abort', () => void upload.abort(), { once: true });

    return openUploadStream(upload, writable, path.value, options?.overwrite === false);
  }

  async delete(path: RemotePath, options?: DeleteOptions): Promise<void> {
    if (options?.recursive !== true) {
      await this.#run(
        (client) =>
          client.send(
            new DeleteObjectCommand({ Bucket: this.#bucket, Key: this.#key(path) }),
            opts(options?.signal),
          ),
        path.value,
      );
      return;
    }

    // Recursive: enumerate the whole prefix and delete in batches of 1000,
    // which is the DeleteObjects limit.
    const prefix = this.#prefix(path);
    let continuationToken: string | undefined;

    do {
      const token = continuationToken;
      const page = await this.#run(
        (client) =>
          client.send(
            new ListObjectsV2Command({
              Bucket: this.#bucket,
              Prefix: prefix,
              ...(token !== undefined ? { ContinuationToken: token } : {}),
            }),
            opts(options?.signal),
          ),
        path.value,
      );

      const keys = (page.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => key !== undefined);

      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        await this.#run(
          (client) =>
            client.send(
              new DeleteObjectsCommand({
                Bucket: this.#bucket,
                Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
              }),
              opts(options?.signal),
            ),
          path.value,
        );
      }

      continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);

    // The path may also exist as a plain object, not only as a prefix. Its
    // absence is not an error here — the recursive delete already succeeded.
    try {
      await this.#run((client) =>
        client.send(
          new DeleteObjectCommand({ Bucket: this.#bucket, Key: this.#key(path) }),
          opts(options?.signal),
        ),
      );
    } catch {
      // ignored on purpose
    }
  }

  async copy(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    if (options?.overwrite === false && (await this.#exists(to, options.signal))) {
      throw OmniFsError.alreadyExists(to.value);
    }

    await this.#run(
      (client) =>
        client.send(
          new CopyObjectCommand({
            Bucket: this.#bucket,
            Key: this.#key(to),
            CopySource: copySource(this.#bucket, this.#key(from)),
            ...this.#storageOptions(),
          }),
          opts(options?.signal),
        ),
      from.value,
    );
  }

  async #exists(path: RemotePath, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.stat(path, signal);
      return true;
    } catch (error) {
      if (OmniFsError.is(error) && error.code === 'NotFound') return false;
      throw error;
    }
  }

  get #bucket(): string {
    return this.#settings.bucket;
  }

  #storageOptions(): { StorageClass?: StorageClass; ServerSideEncryption?: ServerSideEncryption } {
    return {
      ...(this.#settings.storageClass !== undefined
        ? { StorageClass: this.#settings.storageClass as StorageClass }
        : {}),
      ...(this.#settings.serverSideEncryption !== undefined
        ? { ServerSideEncryption: this.#settings.serverSideEncryption as ServerSideEncryption }
        : {}),
    };
  }

  /** Applies the connection's root prefix, so a connection can be scoped to a subfolder. */
  #key(path: RemotePath): string {
    return keyFor(this.#settings, path);
  }

  #prefix(path: RemotePath): string {
    return prefixFor(this.#settings, path);
  }

  #requireClient(): S3Client {
    if (this.#client === undefined) {
      throw new OmniFsError({
        code: 'ConnectionFailed',
        message: 'S3 client is not connected. Call connect() first.',
        providerId: 's3',
      });
    }
    return this.#client;
  }

  /**
   * Runs one SDK call and translates any failure. Takes a callback rather than a
   * command so the SDK's own overloads infer the response type — a wrapper that
   * accepted a widened `Command` would erase it and force casts at every call.
   */
  async #run<T>(body: (client: S3Client) => Promise<T>, path?: string): Promise<T> {
    try {
      return await body(this.#requireClient());
    } catch (error) {
      throw toOmniFsError(error, path);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#client?.destroy();
    this.#client = undefined;
  }
}

const DIRECTORY_STAT: FileStat = { type: 'directory', size: 0 };

function opts(signal: AbortSignal | undefined): { abortSignal?: AbortSignal } {
  return signal !== undefined ? { abortSignal: signal } : {};
}

function requireString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new OmniFsError({
      code: 'AuthenticationFailed',
      message: `Missing credential field: ${key}`,
      providerId: 's3',
    });
  }
  return value;
}

function optionalString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
